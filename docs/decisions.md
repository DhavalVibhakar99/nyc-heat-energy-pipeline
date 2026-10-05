## 311 :updated_at: occasional bulk reloads, normal days are much smaller (final, 2026-09-29)
- 2026-09-26 and 09-27: ~221K rows each, a one-time reload by the city
- 2026-09-28: ~2.2 MB (~20K rows); 2026-09-29: ~1.2 MB (~10K rows), from scheduled runs
- First guess was "occasional," then "daily." Four days of evidence says: large reloads
  happen, but not every day

**Decisions (unchanged):** Lambda stays sized for reload days and winter volume
(2 GB / 10 min). Raw keeps every file; dbt keeps the latest version per `unique_key`.
- Raw S3 keeps every daily file; dbt staging keeps the latest version per `unique_key`
- Watermark still works: it prevents re-reading within a day and never skips data

## Lambda sizing (measured 2026-09-27)
Full refresh run: 221,227 rows, 125 s, 765 MB peak (of 2,048 MB), 2.9 s cold start.
Kept 2 GB / 10 min on purpose: the daily refresh will grow during heating season
(January 2026 alone had ~80K heat complaints). Sized for January, not September.

## Schedule: daily at 05:00 UTC
City refresh lands ~02:00 UTC (10 PM EDT). If it runs on NYC local time, it shifts to
~03:00 UTC when daylight saving ends. 05:00 UTC clears it in both seasons. Running too
early would only delay data by a day (the watermark catches it next run), never lose it.
## 311 reloads are recurring, not one-time (2026-10-05)
Revises the 2026-09-29 entry. After the retry fix, full-size files (~220K rows) landed on
09-30, 10-02 and 10-04. Watermark values cluster around 01:40 UTC every ~2 days, so the
city republishes nearly the whole dataset on that cadence.
- 09-28 and 09-29 (20,000 and 10,000 rows, exact page multiples) were truncated runs from
  the pagination bug, not normal small days

**Decision:** staging dedupes across ALL raw files (latest `:updated_at` per `unique_key`).
The newest file is not a full snapshot: 1,649 complaints absent from it still exist,
unchanged, in the city's live data (4 checked by hand). Result: 223,707 unique complaints
from 1,138,659 raw rows.

**Known limitation:** a complaint the city truly deletes would stay in staging forever.
Not observed so far. Fix if needed: a periodic job comparing the city's current ID list.

## Lambda retries + CLI timeouts are harmless (2026-10-05)
A manual invoke ran 281 s; the CLI timed out and retried twice. The retries found nothing
newer than the moved watermark and returned 0 rows. Idempotency working as designed.
