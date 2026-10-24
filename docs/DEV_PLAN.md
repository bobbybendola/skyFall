# Dev plan (Cal Hacks 13.0)

Deadline: Sunday 9:00 AM. Roughly 32 hours from Saturday 12:45 AM. Hour marks below are "hours from start".
Rule: do not start a phase's polish until the previous checkpoint passes.

## Roles
- **A** SpacetimeDB module (the backend: queue, trust, replay, feeds), feed-poller
- **B** gx10-compute (sim + vision), GX10 setup (start immediately), worker
- **C** web (map, phone page, animation, panels)
- **D** (optional) sighting-gen, imagine-gen, demo script, sponsor conversations
With two people: A+C and B+D.

Design rule (see ARCHITECTURE.md): if a rule can live in a reducer, it lives in a reducer. Workers and screens stay thin.

## Phase 0: Pre-flight (h0 to h2). Go/no-go
Follow `docs/SETUP.md` sections A and D.
- [x] GitHub repo created (private), PR workflow
- [ ] Space-Track account requested; xAI, Anthropic, Cursor accounts
- [ ] SpacetimeDB CLI installed and `spacetime login` done; maincloud database name chosen
- [ ] GX10 reachable; `docs/GX10_SETUP.md` through the CUDA smoke test

**Checkpoint:** (a) CUDA tensor op passes on the GX10, (b) the module publishes, (c) `noaa_poll` writes `feed_status` (proves outbound HTTP from procedures; if not, the feed-poller takes NOAA/CelesTrak). If (a) fails after 45 minutes, set `USE_GPU=0` and continue.

## Phase 1: Database-first skeleton (h2 to h6)
- [x] `spacetimedb/`: all tables, reducers, scheduled reducers, procedures and the view from ARCHITECTURE.md (typechecks against spacetimedb 2.13)
- [x] `gx10-compute`: `/health`, stub `/classify`, stub `/update` (ground-track corridor that shrinks with sightings, constant scores)
- [ ] Publish; generate bindings for `web/` and `services/gx10-bridge/`
- [ ] `tools/demo-ctl`: register operator, approve workers, seed the replay object, load a script, start/pause/reset
- [ ] `services/gx10-bridge` (worker): heartbeat, claim → compute → `set_verdict` / `publish_corridor`, `fail_job` on errors; `WORKER_TIER=gpu|cpu`
- [ ] `web/`: MapLibre map from `corridor`; pins from `sighting`; `/report` calls `submit_sighting`; worker + queue panel

**Checkpoint:** (1) a phone tap shows a pin and the corridor changes on the big screen within about 2 seconds; (2) kill the GPU worker mid-run and the CPU worker takes over within about 12 seconds with no manual step. This is already a demo.

## Phase 2: Real simulation (h6 to h14)
- [ ] Sampling, propagation, likelihood weighting, corridor extraction on the GPU (see `docs/SIM_SPEC.md`), with per-sighting `trust` and returned `p_inlier` scores
- [ ] `tools/sighting-gen`: truth path from the replay event; a replay script (JSON for `load_replay_script`) with several simulated reporters, some unreliable, 20 to 30% bad reports
- [ ] Scoring script: 90% band area vs number of sightings; truth coverage rate over many runs (uses the private `is_outlier` truth)

**Checkpoint:** on the synthetic case the 90% band shrinks as sightings arrive, still contains the true path at or above the target rate across repeated runs, and unreliable simulated reporters end with lower trust than reliable ones. If coverage fails, tune the likelihood and outlier model first. If it still does not hold, change the story to "reweighting uncertainty" rather than faking a shrink.

## Phase 3: Live feeds and vision (h14 to h22)
- [ ] Verify `noaa_poll` and `celestrak_poll` on the demo host; candidates on the map; space-weather chip
- [ ] `feed-poller`: Space-Track TIP/decay/GP → `ingest_object`, `report_feed_status` (within the request budget in LIVE_DATA_SOURCES.md)
- [ ] `tools/imagine-gen`: ~100 synthetic labeled images (4 classes); keep a held-out test split
- [ ] `/classify` with CLIP-style zero-shot; rejected pins show why
- [ ] Optional: Grok Voice sighting reports (check docs first)

**Checkpoint:** live panels show real data with timestamps from `feed_status`; a plane image is rejected with a visible reason.

## Phase 4: Polish and robustness (h22 to h28)
- [ ] Corridor animation; timeline scrubber and before/after area from `corridor_history`
- [ ] Worker panel: tier, health, variants run, job queue depth, the GPU → CPU switch
- [ ] Replay controls (start/pause/reset, speed) in an operator panel
- [ ] Stretch only: globe view, trust leaderboard

**Checkpoint:** the demo script in `docs/DEMO.md` runs 5 times in a row with no manual fixes.

## Phase 5: Demo and submission (h28 to h31)
- [ ] 60-second backup video of a good run
- [ ] README filled in: real vs simulated, tool use, setup
- [ ] Devpost submitted; MLH categories opted in; repo public if required; no secrets in git history
- [ ] Rehearse the 2-minute script twice

## Cut order if time runs short
1. Globe view  2. Grok Voice  3. Vision classifier  4. Flight-impact overlay  5. Extra panels.
Never cut: pins live on the big screen, the shrinking corridor, the GX10 status panel.

## Decisions to make in the first hour (write the answer here)
- Replay event: _real past re-entry or clearly synthetic object?_
- Named community for the Anthropic track: _e.g. flight dispatchers / sky-watchers_
- Hosting for SpacetimeDB during the demo: _recommended maincloud (phones reach it on any network); local for development_
- Which team member sits where during the pitch.
