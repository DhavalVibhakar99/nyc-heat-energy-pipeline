## 311 :updated_at: likely a daily bulk republish (found 2026-09-26, revised 2026-09-27)
First looked like a one-off: ~221K rows rewritten on 2026-09-26 around 02:00 UTC.
Next day: ~221K rows again at ~02:00 UTC. So it's most likely a daily republish of a
large window of recent complaints. To confirm with a third day.

**Decisions:**
- Size the Lambda for ~220K rows every run, not a small trickle
- Raw S3 keeps every daily file; dbt staging keeps the latest version per `unique_key`
- Watermark still works: it prevents re-reading within a day and never skips data