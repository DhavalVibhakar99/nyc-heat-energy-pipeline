-- 04_staging.sql
-- One row per complaint: the latest version across all incremental files.
--
-- Why union every file instead of reading only the newest one: extraction is incremental
-- on :updated_at, so a file only holds rows the city touched since the last run.
-- Checked 2026-10-05: 1,649 complaints missing from the newest file still exist,
-- unchanged, in the city's live data. The newest file is not a full snapshot.
--
-- Known limitation: a complaint the city truly deletes would never be removed here.
-- Fix if ever needed: a periodic job that pulls only the current list of IDs and compares.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE heatwatch_wh;

CREATE SCHEMA IF NOT EXISTS heatwatch.staging;

CREATE OR REPLACE VIEW heatwatch.staging.stg_complaints_311 AS
SELECT
  record:unique_key::STRING                                           AS complaint_id,
  TRY_TO_TIMESTAMP_NTZ(record:created_date::STRING)                   AS created_at,
  TRY_TO_TIMESTAMP_NTZ(record:closed_date::STRING)                    AS closed_at,
  TRY_TO_TIMESTAMP_NTZ(record:resolution_action_updated_date::STRING) AS resolution_updated_at,
  record:status::STRING                                               AS status,
  record:complaint_type::STRING                                       AS complaint_type,
  record:descriptor::STRING                                           AS descriptor,
  record:descriptor_2::STRING                                         AS descriptor_detail,
  record:location_type::STRING                                        AS location_type,
  record:borough::STRING                                              AS borough,
  record:incident_zip::STRING                                         AS zip_code,
  record:incident_address::STRING                                     AS address,
  record:bbl::STRING                                                  AS bbl,
  record:community_board::STRING                                      AS community_board,
  record:council_district::STRING                                     AS council_district,
  TRY_TO_DOUBLE(record:latitude::STRING)                              AS latitude,
  TRY_TO_DOUBLE(record:longitude::STRING)                             AS longitude,
  record:open_data_channel_type::STRING                               AS channel,
  record:resolution_description::STRING                              AS resolution_description,
  TRY_TO_TIMESTAMP_TZ(record[':updated_at']::STRING)                  AS source_updated_at,
  source_file                                                         AS last_seen_in,
  loaded_at
FROM heatwatch.raw.complaints_311
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY record:unique_key::STRING
  ORDER BY TRY_TO_TIMESTAMP_TZ(record[':updated_at']::STRING) DESC NULLS LAST,
           source_file DESC
) = 1;

-- check: total rows should equal distinct IDs (223,707 on 2026-10-05)
SELECT COUNT(*) AS total, COUNT(DISTINCT complaint_id) AS distinct_ids
FROM heatwatch.staging.stg_complaints_311;
