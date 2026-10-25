# Tool log

Notable Cursor and Grok sessions for the submission write-up. One line each.

| When | Tool | What |
|---|---|---|
| 2026-10-25 | Cursor Grok 4.7 | Forecast validation in the SpacetimeDB module: `reentry_outcome`, SATCAT decay fetch, Space-Track path kept disabled without env credentials, `forecast_score`, historical replay loader. Tested on a local throwaway database only. |
| 2026-10-25 | Cursor Grok 4.7 | Demo path for one real debris result and a visible GPU-to-CPU failover banner. Fixed `/debris` so archetype boxes/plates run and the JSON includes `breakup` and `impact` (what `publish_debris` stores). Globe HUD shows DEBRIS LIVE vs MOCK; amber banner follows `compute_status`. Runbook: `docs/DEMO_RUNBOOK.md`. No module publish, no production writes. |
