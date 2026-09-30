"""Pull 311 heat complaints that changed since a given timestamp.

Step one of the pipeline: get data out of NYC Open Data. No AWS in here yet -
I want this working locally before wrapping it in a Lambda.
"""
import os

import pandas as pd
import requests

URL_311 = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"
PAGE_SIZE = 10_000  # gentle on the API, but a full winter day still fits in a few requests


def fetch_since(watermark: str) -> pd.DataFrame:
    """Every heat complaint whose record changed after `watermark` (ISO timestamp)."""
    token = os.getenv("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}  # token optional, just raises the rate limit

    pages, offset = [], 0
    while True:
        params = {
            # ':*, *' = normal columns plus hidden system ones like :updated_at
            "$select": ":*, *",
            "$where": f"complaint_type = 'HEAT/HOT WATER' AND :updated_at > '{watermark}'",
            # paging only works if the order can't shift between requests.
            # :id is Socrata's permanent row id, so nothing gets skipped or read twice
            "$order": ":id",
            "$limit": PAGE_SIZE,
            "$offset": offset,
        }
        resp = requests.get(URL_311, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        rows = resp.json()
        if not rows:  # empty page = we've read everything
            break
        pages.append(pd.DataFrame(rows))
        offset += PAGE_SIZE

    return pd.concat(pages, ignore_index=True) if pages else pd.DataFrame()