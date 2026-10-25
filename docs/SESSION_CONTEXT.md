# Session context: handoff from the laptop Claude Code chat

Written 2026-10-24 so a new Claude Code session (for example on the GX10) can continue the work without the original chat. Main was at `d9719e4` (PR #8 merged) when this was written. The other docs in `docs/` hold the details. This file is the summary and the to-do list.

## The project
- **SKYFALL**, for Cal Hacks 13.0. Due **Sunday 2026-10-25, 9:00 AM PT**.
- **The pitch, after the team talked to SpaceX:** predict which pieces of a re-entering satellite survive, their size and material, and where they land. Shown on a 3D Cesium globe, computed on the ASUS GX10, and streamed through SpacetimeDB.
- It must not be "just a data visualizer": the physics and the database logic are the core.
- **Repo:** https://github.com/bobbybendola/skyFall
- **Live database:** SpacetimeDB maincloud, module `skyfall-calhacks`.

## Standing rules (from Steven)
- Branch from fresh `main` → test → open a PR → merge. **Never push to `main` directly.**
- **No `Co-Authored-By: Claude`** (or any Claude attribution) in commits or PRs.
- Never commit secrets. `.env` is git-ignored; add new variable names to `.env.example`.
- Label every simulated or mock value as such. Debris numbers are labeled "modeled estimate".
- **Space-Track:**
  - There is one account. Never share its login. Credentials live only in `.env` on Steven's machine.
  - Never type passwords yourself.
  - Stay far under the limits (< 30 requests/min, < 300/hr): gp hourly, satcat and decay daily, tip hourly (every 10 min when an object is < 12 h out).
  - No scraping; respect site terms.
- Don't contact Orbital Radar without Steven's go-ahead.
- Pause and ask Steven on major architecture or feature decisions.
- Tell the team before publishing the module. Never use `spacetime publish --delete-data` without asking.

## Stack
| Part | Path | Tech |
|---|---|---|
| Backend | `spacetimedb/src/index.ts` | SpacetimeDB 2.13 TypeScript module on maincloud |
| Physics | `services/gx10-compute` | Python FastAPI: `app.py`, `sim.py` (SGP4 + RK4 with J2 + drag, NRLMSIS 2.1 via pymsis, Monte Carlo, PyTorch on GPU) |
| Worker | `services/gx10-bridge` | Node/TS; claims jobs from SpacetimeDB, calls compute, publishes results |
| Operator console | `tools/demo-ctl` | Node/TS CLI (`npm start -- <cmd>`) |
| Web | `web` | React + Vite 8 + CesiumJS 1.146 (globe at `/`), satellite.js 7, MapLibre 2D prototype at `/2d` |
| Data | `data/archetypes`, `data/materials.json` | Satellite archetypes and materials; values marked ASSUMED or CHECK |

## How SpacetimeDB is used
- **Tables:**
  - objects: `reentry_object`, `satellite_profile`, `archetype`
  - results: `forecast`, `debris_forecast` with child tables `debris_component` and `debris_track`
  - archives: `elements_history`, `forecast_history`, `debris_history`, `corridor_history`
  - feeds: `space_weather`, `feed_status`
  - compute: `compute_job`, `compute_status`, `compute_run`
  - private: `worker_registry`
- **Reducers** enforce roles (operator, poller, worker) through `worker_registry`.
- **Job queue:** `claim_job` runs two lanes:
  - bulk: FORECAST, with a 15 min lease
  - fast: CLASSIFY / UPDATE / DEBRIS, with a 60 s lease
- **GPU → CPU failover:** CPU workers get no work while a healthy GPU worker exists.
- **Chaining:** `publish_forecast` versions and archives the result, then queues DEBRIS jobs for objects with p ≥ 0.2 within 72 h. The worker answers them with `publish_debris`.
- **Scheduled `sweep`, every 2 s:**
  - requeues jobs whose lease expired or whose worker is down
  - marks heartbeats stale after 10 s and forgets workers after 10 min
  - queues a FORECAST every 20 min
- **Scheduled procedures with outbound HTTP:**
  - `noaa_poll` (Kp and F10.7, every 15 min)
  - `celestrak_poll` (SPECIAL=DECAYING, every 2 h)
  - `poll_feeds_now`: the operator's manual trigger
- **Clients:** subscriptions plus generated bindings. The web uses `useTable` and the worker uses `DbConnection`.

## What is real vs mock right now
- **Real:**
  - orbits (CelesTrak elements, SGP4)
  - space weather (NOAA)
  - re-entry forecasts (`sim.py` Monte Carlo)
  - job queue and failover (tested: sighting → corridor in 0.39 s; failover in 7 s)
- **Mock (labeled MOCK in the UI):** debris pieces and landing zones (`web/src/mock/debris.ts`). They switch to live data as soon as `/debris` exists. The tables, the DEBRIS jobs and the worker handler (`runDebris`) are already built.
- **Known bias:** TIP checks showed our forecasts run 7–11 h late. Calibrating on MEAN_MOTION_DOT lags the final acceleration of decay.

## Next steps, in order
1. **`/debris` physics** on branch `feat/debris-physics`. Follow `docs/DEBRIS_MODEL.md`.
   - `sim.py` keeps position and velocity at 80 km (breakup).
   - New `debris.py`:
     - lumped-mass heating (Sutton–Graves)
     - 3-DOF flight per component
     - demise or survival
     - impact footprints (50/90 % bands)
     - sample tracks
   - Return the shape in `web/src/globe/debrisTypes.ts`.
   - CPU first, then GX10.
2. **Space-Track feed poller** (TIP + gp), within the limits above. Then the **TIP-anchored forecast fix**: calibrate from recent element sets and condition on TIP.
3. Teammates: globe tasks G2 (lines and zones), G3 (animation and camera), G4 (panels). See `docs/GLOBE_TASKS.md`.
4. Still open: approve the GX10 worker, the 4th sponsor track, the .Tech domain, Vultr hosting.

## Running it (GX10 or laptop)
Install steps: `docs/GX10_SETUP.md`. The GX10 is ARM64, so use the `cu130` PyTorch build. Copy `.env` by hand; it is never in git.

Start in four terminals:

```bash
# 1. Compute
cd services/gx10-compute && source .venv/bin/activate && uvicorn app:app --host 127.0.0.1 --port 8000
# 2. Worker (WORKER_TIER=gpu in .env)
cd services/gx10-bridge && npm start
# 3. Approve the new worker once, then kick off a forecast
cd tools/demo-ctl && npm start -- approve <identity> && npm start -- forecast
# 4. Web
cd web && npm run dev    # http://localhost:5173
```

`demo-ctl` finds the operator identity in `OPERATOR_TOKEN` or in `~/.config/spacetime/cli.toml` (after `spacetime login`). Check it with `npm start -- whoami`.

## Gotchas already hit
- NOAA sends F10.7 as a one-element array. The poller accepts an array or an object.
- `spacetime call` needs `--` before negative-number arguments.
- SpacetimeDB SQL rejects `GROUP BY`. Run a plain SELECT and aggregate outside.
- For fast decayers, calibrate drag over a 3-orbit span.
- SGP4 error 1 on an object → status `likely_reentered`.
- Vite plus a MapLibre/satellite.js worker: `setWorkerUrl` with `?url`, and `worker.format='es'`.
- Windows: demo-ctl must disconnect before it exits (libuv assertion).
