{#
    Load any new raw files from S3 into Snowflake. Run before `dbt build`:

        dbt run-operation load_raw

    Safe to run any number of times: COPY INTO remembers which files it already loaded and
    skips them. The tables and stages themselves are created once by snowflake/03 and 05.
#}
{% macro load_raw() %}
    {% set loads = {
        "complaints_311": "@heatwatch.raw.s3_311_heat",
        "ll84_buildings": "@heatwatch.raw.s3_ll84"
    } %}
    {% for table, stage in loads.items() %}
        {% set copy_sql %}
            copy into heatwatch.raw.{{ table }} (record, source_file)
            from (select $1, metadata$filename from {{ stage }})
        {% endset %}
        {% set result = run_query(copy_sql) %}
        {% for row in result.rows %}
            {{ log(table ~ ": " ~ (row.values() | join(" | ")), info=True) }}
        {% endfor %}
    {% endfor %}
{% endmacro %}
