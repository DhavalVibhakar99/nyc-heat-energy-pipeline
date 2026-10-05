-- The analysis table: one row per residential lot per heat season.
--
-- Built FROM the buildings, LEFT JOIN to complaints: lots nobody complained about stay in
-- with 0. They're the control group; studying only lots with complaints would be like
-- studying only sick patients.
--
-- Each season uses the LL84 year that existed during it (see fct_heat_complaints).
-- Rates are per 100,000 sq ft, so a 500-unit tower doesn't look worse just for being big.

with complaints as (

    select * from {{ ref('fct_heat_complaints') }}
    where heat_season is not null

),

coverage as (

    select min(created_date) as data_start, max(created_date) as data_end from complaints

),

seasons as (

    select distinct heat_season, heating_year_start, ll84_report_year from complaints

),

counts as (

    select
        heat_season,
        bbl,
        count_if(is_no_heat) as no_heat_complaints,
        count(*)             as all_heat_complaints
    from complaints
    where bbl is not null
    group by heat_season, bbl

),

lot_seasons as (

    select
        s.heat_season,
        s.heating_year_start,
        l.*
    from seasons s
    join {{ ref('dim_lot_energy') }} l
        on l.report_year = s.ll84_report_year

)

select
    ls.heat_season || '-' || ls.bbl                                         as lot_season_id,
    ls.heat_season,
    ls.report_year                                                          as ll84_report_year,
    ls.bbl,
    ls.n_properties,
    ls.total_gfa_sqft,
    ls.energy_star_score,
    ls.has_energy_star_score,
    ls.energy_star_band,
    ls.year_built,
    ls.era,
    -- size quartiles among scored lots within each season, like the notebook's pd.qcut(total_gfa, 4)
    iff(ls.has_energy_star_score,
        ntile(4) over (partition by ls.heat_season, ls.has_energy_star_score
                       order by ls.total_gfa_sqft),
        null)                                                               as size_quartile,
    coalesce(c.no_heat_complaints, 0)                                       as no_heat_complaints,
    coalesce(c.all_heat_complaints, 0)                                      as all_heat_complaints,
    coalesce(c.no_heat_complaints, 0) / ls.total_gfa_sqft * 100000          as no_heat_per_100k_sqft,
    -- a season only counts as complete if the data covers all of Oct 1 - May 31
    date_from_parts(ls.heating_year_start, 10, 1) >= cov.data_start
        and date_from_parts(ls.heating_year_start + 1, 5, 31) <= cov.data_end as is_season_complete
from lot_seasons ls
cross join coverage cov
left join counts c
    on c.heat_season = ls.heat_season
   and c.bbl = ls.bbl
