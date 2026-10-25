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
1. Scheduled procedures **inside SpacetimeDB** fetch CelesTrak and NOAA. Space-Track and the large catalog downloads are planned for `services/feed-poller`, which is not in the repo yet.
2. Every 20 minutes (or on new data) the database queues a **forecast** job. The GX10 runs tens of thousands of orbit variants per object and publishes re-entry time distributions.
3. For each object likely to come down within 72 h, the database queues a **debris** job. The GX10 breaks the object into its archetype's components and flies each one down through the atmosphere with heating and melting, thousands of times.
4. The **3D globe** subscribes to the results: live objects, falling-debris trajectories, impact zones by material and size, and a per-object breakdown.
5. Unplug the GX10 and the database hands the work to a CPU worker in **degraded mode** (few samples, wide zones), clearly labeled.

Diagram, tables and reducers: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Physics: [docs/SIM_SPEC.md](docs/SIM_SPEC.md) (orbit forecast), [docs/DEBRIS_MODEL.md](docs/DEBRIS_MODEL.md) (break-up and survival).

## Repo map
- `spacetimedb/` server module: the backend
- `services/gx10-compute/` GPU physics (`/forecast`, `/debris`); `services/gx10-bridge/` worker (`WORKER_TIER=gpu|cpu`); `services/assistant/` Grok chat over the live tables (read-only HTTP)
- `services/feed-poller/` is planned (Space-Track and large catalogs). It is not in the repo.
- `web/` 3D globe (`/`)
- `tools/demo-ctl` operator console
- `data/archetypes/`, `data/materials.json` component and material assumptions, with sources
- `docs/` plans and specs. Team: [docs/TEAM_HANDOFF.md](docs/TEAM_HANDOFF.md)

## Assistant
Text chat on the globe. It reads `reentry_object`, `forecast`, `debris_forecast`, `debris_component`, `satellite_profile`, and `space_weather`, then asks Grok. The xAI key stays in this process. The globe still loads if you skip it.

```bash
# repo root .env has XAI_API_KEY (see .env.example). Never commit the key.
cd services/assistant && npm install && npm start   # http://127.0.0.1:8787
cd web && npm run dev                               # http://localhost:5173  proxies /api/assistant
```

Open the globe and use **Ask Grok**. `POST /ask` with `{ "question": "What's coming down in the next 24 hours?" }` returns an answer grounded in those tables. Debris figures are modeled estimates. If the process is down or `XAI_API_KEY` is empty, the button says **assistant offline**. Voice is not included. `XAI_MODEL` defaults to `grok-4.7`.

## Honest limits
- Public orbit data is kilometre-accurate, and re-entry timing is uncertain by hours days out. We show distributions and zones, never pinpoints.
- We don't know any operator's internal design. Archetypes are generic and sourced, and results can be wrong for a specific satellite.
- Simplified physics: no winds, no detailed break-up mechanics, tumbling-averaged heating.
- The initial `/debris` implementation supports spheres and cylinders only. Its default mode requires CUDA and refuses to silently run on CPU; `USE_GPU=0` is an explicit degraded mode. The API has not yet been connected to the SpacetimeDB DEBRIS job flow or run on the ASUS GX10.

## How we used the tools
- **SpacetimeDB:** the backend. Scheduled procedures fetch NOAA and CelesTrak. Reducers queue forecast and debris jobs, lease them, fail over from GPU to CPU, archive element sets and forecasts, and stream results to every globe. Forecast validation (`reentry_outcome`, `forecast_score`) lives in the module too.
- **ASUS GX10:** forecast and debris Monte Carlo (`services/gx10-compute`). Run counts are the `compute_run` rows, not a slide.
- **Cursor (core coding agent):**
  - [PR #23](https://github.com/bobbybendola/skyFall/pull/23) (merged as `6bed3fc`, co-authored by Cursor Agent, Christopher-Chhim, and Steven Kuzhipala). Added `reentry_outcome` and `forecast_score`, the CelesTrak SATCAT decay fetch for NORAD ids already in `elements_history` (at most 4 per 2 hours, not repeated for 24 hours), and a Space-Track path that stays disabled unless database env credentials are set (no login is attempted when they are missing). `load_replay_case` forces `replay=true`. `data/replay/historical-cases.json` cites Delta II 1997 (NORAD 23852) and Falcon 9 R/B 2021 (NORAD 47782) and does not invent element sets. Tested on a local throwaway database only, not published to maincloud from that PR.
  - [PR #14](https://github.com/bobbybendola/skyFall/pull/14) (`cursor/bench-forecast-vs-grok-3315`, commits `3f269dd` and merge `56f196c`, authored by Cursor Agent, co-authored by Christopher-Chhim). A finished RK4 batch raised `AttributeError` because `sim.py` read `r_re` / `v_re` after propagation had been renamed to `r_reentry` / `v_reentry`, so forecasts never published. The same change added `services/gx10-compute/bench_forecast.py`, which times `Engine.forecast` (drag calibration, the RK4 batch, and corridor extraction) and leaves process startup out of the clock.
  - [PR #36](https://github.com/bobbybendola/skyFall/pull/36): `services/assistant` (read-only SQL against the live tables, xAI chat completions with no tools attached) and the Ask Grok panel, which shows **assistant offline** when the service or key is absent.
- **Grok Bot (an agent the team named Nori):** matched SKYFALL against the Cal Hacks prize list and picked target tracks; set up teammate agents **SKYFALL Deploy** (Vultr deployment and a GoDaddy domain, with a deploy log and spend guardrails) and **DB** (the SpacetimeDB backend, with publishing and deletion guardrails); designed the hindcast (frozen inputs at T-72h through T-6h, validation tables, a scorecard and replay); generated UI mockups of the dashboard and the upgraded globe; reviewed the repo and wrote a ranked plan for the last hours; and launched Cursor cloud agents for the final demo work (this assistant and write-up, and the live-debris / failover-banner work). The product also calls Grok through `services/assistant`.
- **Grok Voice:** not wired. `docs/SPONSORS.md` still says the SpaceXAI track asks for Grok Imagine or Voice. TODO for the team: confirm the current prize page, and whether chat completions is enough.
- **Hindcast ladder:** Grok Bot's T-72h..T-6h schedule is not a job in the module. What shipped is `forecast_score` (latest `forecast_history` row with `computed_at` before the official decay) and replay forecasts via `as_of`. TODO for the team if the submission should describe the ladder as built.
- **Claude:** `docs/SESSION_CONTEXT.md` and `CLAUDE.md` (commit `0276b7c`, Steven Kuzhipala) exist so a Claude Code session can continue from the laptop chat. Git does not attribute implementation commits to Claude (team rule: no Claude co-author trailer). TODO for the team: say which parts Claude wrote versus what Steven Kuzhipala, Kevin, and Christopher-Chhim committed under their own names.
