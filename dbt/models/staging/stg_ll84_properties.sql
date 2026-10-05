-- One row per property per report year, typed.
--
-- Two kinds of duplicates get removed here:
-- 1. Re-loaded files. load_ll84.py overwrites a year's file, and Snowflake loads the new
--    content as a new file, so raw can hold a year twice. Keep only the latest load per file.
-- 2. Repeated properties. The city's own data lists ~150 properties twice in 2022 and ~620 in
--    2023 (2024 has none). Left in, their floor area would count twice. Keep the newest report.
--
-- "Not Available" and other text in number columns becomes NULL through try_to_*.

with latest_load as (

    select *
    from {{ source('raw', 'll84_buildings') }}
    qualify loaded_at = max(loaded_at) over (partition by source_file)

),

typed as (

    select
        try_to_number(record:report_year::string)                    as report_year,
        record:property_id::string                                   as property_id,
        nullif(record:property_name::string, 'Not Available')        as property_name,
        record:nyc_borough_block_and_lot::string                     as bbl_raw,
        nullif(record:primary_property_type::string, 'Not Available') as primary_property_type,
        nullif(record:largest_property_use_type::string, 'Not Available') as largest_property_use_type,
        try_to_double(record:year_built::string)::int                as year_built,
        try_to_double(record:energy_star_score::string)::int         as energy_star_score,
        try_to_double(record:site_eui_kbtu_ft::string)               as site_eui_kbtu_ft,
        try_to_double(record:property_gfa_self_reported::string)     as gfa_sqft,
        nullif(record:address_1::string, 'Not Available')            as address,
        nullif(record:postal_code::string, 'Not Available')          as zip_code,
        nullif(record:borough::string, 'Not Available')              as borough,
        try_to_timestamp_ntz(record:report_generation_date::string)  as report_generated_at,
        try_to_timestamp_tz(record[':updated_at']::string)           as source_updated_at,
        source_file,
        loaded_at
    from latest_load

)

select
    report_year || '-' || property_id as property_year_id,
    *
from typed
qualify row_number() over (
    partition by report_year, property_id
    order by report_generated_at desc nulls last,
             source_updated_at desc nulls last,
             gfa_sqft desc nulls last
) = 1
