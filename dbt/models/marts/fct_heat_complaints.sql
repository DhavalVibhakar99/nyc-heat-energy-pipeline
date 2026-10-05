-- One row per HEAT/HOT WATER complaint, with the fields the analysis needs.
--
-- is_no_heat: the notebook's filter. "No heat" and "no heat and no hot water" mean the tenant
-- is cold; "no hot water" alone is usually a failed water heater, which says nothing about
-- insulation or heating efficiency.
--
-- heat_season: NYC's legal heat season runs Oct 1 - May 31. Jun-Sep complaints get NULL.
--
-- ll84_report_year: the LL84 year a complaint is compared against = the latest one that existed
-- when it was filed. Buildings report the previous calendar year, published during the next one,
-- so for a heating year starting October Y that's report year Y-1 (Jan 2026 -> 2024, as in the
-- notebook), capped at the newest year actually loaded.

with complaints as (

    select * from {{ ref('stg_complaints_311') }}
    where complaint_type = 'HEAT/HOT WATER'

),

latest_ll84 as (

    select max(report_year) as max_report_year from {{ ref('stg_ll84_properties') }}

),

derived as (

    select
        complaint_id,
        -- only keep BBLs in the clean format so the join to buildings can't mismatch
        iff(regexp_like(bbl, '[1-5][0-9]{9}'), bbl, null)                 as bbl,
        created_at,
        created_at::date                                                    as created_date,
        closed_at,
        status,
        descriptor_detail,
        coalesce(descriptor_detail in ('NO HEAT', 'NO HEAT AND NO HOT WATER'), false) as is_no_heat,
        borough,
        zip_code,
        iff(month(created_at) >= 10, year(created_at), year(created_at) - 1) as heating_year_start,
        iff(month(created_at) between 6 and 9, null,
            heating_year_start || '-' || right((heating_year_start + 1)::string, 2)) as heat_season
    from complaints

)

select
    d.*,
    least(d.heating_year_start - 1, l.max_report_year) as ll84_report_year
from derived d
cross join latest_ll84 l
