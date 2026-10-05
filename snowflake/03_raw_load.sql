-- 03_raw_load.sql
-- Raw layer: a faithful, append-only copy of every file the Lambda writes.
-- Duplicates are expected here (the city republishes most rows every couple of days);
-- dedup happens in staging, not here.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE heatwatch_wh;

-- one flexible column for the record, plus lineage: which file, loaded when
CREATE TABLE IF NOT EXISTS heatwatch.raw.complaints_311 (
  record      VARIANT,
  source_file STRING,
  loaded_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- $1 = the whole Parquet row; METADATA$FILENAME = the file it came from.
-- COPY remembers which files it already loaded, so re-running only picks up new ones.
COPY INTO heatwatch.raw.complaints_311 (record, source_file)
FROM (SELECT $1, METADATA$FILENAME FROM @heatwatch.raw.s3_311_heat);

-- rows per file
SELECT source_file, COUNT(*) AS rows_loaded
FROM heatwatch.raw.complaints_311
GROUP BY 1 ORDER BY 1;
