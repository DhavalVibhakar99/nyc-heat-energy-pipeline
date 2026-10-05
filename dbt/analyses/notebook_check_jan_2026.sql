-- Reproduces the notebook's first hypothesis table (cell "First test of the hypothesis")
-- from the dbt models, to prove the SQL port matches the pandas version.
-- Notebook result, January 2026 no-heat complaints vs 2024 Energy Star bands:
--   band     lots   complaints   per_100k_sqft
--   1-25     2,464    6,317        1.379
--   26-50    3,099    9,578        1.991
--   51-75    4,546   11,324        1.879
--   76-100   6,610   14,905        1.852
-- Lot counts should match almost exactly. Complaint counts can drift slightly: the city has
-- updated some complaints since the notebook ran.
--
-- Run with:  dbt show --inline "$(cat analyses/notebook_check_jan_2026.sql)"

with jan as (
    select bbl, count(*) as complaints
    from {{ ref('fct_heat_complaints') }}
    where is_no_heat
      and created_date between '2026-01-01' and '2026-01-31'
    group by bbl
),
lots as (
    select * from {{ ref('dim_lot_energy') }}
    where report_year = 2024 and has_energy_star_score
)
select
    l.energy_star_band                                              as band,
    count(*)                                                        as lots,
    round(avg(iff(coalesce(j.complaints, 0) > 0, 1, 0)), 3)         as pct_with_complaint,
    sum(coalesce(j.complaints, 0))                                  as complaints,
    round(sum(coalesce(j.complaints, 0)) / sum(l.total_gfa_sqft) * 100000, 3) as per_100k_sqft
from lots l
left join jan j on j.bbl = l.bbl
group by 1
order by 1
