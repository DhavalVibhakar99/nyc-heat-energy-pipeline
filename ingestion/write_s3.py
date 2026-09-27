"""Write a batch of raw 311 rows to S3 as Parquet - safe to re-run."""
import io
import json
from datetime import datetime, timezone

import boto3
import pandas as pd


def write_raw(df: pd.DataFrame, bucket: str, run_date: str | None = None) -> str | None:
    """Write df to s3://bucket/raw/311_heat/dt=<run_date>/complaints.parquet.

    Same run_date -> same key -> an overwrite, never a second copy.
    That's the entire idempotency trick: a rerun replaces the day's file instead of piling up duplicates.
    """
    if df.empty:
        return None  # nothing changed - write nothing, rather than an empty file that looks like data

    # UTC, so "today" doesn't depend on where the code happens to run (Codespace vs Lambda)
    run_date = run_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"raw/311_heat/dt={run_date}/complaints.parquet"

    # 'location' comes back as nested dicts, and dict/None mixes make Parquet grumpy.
    # raw should keep the info without fighting types, so store nested values as JSON text
    df = df.copy()
    for col in df.columns:
        if df[col].map(lambda v: isinstance(v, (dict, list))).any():
            df[col] = df[col].map(lambda v: json.dumps(v) if isinstance(v, (dict, list)) else v)

    # build the file in memory instead of on disk - Lambda's disk is small, and we're sizing memory anyway
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    boto3.client("s3").put_object(Bucket=bucket, Key=key, Body=buf.getvalue())
    return key