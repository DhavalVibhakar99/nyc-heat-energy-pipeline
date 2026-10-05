"""Load LL84 energy benchmarking (one Parquet file per report year) into raw S3.

Why not a Lambda like 311: LL84 changes once a year (dataset metadata: annual, not automated).
A daily job would come back empty ~364 days a year. So this runs by hand, once a year,
when the city publishes a new report_year. Re-running is safe: same year -> same key -> overwrite.

Usage:
    python -m ingestion.load_ll84               # every report year the city has
    python -m ingestion.load_ll84 2024          # just one year
"""
import os
import sys
import time

import pandas as pd

from ingestion.extract_311 import _session  # same retry/backoff session that fixed the 311 503s
from ingestion.write_s3 import write_parquet

URL_LL84 = "https://data.cityofnewyork.us/resource/5zyy-y8am.json"
PAGE_SIZE = 10_000
BUCKET = os.getenv("RAW_BUCKET", "heatwatch-nyc-raw-dhaval")


def _get(params: dict) -> list:
    token = os.getenv("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}
    resp = _session.get(URL_LL84, headers=headers, params=params, timeout=120)
    resp.raise_for_status()
    return resp.json()


def available_years() -> list[str]:
    rows = _get({"$select": "report_year, count(*) AS n", "$group": "report_year",
                 "$order": "report_year"})
    return [r["report_year"] for r in rows]


def fetch_year(year: str) -> pd.DataFrame:
    """Every LL84 row for one report year, reconciled against the API's own count.

    Same lesson as 311: a short page is a hiccup, not the end. Page by count, never by empty page.
    """
    where = f"report_year = '{year}'"
    expected = int(_get({"$select": "count(*) AS n", "$where": where})[0]["n"])

    pages, collected = [], 0
    while collected < expected:
        want = min(PAGE_SIZE, expected - collected)
        for attempt in range(1, 4):
            rows = _get({"$select": ":*, *", "$where": where, "$order": ":id",
                         "$limit": PAGE_SIZE, "$offset": collected})
            print(f"  {year} offset {collected:,}: {len(rows):,} of {want:,} rows (attempt {attempt})")
            if len(rows) == want:
                break
            time.sleep(10 * attempt)
        else:
            raise RuntimeError(f"{year}: page at offset {collected:,} kept coming back short - not writing")
        pages.append(pd.DataFrame(rows))
        collected += len(rows)

    df = pd.concat(pages, ignore_index=True) if pages else pd.DataFrame()
    if len(df) != expected:
        raise RuntimeError(f"{year}: API says {expected:,} rows, we paged {len(df):,}")
    return df


def load(years: list[str]) -> dict:
    results = {}
    for year in years:
        df = fetch_year(year)
        key = write_parquet(df, BUCKET, f"raw/ll84/report_year={year}/buildings.parquet")
        print(f"{year}: {len(df):,} rows -> s3://{BUCKET}/{key}")
        results[year] = len(df)
    return results


if __name__ == "__main__":
    print(load(sys.argv[1:] or available_years()))
