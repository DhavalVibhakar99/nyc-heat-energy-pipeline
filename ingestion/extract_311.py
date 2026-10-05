"""Pull 311 heat complaints that changed since a given timestamp - and prove we got all of them.

Lessons learned:
- 2026-09-29: an empty page used to mean "done", but it can also mean "the API hiccuped".
  Two scheduled runs silently stopped early and dropped ~211K rows -> added count reconciliation.
- 2026-10-01: from Lambda (shared AWS IPs, no app token) the API returns 503s and short pages.
  -> app token, automatic retries with backoff, and paging that ends by count, not by empty page.
"""
import os
import time

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

URL_311 = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"
PAGE_SIZE = 10_000

# one shared session that retries 429s and 5xx errors on its own: waits ~2, 4, 8, 16, 32s.
# a 503 usually means "busy, try again shortly", not "give up"
_session = requests.Session()
_session.mount("https://", HTTPAdapter(max_retries=Retry(
    total=5, backoff_factor=2, status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"])))


def _get(params: dict) -> list:
    token = os.getenv("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}  # token = our own rate limit, not a crowded shared IP's
    resp = _session.get(URL_311, headers=headers, params=params, timeout=60)
    resp.raise_for_status()
    return resp.json()


def fetch_since(watermark: str) -> tuple[pd.DataFrame, str | None]:
    """Heat complaints changed after `watermark`, reconciled against the API's own count.

    Returns (rows, upper): upper is the newest :updated_at included, i.e. the next bookmark.
    """
    base = f"complaint_type = 'HEAT/HOT WATER' AND :updated_at > '{watermark}'"

    # 1. ask the city first: how many rows, and what's the newest timestamp? pin that as the upper bound
    summary = _get({"$select": "count(*) AS n, max(:updated_at) AS upper", "$where": base})[0]
    expected = int(summary["n"])
    if expected == 0:
        return pd.DataFrame(), None
    upper = summary["upper"].rstrip("Z")
    where = f"{base} AND :updated_at <= '{upper}'"

    df = _page_all(where, expected)
    return df, upper


def _page_all(where: str, expected: int) -> pd.DataFrame:
    """Page through every row matching `where` until we have exactly `expected` of them."""
    # 2. page until we have exactly `expected` rows. every page should be full, except the last one.
    #    a short page isn't "the end" anymore - it's a hiccup, so wait and ask for the same page again
    pages, collected = [], 0
    while collected < expected:
        want = min(PAGE_SIZE, expected - collected)
        for attempt in range(1, 4):
            rows = _get({"$select": ":*, *", "$where": where, "$order": ":id",
                         "$limit": PAGE_SIZE, "$offset": collected})
            print(f"offset {collected:,}: {len(rows):,} of {want:,} rows (attempt {attempt})")
            if len(rows) == want:
                break
            time.sleep(10 * attempt)
        else:
            # for/else: this only runs if the loop never hit `break`, i.e. all 3 attempts came back short
            raise RuntimeError(f"page at offset {collected:,} kept coming back short "
                               f"({len(rows):,} of {want:,}) - not writing a partial load")
        pages.append(pd.DataFrame(rows))
        collected += len(rows)

    df = pd.concat(pages, ignore_index=True)

    # 3. reconcile anyway - belt and braces, and it documents the guarantee in code
    if len(df) != expected:
        raise RuntimeError(f"reconciliation failed: API says {expected:,} rows, we paged {len(df):,}")
    return df


def fetch_created_between(start: str, end: str) -> pd.DataFrame:
    """Every heat complaint CREATED in [start, end), whenever it was last updated. For backfills.

    fetch_since() only sees rows the city touched after the watermark, so complaints that were
    filed and closed before the pipeline existed never come through it (see docs/decisions.md).
    """
    where = (f"complaint_type = 'HEAT/HOT WATER' "
             f"AND created_date >= '{start}' AND created_date < '{end}'")
    expected = int(_get({"$select": "count(*) AS n", "$where": where})[0]["n"])
    if expected == 0:
        return pd.DataFrame()
    return _page_all(where, expected)
