"""One-time backfill: every heat complaint created since a given month, one Parquet file per month.

Why this exists: the daily Lambda loads rows whose :updated_at is newer than the watermark.
That catches every NEW complaint, but not old ones the city never touched again. Checked
2026-10-05: Feb-Aug 2026 were almost entirely missing (e.g. 364 of 53,441 Feb no-heat complaints).

Writes to raw/311_heat/backfill/created_month=YYYY-MM/complaints.parquet - inside the same
stage folder, so Snowflake's COPY picks the files up, and staging's dedup (latest :updated_at
per complaint) merges them with the daily files. Never touches the watermark.
Re-running a month overwrites its file, so it's safe to repeat.

Usage:
    python -m ingestion.backfill_311 2024-10      # every month from Oct 2024 through this month
"""
import os
import sys
from datetime import date

from ingestion.extract_311 import fetch_created_between
from ingestion.write_s3 import write_parquet

BUCKET = os.getenv("RAW_BUCKET", "heatwatch-nyc-raw-dhaval")


def months_from(start: str) -> list[tuple[str, str, str]]:
    """[(label, first day, first day of next month)] from `start` (YYYY-MM) through this month."""
    year, month = map(int, start.split("-"))
    today = date.today()
    out = []
    while (year, month) <= (today.year, today.month):
        nxt = (year + 1, 1) if month == 12 else (year, month + 1)
        out.append((f"{year}-{month:02d}", f"{year}-{month:02d}-01T00:00:00",
                    f"{nxt[0]}-{nxt[1]:02d}-01T00:00:00"))
        year, month = nxt
    return out


def backfill(start: str) -> dict:
    results = {}
    for label, first, next_first in months_from(start):
        df = fetch_created_between(first, next_first)
        if df.empty:
            print(f"{label}: 0 rows, nothing written")
            results[label] = 0
            continue
        key = write_parquet(df, BUCKET,
                            f"raw/311_heat/backfill/created_month={label}/complaints.parquet")
        print(f"{label}: {len(df):,} rows -> s3://{BUCKET}/{key}")
        results[label] = len(df)
    return results


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m ingestion.backfill_311 YYYY-MM")
    totals = backfill(sys.argv[1])
    print(f"total: {sum(totals.values()):,} rows in {len(totals)} months")
