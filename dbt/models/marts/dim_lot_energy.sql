-- One row per residential tax lot (BBL) per LL84 report year: the "building" side of the join.
--
-- Same aggregation as the notebook:
-- - Multifamily Housing only. Offices never get HPD heat complaints; keeping them would add
--   thousands of fake zeros.
-- - Several properties can share a lot. The lot's Energy Star score is the floor-area-weighted
--   average of the properties that HAVE a score (like credits in a GPA).
-- - total_gfa_sqft counts every property, scored or not: their tenants can still complain.
-- - Building age = year built of the lot's biggest property, where most tenants live.

with lots as (

    select * from {{ ref('int_ll84_property_lots') }}
    where primary_property_type = 'Multifamily Housing'

),

aggregated as (

    select
        report_year,
        bbl,
        count(distinct property_id)                                                   as n_properties,
        sum(gfa_share_sqft)                                                           as total_gfa_sqft,
        sum(iff(energy_star_score is not null, gfa_share_sqft, null))                as scored_gfa_sqft,
        -- rounded: a lone score of 100 weighted by itself came out as 100.00000000001 in floating
        -- point, which failed the 1-100 range test. 4 decimals removes the noise, keeps the precision
        round(sum(energy_star_score * gfa_share_sqft)
            / nullif(sum(iff(energy_star_score is not null, gfa_share_sqft, null)), 0), 4) as energy_star_score,
        max_by(year_built, gfa_share_sqft)                                            as year_built
    from lots
    group by report_year, bbl

)

select
    report_year || '-' || bbl as lot_year_id,
    *,
    energy_star_score is not null as has_energy_star_score,
    -- same bins as the notebook's pd.cut([0, 25, 50, 75, 100], include_lowest=True)
    case
        when energy_star_score is null then null
        when energy_star_score <= 25 then '1-25'
        when energy_star_score <= 50 then '26-50'
        when energy_star_score <= 75 then '51-75'
        else '76-100'
    end as energy_star_band,
    case
        when year_built is null or year_built <= 0 then null
        when year_built <= 1929 then 'pre-1930'
        when year_built <= 1959 then '1930-59'
        when year_built <= 1989 then '1960-89'
        else '1990+'
    end as era
from aggregated
where total_gfa_sqft > 0
