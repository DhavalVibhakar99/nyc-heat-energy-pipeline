## 311 :updated_at: likely a daily bulk republish (found 2026-09-26, revised 2026-09-27)
First looked like a one-off: ~221K rows rewritten on 2026-09-26 around 02:00 UTC.
Next day: ~221K rows again at ~02:00 UTC. So it's most likely a daily republish of a
large window of recent complaints. To confirm with a third day.

**Decisions:**
- Size the Lambda for ~220K rows every run, not a small trickle
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