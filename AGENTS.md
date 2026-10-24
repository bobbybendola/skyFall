# AGENTS.md: rules for coding agents (Cursor, Grok Bot, Claude)

Project: SKYFALL (see README.md and docs/ARCHITECTURE.md). Read both before editing.

## Ground rules
- SpacetimeDB is the ONLY shared state. Clients, the bridge and the poller write through reducers. No side databases, no direct client-to-GX10 calls.
- `services/gx10-compute` must stay independent of SpacetimeDB (plain HTTP in, JSON out) so it can be tested with curl.
- Table and reducer names are defined in docs/ARCHITECTURE.md. Do not rename them without updating that file in the same change.
- Never commit secrets. `.env` is ignored; add new variable names to `.env.example`.
- Everything simulated must be labeled simulated in code, UI and README. Never present generated images or simulated sightings as real.
- If something in docs is marked "check" (unverified), verify against official docs before relying on it, then update the doc.
- Keep a `docs/TOOL_LOG.md` line when Cursor or Grok does something notable (for the submission write-up).

## Style
- TypeScript strict for `spacetimedb/`, `web/`, `services/*-bridge`, `services/feed-poller`.
- Python 3.11+, type hints, FastAPI for `gx10-compute`.
- Small functions, no premature abstraction. This is a 32-hour build.

## Checkpoints
Each phase in docs/DEV_PLAN.md ends with a concrete test. Do not start the next phase's polish until the checkpoint passes.
