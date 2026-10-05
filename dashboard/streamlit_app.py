"""HeatWatch NYC - Streamlit in Snowflake dashboard.

Reads the dbt marts directly, so it shows whatever the daily run built this morning.
Create it in Snowsight: Projects -> Streamlit -> + Streamlit App, database HEATWATCH,
schema MARTS, warehouse HEATWATCH_WH, then paste this file in.
"""
import altair as alt
import pandas as pd
import streamlit as st
from snowflake.snowpark.context import get_active_session

st.set_page_config(page_title="HeatWatch NYC", layout="wide")
session = get_active_session()

BAND_ORDER = ["1-25", "26-50", "51-75", "76-100"]
ERA_ORDER = ["pre-1930", "1930-59", "1960-89", "1990+"]
SIZE_LABELS = {1: "Smallest 25%", 2: "Small-mid", 3: "Mid-large", 4: "Largest 25%"}


@st.cache_data(ttl=3600)
def query(sql):
    df = session.sql(sql).to_pandas()
    df.columns = [c.lower() for c in df.columns]
    return df


def rate_chart(df, x, x_order, color=None, color_order=None, title=""):
    """No-heat complaints per 100K sq ft by Energy Star band.

    Pooled rate: total complaints / total floor area, so one huge building can't dominate.
    One group -> bars. Several groups -> one line per group, so the trend within each group
    is easy to compare (and it works on older Altair versions).
    """
    x_enc = alt.X(f"{x}:N", sort=x_order, title="Energy Star band (higher = more efficient)")
    y_enc = alt.Y("per_100k:Q", title="No-heat complaints per 100K sq ft")
    tooltip = [x, alt.Tooltip("per_100k:Q", format=".2f"), alt.Tooltip("lots:Q", format=",")]
    if color is None:
        chart = alt.Chart(df, title=title).mark_bar().encode(x=x_enc, y=y_enc, tooltip=tooltip)
    else:
        chart = alt.Chart(df, title=title).mark_line(point=True).encode(
            x=x_enc, y=y_enc,
            color=alt.Color(f"{color}:N", sort=color_order, title=None),
            tooltip=[color] + tooltip,
        )
    return chart.properties(height=320)


# ---------------------------------------------------------------- header
st.title("HeatWatch NYC")
st.caption("Do energy-inefficient apartment buildings leave their tenants cold? "
           "NYC 311 heat complaints joined to Local Law 84 energy benchmarking, rebuilt daily.")

seasons = query("""
    select distinct heat_season, ll84_report_year
    from heatwatch.marts.mart_lot_heat_season
    where is_season_complete
    order by heat_season desc
""")
if seasons.empty:
    st.warning("No complete heat season in the data yet.")
    st.stop()

season = st.selectbox(
    "Heat season (Oct 1 - May 31)", seasons["heat_season"].tolist(),
    format_func=lambda s: f"{s}  (vs LL84 {int(seasons.set_index('heat_season').loc[s, 'll84_report_year'])} scores)",
)

# ---------------------------------------------------------------- KPIs
kpi = query(f"""
    select
        (select count_if(is_no_heat) from heatwatch.marts.fct_heat_complaints
          where heat_season = '{season}')                                   as no_heat,
        count(*)                                                            as lots,
        count_if(has_energy_star_score)                                     as scored_lots,
        sum(no_heat_complaints)                                             as matched,
        (select max(created_date) from heatwatch.marts.fct_heat_complaints) as data_through
    from heatwatch.marts.mart_lot_heat_season
    where heat_season = '{season}'
""").iloc[0]

c1, c2, c3, c4 = st.columns(4)
c1.metric("No-heat complaints", f"{int(kpi.no_heat):,}")
c2.metric("Residential lots in LL84", f"{int(kpi.lots):,}")
c3.metric("Complaints on those lots", f"{int(kpi.matched):,}",
          f"{kpi.matched / kpi.no_heat:.0%} of all", delta_color="off")
c4.metric("Data through", pd.to_datetime(kpi.data_through).strftime("%b %d, %Y"))

# ---------------------------------------------------------------- trend
st.subheader("Complaints by month")
monthly = query("""
    select date_trunc('month', created_date) as month,
           count_if(is_no_heat)              as no_heat,
           count_if(not is_no_heat)          as other_heat_hot_water
    from heatwatch.marts.fct_heat_complaints
    group by 1 order by 1
""").set_index("month")
st.bar_chart(monthly, height=260)
st.caption("No-heat complaints follow the weather: near zero in summer, peaking in January.")

# ---------------------------------------------------------------- the finding
lots = query(f"""
    select energy_star_band as band, size_quartile, era,
           no_heat_complaints, total_gfa_sqft
    from heatwatch.marts.mart_lot_heat_season
    where heat_season = '{season}' and has_energy_star_score
""")
lots["size"] = lots["size_quartile"].map(SIZE_LABELS)


def pooled(df, by):
    g = df.groupby(by, as_index=False).agg(
        complaints=("no_heat_complaints", "sum"),
        gfa=("total_gfa_sqft", "sum"),
        lots=("no_heat_complaints", "size"),
    )
    g["per_100k"] = g["complaints"] / g["gfa"] * 100_000
    return g


st.subheader("1. Pooled together, efficiency barely matters")
st.altair_chart(rate_chart(pooled(lots, ["band"]), "band", BAND_ORDER), use_container_width=True)

st.subheader("2. Split by building size, a pattern appears (Simpson's paradox)")
st.altair_chart(rate_chart(pooled(lots, ["band", "size"]), "band", BAND_ORDER,
                           color="size", color_order=list(SIZE_LABELS.values())),
                use_container_width=True)
st.caption("In smaller buildings, better scores go with fewer complaints. The largest buildings "
           "hold most of the floor area, so they hide that pattern in the pooled view.")

st.subheader("3. Split by age, it's a prewar story")
st.altair_chart(rate_chart(pooled(lots.dropna(subset=["era"]), ["band", "era"]), "band", BAND_ORDER,
                           color="era", color_order=ERA_ORDER),
                use_container_width=True)
st.caption("Prewar buildings get far more complaints per square foot, and only there does "
           "efficiency clearly track with fewer complaints.")

# ---------------------------------------------------------------- lots table
st.subheader("Lots with the highest complaint rates")
min_sqft = st.slider("Minimum floor area (sq ft)", 25_000, 500_000, 50_000, step=25_000,
                     help="Small lots swing wildly on a handful of complaints.")
top = query(f"""
    select bbl, round(energy_star_score) as energy_star, energy_star_band, era, year_built,
           round(total_gfa_sqft)          as floor_area_sqft,
           no_heat_complaints,
           round(no_heat_per_100k_sqft, 1) as per_100k_sqft
    from heatwatch.marts.mart_lot_heat_season
    where heat_season = '{season}' and total_gfa_sqft >= {min_sqft}
    order by no_heat_per_100k_sqft desc
    limit 25
""")
st.dataframe(top, use_container_width=True)

# ---------------------------------------------------------------- map
st.subheader("Where the complaints are")
points = query(f"""
    select latitude as lat, longitude as lon
    from heatwatch.staging.stg_complaints_311 c
    join heatwatch.marts.fct_heat_complaints f on f.complaint_id = c.complaint_id
    where f.heat_season = '{season}' and f.is_no_heat
      and c.latitude is not null and c.longitude is not null
    order by random()
    limit 20000
""")
st.map(points)
st.caption("A random sample of 20,000 no-heat complaints for the season.")

st.divider()
st.caption("Source: NYC Open Data - 311 Service Requests (erm2-nwe9) and LL84 Energy "
           "Benchmarking (5zyy-y8am). Pipeline: AWS Lambda -> S3 -> Snowflake -> dbt.")
