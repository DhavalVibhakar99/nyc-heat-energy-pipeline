-- One row per property per tax lot (BBL) per report year.
--
-- SQL port of clean_bbl() from notebooks/01_explore_data.ipynb. LL84's BBL field comes in
-- at least six formats; 311 always uses the clean 10-digit one:
--   '1020690001'              clean                  -> 1020690001
--   '1-00545-0026'            dashed                 -> 1005450026
--   '3043930001;3043710001'   semicolon list         -> two lots
--   '0000000001, 0000000002'  comma list, EPA demo   -> dropped (borough 0 doesn't exist)
--   'Not Available'           missing                -> dropped
-- The five cases above are dbt unit tests (_intermediate.yml).
--
-- A property spanning several lots gets its floor area split evenly across them. That's an
-- assumption: LL84 doesn't say which building sits on which lot.

with properties as (

    select * from {{ ref('stg_ll84_properties') }}

),

-- one row per piece of the BBL field; both ';' and ',' are used as separators
pieces as (

    select
        p.*,
        trim(s.value::string) as piece
    from properties p,
        lateral split_to_table(replace(coalesce(p.bbl_raw, ''), ';', ','), ',') s

),

normalized as (

    select
        *,
        case
            -- dashed: borough-block-lot, padded back to 1+5+4 digits.
            -- like Python's zfill, only pad parts that are too short; never truncate
            when contains(piece, '-') and array_size(split(piece, '-')) = 3 then
                split_part(piece, '-', 1)
                || iff(len(split_part(piece, '-', 2)) < 5, lpad(split_part(piece, '-', 2), 5, '0'), split_part(piece, '-', 2))
                || iff(len(split_part(piece, '-', 3)) < 4, lpad(split_part(piece, '-', 3), 4, '0'), split_part(piece, '-', 3))
            -- a dash format we haven't seen: skip rather than guess
            when contains(piece, '-') then null
            else piece
        end as bbl
    from pieces

),

-- valid = 10 digits with a real borough (1-5). This one rule also drops 'Not Available'
-- and the 0000... demo records, so no special cases are needed
valid as (

    select distinct
        report_year,
        property_id,
        property_year_id,
        bbl,
        primary_property_type,
        energy_star_score,
        gfa_sqft,
        year_built
    from normalized
    where regexp_like(bbl, '[1-5][0-9]{9}')

)

select
    *,
    count(*) over (partition by report_year, property_id)                  as n_lots,
    gfa_sqft / count(*) over (partition by report_year, property_id)       as gfa_share_sqft
from valid
