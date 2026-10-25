# Tool log

Notable Cursor and Grok sessions for the submission write-up. One line each.

| When | Tool | What |
|---|---|---|
| 2026-10-25 | Cursor Grok 4.7 | Forecast validation in the SpacetimeDB module: `reentry_outcome`, SATCAT decay fetch, Space-Track path kept disabled without env credentials, `forecast_score`, historical replay loader. Tested on a local throwaway database only. |
| 2026-10-25 | Cursor Agent | PR #14: `sim.py` forecast path read `r_reentry` / `v_reentry` (the old `r_re` / `v_re` names raised AttributeError after a finished RK4 batch). Added `services/gx10-compute/bench_forecast.py` to time `Engine.forecast`. |
| 2026-10-25 | Cursor Grok 4.7 | `services/assistant`: read-only SpacetimeDB SQL (forecasts, debris, profiles) plus xAI chat completions with no tools. `search_parameters` is omitted; sending it returned HTTP 410 (live search deprecated). Globe panel says "assistant offline" when the service or `XAI_API_KEY` is missing. Submission write-up filled from git history and the team's Grok Bot notes. |
