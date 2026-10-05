-- The mart can only count complaints that exist. Per season, its no-heat total must not
-- exceed the fact table's (it's usually lower: only LL84 residential lots are in the mart).
-- A higher number would mean the lot join is fanning out and double-counting.
with mart as (
    select heat_season, sum(no_heat_complaints) as mart_total
    from {{ ref('mart_lot_heat_season') }}
    group by heat_season
),
fact as (
    select heat_season, count_if(is_no_heat) as fact_total
    from {{ ref('fct_heat_complaints') }}
    where heat_season is not null and bbl is not null
    group by heat_season
)
select m.heat_season, m.mart_total, f.fact_total
from mart m
join fact f on f.heat_season = m.heat_season
where m.mart_total > f.fact_total
