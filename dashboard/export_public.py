"""Export small, aggregated JSON files from the dbt marts for the public dashboard.

The public site (site/, served by GitHub Pages) can't query Snowflake - and shouldn't: that
would mean shipping credentials to every visitor's browser. Instead the daily workflow runs
this right after `dbt build`, writes a few aggregated files, and publishes them with the site.

What leaves Snowflake is aggregated or already public:
- complaint counts by day and borough, and median time to close
- complaint locations rounded to a ~400 m grid (never an individual complaint)
- building-level (tax lot) energy scores and complaint counts - LL84 and 311 are both
  public datasets published at this level by the city

Usage (from the repo root, with the same env vars dbt uses):
    python dashboard/export_public.py --out site/data
"""
import argparse
import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import snowflake.connector
from cryptography.hazmat.primitives import serialization

DB = "HEATWATCH"

# Borough from the BBL's first digit - the city's own code, more reliable than the 311 field.
BORO = """
    case left({bbl}, 1)
        when '1' then 'Manhattan' when '2' then 'Bronx' when '3' then 'Brooklyn'
        when '4' then 'Queens'    when '5' then 'Staten Island'
        else coalesce(initcap(nullif(nullif({fallback}, 'Unspecified'), '')), 'Unknown')
    end"""

GRID = 0.004  # degrees, about 400 m: coarse enough that no cell points at one building's tenant


def connect():
    key_path = os.environ.get(
        "SNOWFLAKE_PRIVATE_KEY_PATH", str(Path.home() / ".snowflake" / "rsa_key.p8"))
    # same key-pair auth as dbt; loaded here so it works on every connector version
    key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        private_key=key.private_bytes(
            serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()),
        role="ACCOUNTADMIN",
        warehouse="HEATWATCH_WH",
        database=DB,
    )


def plain(v):
    """Snowflake types -> JSON types."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def query(cur, sql):
    cur.execute(sql)
    cols = [c[0].lower() for c in cur.description]
    return cols, [[plain(v) for v in row] for row in cur.fetchall()]


def columnar(cols, rows):
    """{"col": [..], ...} - about half the size of a list of objects."""
    return {c: [r[i] for r in rows] for i, c in enumerate(cols)}


def write(out: Path, name: str, payload):
    path = out / name
    path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size / 1024:,.0f} KB)")


def pipeline_health(run_results: Path):
    """Summarize the dbt build that just ran, so the dashboard can show it passed."""
    if not run_results.exists():
        return None
    results = json.loads(run_results.read_text())
    tests = [r for r in results["results"]
             if r["unique_id"].startswith(("test.", "unit_test."))]
    models = [r for r in results["results"] if r["unique_id"].startswith("model.")]
    return {
        "built_at": results["metadata"]["generated_at"],
        "tests_total": len(tests),
        "tests_passed": sum(r["status"] == "pass" for r in tests),
        "models_built": sum(r["status"] == "success" for r in models),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--run-results", default="dbt/target/run_results.json")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    fct = f"{DB}.MARTS.FCT_HEAT_COMPLAINTS"
    mart = f"{DB}.MARTS.MART_LOT_HEAT_SEASON"

    with connect() as conn:
        cur = conn.cursor()

        # one row per heat season (Oct 1 - May 31)
        _, seasons = query(cur, f"""
            select heat_season, max(ll84_report_year), booland_agg(is_season_complete), count(*)
            from {mart} group by 1 order by 1""")

        _, (summary,) = query(cur, f"""
            select max(created_date), count(*), count_if(is_no_heat) from {fct}""")

        # daily counts by borough: drives the KPIs, the trend chart and season-to-date deltas
        cols, rows = query(cur, f"""
            select created_date as d, {BORO.format(bbl='bbl', fallback='borough')} as boro,
                   count_if(is_no_heat) as no_heat, count(*) as all_heat
            from {fct}
            where created_date is not null
            group by 1, 2 order by 1, 2""")
        write(out, "daily.json", columnar(cols, rows))

        # per season and borough, plus a citywide row ('All'): medians and distinct counts
        # can't be added up across boroughs in the browser, so the warehouse computes both
        cols, rows = query(cur, f"""
            with c as (
                select heat_season as season, {BORO.format(bbl='bbl', fallback='borough')} as boro,
                       bbl, is_no_heat,
                       iff(closed_at >= created_at, datediff('minute', created_at, closed_at) / 60.0, null) as hours
                from {fct}
                where heat_season is not null
            )
            select season, coalesce(boro, 'All') as boro,
                   count(distinct iff(is_no_heat, bbl, null)) as buildings,
                   median(iff(is_no_heat, hours, null))      as median_close_hours,
                   count_if(is_no_heat and hours is not null) as closed
            from c
            group by grouping sets ((season, boro), (season))
            order by 1, 2""")
        write(out, "season_boro.json", columnar(cols, rows))

        # map: no-heat complaints on a ~400 m grid, never individual points
        cols, rows = query(cur, f"""
            select f.heat_season as season,
                   round(round(s.latitude / {GRID}) * {GRID}, 4)  as lat,
                   round(round(s.longitude / {GRID}) * {GRID}, 4) as lon,
                   {BORO.format(bbl='f.bbl', fallback='f.borough')} as boro,
                   count(*) as n
            from {fct} f
            join {DB}.STAGING.STG_COMPLAINTS_311 s on s.complaint_id = f.complaint_id
            where f.is_no_heat and f.heat_season is not null
              and s.latitude between 40.4 and 41.0 and s.longitude between -74.3 and -73.6
            group by 1, 2, 3, 4""")
        write(out, "map.json", columnar(cols, rows))

        # buildings: one file per season, so the page only downloads what it shows
        for season, *_ in seasons:
            cols, rows = query(cur, f"""
                with addr as (
                    select l.report_year, l.bbl, max_by(p.address, l.gfa_share_sqft) as address
                    from {DB}.STAGING.INT_LL84_PROPERTY_LOTS l
                    join {DB}.STAGING.STG_LL84_PROPERTIES p on p.property_year_id = l.property_year_id
                    where p.primary_property_type = 'Multifamily Housing'
                    group by 1, 2
                )
                select m.bbl, initcap(a.address) as address,
                       {BORO.format(bbl='m.bbl', fallback="''")} as boro,
                       round(m.energy_star_score, 1) as score, m.energy_star_band as band,
                       m.era, m.year_built as built, round(m.total_gfa_sqft) as gfa,
                       m.size_quartile as size_q, m.no_heat_complaints as no_heat,
                       m.all_heat_complaints as all_heat
                from {mart} m
                left join addr a on a.report_year = m.ll84_report_year and a.bbl = m.bbl
                where m.heat_season = '{season}'
                order by m.bbl""")
            write(out, f"lots_{season}.json", columnar(cols, rows))

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data_through": summary[0],
        "complaints_total": summary[1],
        "no_heat_total": summary[2],
        "seasons": [{"season": s, "ll84_year": y, "complete": bool(c), "lots": n}
                    for s, y, c, n in seasons],
        "pipeline": pipeline_health(Path(args.run_results)),
        "repo": "https://github.com/DhavalVibhakar99/nyc-heat-energy-pipeline",
    }
    write(out, "meta.json", meta)


if __name__ == "__main__":
    main()
