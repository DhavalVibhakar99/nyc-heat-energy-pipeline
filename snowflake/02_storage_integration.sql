-- 02_storage_integration.sql
-- Lets Snowflake read the raw S3 files without any access keys:
-- Snowflake assumes a read-only IAM role in our AWS account, verified by an external ID.

USE ROLE ACCOUNTADMIN;

-- IF NOT EXISTS, never OR REPLACE: replacing an integration generates a new external ID,
-- which silently breaks the trust policy on the AWS role
CREATE STORAGE INTEGRATION IF NOT EXISTS heatwatch_s3_int
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'S3'
  ENABLED = TRUE
  STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::YOUR_AWS_ACCOUNT_ID:role/heatwatch-snowflake-reader'
  STORAGE_ALLOWED_LOCATIONS = ('s3://heatwatch-nyc-raw-dhaval/raw/');

-- STORAGE_AWS_IAM_USER_ARN and STORAGE_AWS_EXTERNAL_ID from this output go into the
-- AWS role's trust policy. They never get committed.
DESC INTEGRATION heatwatch_s3_int;

-- a named shortcut to the raw 311 folder, so loads can say @s3_311_heat instead of a full path
CREATE STAGE IF NOT EXISTS heatwatch.raw.s3_311_heat
  STORAGE_INTEGRATION = heatwatch_s3_int
  URL = 's3://heatwatch-nyc-raw-dhaval/raw/311_heat/'
  FILE_FORMAT = (TYPE = PARQUET);

-- sanity check: should list one Parquet file per day
LIST @heatwatch.raw.s3_311_heat;