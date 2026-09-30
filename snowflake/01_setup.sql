-- ACCOUNTADMIN is the only role allowed to create spending caps
USE ROLE ACCOUNTADMIN;

-- the "reading room": smallest size, shuts off after 60 idle seconds, wakes up on its own
CREATE WAREHOUSE IF NOT EXISTS heatwatch_wh
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- the "bookshelves": one database, with a schema for raw data straight from S3
CREATE DATABASE IF NOT EXISTS heatwatch;
CREATE SCHEMA IF NOT EXISTS heatwatch.raw;

-- the spending cap: email a warning at 80%, hard-stop the warehouse at 100%
CREATE RESOURCE MONITOR IF NOT EXISTS heatwatch_monitor
  WITH CREDIT_QUOTA = 20
  TRIGGERS ON 80 PERCENT DO NOTIFY
           ON 100 PERCENT DO SUSPEND;

ALTER WAREHOUSE heatwatch_wh SET RESOURCE_MONITOR = heatwatch_monitor;

SHOW WAREHOUSES LIKE 'heatwatch_wh';