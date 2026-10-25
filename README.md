# SKYFALL

**Predicting what survives when satellites come down: which pieces, how big, and where they land, live on a 3D globe.**

Thousands of satellites now re-enter on short lifetimes, plus rocket stages and old debris. Some pieces survive. Tanks, reaction wheels and engine parts have been found on the ground. Yet the public sees at most an orbit dot, and break-up and survivability analyses stay inside operators and agencies.

SKYFALL tracks every object that is coming down, forecasts when and where it re-enters, then simulates its **break-up on our own GPU** (an ASUS Ascent GX10): how it splits into components, which pieces melt, and which survive, with their mass, impact energy and impact zone as probabilities. **SpacetimeDB** is the whole backend. It fetches the live data itself, chains the GPU jobs (forecast → debris), handles failover to a CPU backup, keeps the archive, and streams every result to the 3D globe in real time.

> Status: Cal Hacks 13.0 project, built during the event. Debris numbers are **modeled estimates** from public data and documented generic component lists ("archetypes"), not operators' internal assessments. Why and how: [docs/PIVOT.md](docs/PIVOT.md).

## Real, modeled, simulated
| Part | Status |
|---|---|
| Orbit elements of decaying objects (CelesTrak; Space-Track if available), space weather (NOAA SWPC) | **Real, live** (fetched by the database) |
| Satellite mass, size, shape, type (GCAT, CelesTrak SATCAT, ESA DISCOSweb) | **Real catalog data** (often estimates in the catalog itself; flagged) |
| Re-entry time and place | **Modeled:** Monte Carlo, J2 + drag, NRLMSIS 2.1 atmosphere, drag calibrated to the observed decay |
| Component lists per satellite class | **Assumed from public sources** (each number cited in `data/archetypes/`) |
| Break-up, heating, survival, impact zones | **Modeled:** lumped-mass heating, 3-DOF flight (see `docs/DEBRIS_MODEL.md`) |
| Validation case | Real re-entry (archived live during the event, or a past case with recovered debris) |

## How it works
1. Scheduled procedures **inside SpacetimeDB** fetch CelesTrak and NOAA; a small poller adds Space-Track and catalog data.
2. Every 20 minutes (or on new data) the database queues a **forecast** job. The GX10 runs tens of thousands of orbit variants per object and publishes re-entry time distributions.
3. For each object likely to come down within 72 h, the database queues a **debris** job. The GX10 breaks the object into its archetype's components and flies each one down through the atmosphere with heating and melting, thousands of times.
4. The **3D globe** subscribes to the results: live objects, falling-debris trajectories, impact zones by material and size, and a per-object breakdown.
5. Unplug the GX10 and the database hands the work to a CPU worker in **degraded mode** (few samples, wide zones), clearly labeled.

Diagram, tables and reducers: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Physics: [docs/SIM_SPEC.md](docs/SIM_SPEC.md) (orbit forecast), [docs/DEBRIS_MODEL.md](docs/DEBRIS_MODEL.md) (break-up and survival).

## Repo map
- `spacetimedb/` server module: the backend
- `services/gx10-compute/` GPU physics (`/forecast`, `/debris`); `services/gx10-bridge/` worker (`WORKER_TIER=gpu|cpu`); `services/feed-poller/`; `services/assistant/` (Grok)
- `web/` 3D globe (`/`)
- `tools/demo-ctl` operator console
- `data/archetypes/`, `data/materials.json` component and material assumptions, with sources
- `docs/` plans and specs. Team: [docs/TEAM_HANDOFF.md](docs/TEAM_HANDOFF.md)

## Honest limits
- Public orbit data is kilometre-accurate, and re-entry timing is uncertain by hours days out. We show distributions and zones, never pinpoints.
- We don't know any operator's internal design. Archetypes are generic and sourced, and results can be wrong for a specific satellite.
- Simplified physics: no winds, no detailed break-up mechanics, tumbling-averaged heating.
- `/debris` (debris-v1) supports spheres, cylinders, boxes and plates with parent/child shielding. Its default mode requires CUDA and refuses to silently run on CPU; `USE_GPU=0` is an explicit degraded mode. Not yet run end to end on the ASUS GX10.

## How we used the tools (fill in before submission)
- SpacetimeDB: the backend: feeds, GPU job chain with failover, archive, live sync of results
- ASUS GX10: forecast + debris Monte Carlo (numbers from `compute_run`)
- Cursor, Grok (Voice / Bot): _log specific uses_
- Claude: _what it did_
