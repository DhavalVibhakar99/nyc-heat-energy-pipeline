-- One row per complaint: the latest version across all incremental files.
-- Union of every file, not just the newest: extraction is incremental on :updated_at,
-- so the newest file is not a full snapshot (see docs/decisions.md, 2026-10-05).

select
    record:unique_key::string                                           as complaint_id,
    try_to_timestamp_ntz(record:created_date::string)                   as created_at,
    try_to_timestamp_ntz(record:closed_date::string)                    as closed_at,
    try_to_timestamp_ntz(record:resolution_action_updated_date::string) as resolution_updated_at,
    record:status::string                                               as status,
    record:complaint_type::string                                       as complaint_type,
    record:descriptor::string                                           as descriptor,
    record:descriptor_2::string                                         as descriptor_detail,
    record:location_type::string                                        as location_type,
    record:borough::string                                              as borough,
    record:incident_zip::string                                         as zip_code,
    record:incident_address::string                                     as address,
    record:bbl::string                                                  as bbl,
    record:community_board::string                                      as community_board,
    record:council_district::string                                     as council_district,
    try_to_double(record:latitude::string)                              as latitude,
    try_to_double(record:longitude::string)                             as longitude,
    record:open_data_channel_type::string                               as channel,
    record:resolution_description::string                              as resolution_description,
    try_to_timestamp_tz(record[':updated_at']::string)                  as source_updated_at,
    source_file                                                         as last_seen_in,
    loaded_at
from {{ source('raw', 'complaints_311') }}
qualify row_number() over (
    partition by record:unique_key::string
    order by try_to_timestamp_tz(record[':updated_at']::string) desc nulls last,
             source_file desc
) = 1
