"""One pipeline run: read bookmark -> fetch changes -> write to S3 -> move bookmark.

Order matters. The bookmark moves LAST, only after the file is safely in S3.
Crash anywhere before that and the next run just re-fetches the same records -
worst case a duplicate, which dbt dedupes. The reverse order could silently lose a batch.
"""
import os

from ingestion.extract_311 import fetch_since
from ingestion.watermark import get_watermark, set_watermark
from ingestion.write_s3 import write_raw

BUCKET = os.getenv("RAW_BUCKET", "heatwatch-nyc-raw-dhaval")


def run() -> dict:
    watermark = get_watermark()
    df, upper = fetch_since(watermark)  # raises if the rows don't reconcile
    if df.empty:
        return {"rows": 0, "watermark": watermark}

    key = write_raw(df, BUCKET)  # step 1: data safely stored...
    set_watermark(upper)         # ...step 2: only now move the bookmark
    return {"rows": len(df), "file": key, "old": watermark, "new": upper}

def lambda_handler(event, context):
    """The function AWS calls on each scheduled run.

    event/context are unused on purpose - the watermark in SSM already says what to fetch,
    so the Lambda needs no input. Same code path as running it locally.
    """
    return run()

if __name__ == "__main__":
    print(run())