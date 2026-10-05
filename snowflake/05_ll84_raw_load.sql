-- 05_ll84_raw_load.sql
-- Raw layer for LL84 energy benchmarking: one Parquet file per report year.
--
-- Unlike 311, these files get OVERWRITTEN when a year is re-loaded. Snowflake sees the new
-- content as a new file and loads it again, so raw can hold two copies of a year.
-- Staging keeps only the latest load of each file (max loaded_at per source_file).

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE heatwatch_wh;

-- the integration already allows all of raw/, so no AWS changes needed
CREATE STAGE IF NOT EXISTS heatwatch.raw.s3_ll84
  STORAGE_INTEGRATION = heatwatch_s3_int
  URL = 's3://heatwatch-nyc-raw-dhaval/raw/ll84/'
  FILE_FORMAT = (TYPE = PARQUET);

LIST @heatwatch.raw.s3_ll84;

CREATE TABLE IF NOT EXISTS heatwatch.raw.ll84_buildings (
  record      VARIANT,
  source_file STRING,
  loaded_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

COPY INTO heatwatch.raw.ll84_buildings (record, source_file)
FROM (SELECT $1, METADATA$FILENAME FROM @heatwatch.raw.s3_ll84);

-- expect 30,485 / 33,684 / 39,090 for 2022 / 2023 / 2024
SELECT source_file, COUNT(*) AS rows_loaded, MAX(loaded_at) AS loaded_at
FROM heatwatch.raw.ll84_buildings
GROUP BY 1 ORDER BY 1;
