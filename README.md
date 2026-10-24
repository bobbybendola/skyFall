# SKYFALL

**A live re-entry tracker where a crowd and a GPU shrink the danger zone.**

About once a week a satellite or rocket stage falls back to Earth uncontrolled. Even in its last orbit or two, the predicted landing time can be off by hours, so authorities close wide strips of airspace to be safe (a 2022 rocket-stage re-entry over Spain led to 300+ delayed, cancelled or rerouted flights, per [Space.com](https://space.com/space-exploration/satellites/the-risk-of-falling-space-junk-hitting-airplanes-is-on-the-rise-experts-warn)).

SKYFALL lets people report what they see. Every report is shared instantly through SpacetimeDB, and an ASUS Ascent GX10 re-simulates thousands of orbit variants on each report, so the predicted corridor visibly shrinks for everyone watching.

> Status: Cal Hacks 13.0 project. Built during the event. Hypothesis, not a proven result: real sightings tighten real predictions. We test the method on a replay with a known true path.

## What is real vs simulated
| Part | Status |
|---|---|
| Re-entry watchlist (Space-Track), orbit elements (CelesTrak), space weather (NOAA SWPC) | Real, live |
| The demo re-entry event | **Replay** of a past event with a known path |
| Sightings during the demo | **Simulated** (noisy, with bad reports mixed in) plus teammates' real taps tagged `DEMO` |
| Test images for the vision step | **Synthetic**, generated with Grok Imagine |
| Orbit simulation | Simplified (two-body + J2 + decay), not a full force model |

## How it works
1. `feed-poller` pulls live feeds and writes them to SpacetimeDB.
2. Phones submit sightings through the `submit_sighting` reducer.
3. `gx10-bridge` (on the GX10) sees new sightings, asks `gx10-compute` to classify them and to update the corridor, and writes results back with reducers.
4. The big-screen map and every phone subscribe to the tables, so all views update together.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram, tables and reducers.

## Repo map
- `spacetimedb/` server module (tables, reducers)
- `web/` React app: big-screen map (`/`) and phone sighting page (`/report`)
- `services/feed-poller`, `services/gx10-bridge`, `services/gx10-compute`
- `tools/sighting-gen`, `tools/imagine-gen`
- `data/replay`, `data/synthetic-images`
- `docs/` plans and specs

## Quickstart (fill in as built)
```bash
# prerequisites: Node 18+, SpacetimeDB CLI (spacetimedb.com/install), Python 3.11+ with uv
cp .env.example .env            # add your own keys
spacetime dev --template react-ts   # see docs/DEV_PLAN.md Phase 0/1 for how this repo uses it
```
GX10 setup: [docs/GX10_SETUP.md](docs/GX10_SETUP.md). Demo steps: [docs/DEMO.md](docs/DEMO.md).

## Honest limits
- Public orbit data is only kilometre-accurate. We narrow a corridor; we never claim a pinpoint.
- The GPU work is a physics simulation plus a vision model, not an LLM.
- The vision step is tested on synthetic images, so it validates the pipeline, not real-world accuracy.

## How we used the tools (fill in before submission)
- Cursor: _log specific uses_
- Grok (Imagine / Voice / Bot): _log specific uses_
- SpacetimeDB: _what is shared state, what the reducers enforce_
- Claude (if used): _the one job it does and where it could go wrong_
