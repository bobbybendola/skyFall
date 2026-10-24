# AGENTS.md: rules for coding agents (Cursor, Grok Bot, Claude)

Project: SKYFALL, debris prediction on a 3D globe (see README.md, docs/PIVOT.md and docs/ARCHITECTURE.md). Read them before editing.

## Ground rules
- SpacetimeDB is the backend, not just storage. It is the ONLY shared state, and any coordination rule (validation, trust, queueing, leases, failover, scheduling, feed politeness) goes in a reducer or procedure, not in a worker or the UI. Clients, workers and the poller write through reducers. No side databases, no direct client-to-GX10 calls.
- Workers stay stateless: everything they need comes from their subscription, and everything they produce goes through a reducer.
- `services/gx10-compute` must stay independent of SpacetimeDB (plain HTTP in, JSON out) so it can be tested with curl.
- Table and reducer names are defined in docs/ARCHITECTURE.md. Do not rename them without updating that file in the same change.
- Never commit secrets. `.env` is ignored; add new variable names to `.env.example`.
- Everything simulated must be labeled simulated in code, UI and README. Every debris number is labeled "modeled estimate" with its archetype and sources reachable from the UI. Never present modeled, generated or simulated data as observed.
- If something in docs is marked "check" (unverified), verify against official docs before relying on it, then update the doc.
- Keep a `docs/TOOL_LOG.md` line when Cursor or Grok does something notable (for the submission write-up).

## Git
- Branch from fresh `main`, test, open a PR, merge only when tested. Never push to `main` directly. Full workflow and module-publish rules: docs/TEAM_HANDOFF.md section 7.

## Style
- TypeScript strict for `spacetimedb/`, `web/`, `services/*-bridge`, `services/feed-poller`.
- Python 3.11+, type hints, FastAPI for `gx10-compute`.
- Small functions, no premature abstraction. This is a 32-hour build.

## Checkpoints
Each phase in docs/DEV_PLAN.md ends with a concrete test. Do not start the next phase's polish until the checkpoint passes.
