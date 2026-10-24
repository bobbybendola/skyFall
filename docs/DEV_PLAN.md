# Dev plan (Cal Hacks 13.0), after the debris pivot

New teammate? Start with `docs/TEAM_HANDOFF.md`, then `docs/PIVOT.md`.
**Deadline: Sunday 9:00 AM PT.** Code freeze 7:30 AM. Times below are PT.
Rule: don't start polish before the block's checkpoint passes. Every task is a branch → test → PR → main.

## Done (reused)
- [x] SpacetimeDB backend on maincloud: job queue, two lanes, leases, GPU→CPU failover, feeds (NOAA, CelesTrak) inside the DB, archives
- [x] Worker, operator console, compute service
- [x] Forecast engine (`sim.py`): all ~71 decaying objects, NRLMSIS, drag calibration; ran end to end on CPU (76 s)
- [x] Web data layer (subscriptions); 2D prototype (to be replaced)
- [x] Element + forecast archive running since Oct 24 ~11:00 PT

## Block 1, 14:00–18:00: contracts and skeletons in parallel
- [ ] **Schema (R3):** `satellite_profile`, `archetype`, `debris_forecast`, `debris_component`, `debris_track`, `debris_history`; `DEBRIS` job kind; `ingest_profile`, `upsert_archetype`, `publish_debris`, `request_debris`; `publish_forecast` queues DEBRIS. Publish, regenerate bindings, merge **first**, since everyone builds on it
- [ ] **Archetypes (R3):** 6 JSON files in `data/archetypes/` + `data/materials.json`, every number sourced; `demo-ctl seed-archetypes`
- [ ] **Physics v0 (R2):**
  - `sim.py` keeps the state at 80 km per particle
  - `/debris` with lumped heating for spheres and cylinders
  - unit checks (an aluminium sphere demises, a titanium tank survives)
  - runs on CPU
- [ ] **Globe v0 (R1):** CesiumJS in `web/`, offline imagery, live objects from `reentry_object` (SGP4) with altitude, "coming down next" panel ported, click → select
- [ ] **GX10 (R2 or whoever has it):** first GPU forecast run; send timings

**Checkpoint 1 (18:00):**
- the globe shows the live objects and forecasts from the DB
- `/debris` returns a plausible breakdown for one real object on CPU
- archetypes are in the DB
- the GX10 has run one forecast

## Block 2, 18:00–23:00: debris end to end on the GPU
- [ ] Worker handles DEBRIS: profile + archetype + elements → `/debris` → `publish_debris` (R3 or R2)
- [ ] Physics v1: boxes and plates, parent–child release, impact energy, footprints, sample tracks, batched on CUDA (R2)
- [ ] Globe: falling tracks animated on the clock, impact zones by material/size, breakdown panel, degraded banner, compute panel (R1)
- [ ] Profiles: GCAT satcat + CelesTrak SATCAT ingest for every tracked object → archetype match (R3)

**Checkpoint 2 (23:00):**
- a new forecast automatically produces debris for the top objects on the GX10, and the globe animates it
- killing the GX10 worker → CPU degraded run → banner appears

## Block 3, 23:00–03:00: depth and credibility
- [ ] Validation: pick a re-entry from this weekend (archive) or a past recovered-debris case; panel comparing our forecast and footprint hours before with what happened (R4)
- [ ] Tracked debris clouds from CelesTrak groups on the globe (R3 + R1)
- [ ] Grok assistant + Grok Voice, answering from tables only (R4)
- [ ] GPU performance: CUDA graphs or `torch.compile` for the RK4 loops; raise particles (R2)

**Checkpoint 3 (03:00):** the validation panel shows real numbers; asking the assistant "what's coming down near Berkeley this week, and does any of it survive?" gets a sourced answer.

## Block 4, 03:00–06:00: hosting, design, stretch
- [ ] Vultr: web build + CPU worker + compute (`USE_GPU=0`); .Tech domain; QR code (R4)
- [ ] Claude Design pass on the globe UI (R1)
- [ ] Stretch: NASA SBM in-orbit breakup what-if (`/fragment`) (R2)
- [ ] Stretch: casualty risk with population density

## Block 5, 06:00–09:00: demo and submission
- [ ] Demo script (`docs/DEMO.md`) 5× clean; 60 s backup video
- [ ] README: real vs modeled vs simulated; sources; limits; tool use per track
- [ ] Slide deck (after the demo works)
- [ ] Devpost submitted, tracks opted in, repo public if required; **submit by 8:30**

## Cut order if late
1. In-orbit breakup what-if  2. Casualty risk  3. Debris clouds  4. Voice (keep text assistant)  5. Design pass
**Never cut:** live objects on the globe, GPU debris prediction for real objects, falling-debris animation with impact zones, degraded-mode failover, the "modeled estimate" labels.

## Decisions (write the answer here)
- Globe library: _CesiumJS recommended_
- Validation case: _this weekend's re-entry if one comes down with good data; else a past recovered-debris case_
- 4th sponsor track: _Anthropic or Mana_
- Team roles: see TEAM_HANDOFF.md §9
