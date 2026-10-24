# SKYFALL

**A live re-entry tracker where a crowd and a GPU shrink the danger zone.**

About once a week a satellite or rocket stage falls back to Earth uncontrolled. Even in its last orbit or two, the predicted landing time can be off by hours, so authorities close wide strips of airspace to be safe (a 2022 rocket-stage re-entry over Spain led to 300+ delayed, cancelled or rerouted flights, per [Space.com](https://space.com/space-exploration/satellites/the-risk-of-falling-space-junk-hitting-airplanes-is-on-the-rise-experts-warn)).

SKYFALL lets people report what they see. SpacetimeDB is the whole backend: it validates each report, weighs reporters by their track record, queues work for an ASUS Ascent GX10 (with automatic CPU failover), fetches live space weather and decaying-object data itself, and versions every corridor. The GX10 re-simulates thousands of orbit variants on each report, so the predicted corridor visibly shrinks for everyone watching.

> Status: Cal Hacks 13.0 project. Built during the event. Hypothesis, not a proven result: real sightings tighten real predictions. We test the method on a replay with a known true path.

## What is real vs simulated
| Part | Status |
|---|---|
| Re-entry watchlist (Space-Track TIP), decaying-object candidates and elements (CelesTrak), space weather (NOAA SWPC) | Real, live |
| The demo re-entry event | **Replay** of a past event with a known path |
| Sightings during the demo | **Simulated** (`SIM`: emitted by the replay script, noisy, with bad reports mixed in) plus teammates' real taps tagged `DEMO` |
| Test images for the vision step | **Synthetic**, generated with Grok Imagine |
| Orbit simulation | Simplified (two-body + J2 + decay), not a full force model |

## How it works
1. Phones submit sightings through the `submit_sighting` reducer. The module validates and rate-limits them and turns each one into a job in the `compute_job` queue.
2. A worker on the GX10 claims the job (the module grants a lease to exactly one worker), runs the simulation on `gx10-compute`, and publishes the corridor with a reducer. If the GX10 goes silent, the module expires its lease and a CPU worker takes over.
3. The module versions the corridor, keeps its history, and updates each reporter's trust from the simulation's consistency scores.
4. Scheduled procedures inside the module fetch NOAA SWPC and CelesTrak. A small poller handles Space-Track (login required). The replay clock that emits simulated sightings also runs inside the module.
5. The big-screen map and every phone subscribe to the tables, so all views update together.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram, tables and reducers.

## Repo map
- `spacetimedb/` server module: the backend (tables, reducers, scheduled jobs, feed fetchers, views)
- `web/` React app: big-screen map (`/`) and phone sighting page (`/report`)
- `services/gx10-bridge` (worker, `WORKER_TIER=gpu|cpu`), `services/gx10-compute`, `services/feed-poller` (Space-Track only)
- `tools/demo-ctl` operator console, `tools/sighting-gen`, `tools/imagine-gen`
- `data/replay`, `data/synthetic-images`
- `docs/` plans and specs

## Quickstart (fill in as built)
```bash
# prerequisites: Node 22+, SpacetimeDB CLI (spacetimedb.com/install), Python 3.11+ with uv
cp .env.example .env            # add your own keys
# accounts, CLI install, publish and first-run steps: docs/SETUP.md
```
GX10 setup: [docs/GX10_SETUP.md](docs/GX10_SETUP.md). Demo steps: [docs/DEMO.md](docs/DEMO.md).

## Honest limits
- Public orbit data is only kilometre-accurate. We narrow a corridor; we never claim a pinpoint.
- The GPU work is a physics simulation plus a vision model, not an LLM.
- The vision step is tested on synthetic images, so it validates the pipeline, not real-world accuracy.

## How we used the tools (fill in before submission)
- Cursor: _log specific uses_
- Grok (Imagine / Voice / Bot): _log specific uses_
- SpacetimeDB: the backend. Shared state, sighting rules and rate limits, reporter trust, the GPU job queue with leases and CPU failover, corridor history, the replay clock, and NOAA/CelesTrak fetching as scheduled procedures. See docs/ARCHITECTURE.md
- Claude (if used): _the one job it does and where it could go wrong_
