# Dev plan (Cal Hacks 13.0)

Deadline: Sunday 9:00 AM. Roughly 32 hours from Saturday 12:45 AM. Hour marks below are "hours from start".
Rule: do not start a phase's polish until the previous checkpoint passes.

## Roles
- **A** SpacetimeDB module, feed-poller, bridge
- **B** gx10-compute (sim + vision), GX10 setup (start immediately)
- **C** web (map, phone page, animation)
- **D** (optional) sighting-gen, imagine-gen, demo script, sponsor conversations
With two people: A+C and B+D.

## Phase 0: Pre-flight (h0 to h2). Go/no-go
- [ ] Create the GitHub repo, add teammates, push this docs folder
- [ ] Accounts: Space-Track, xAI (Grok), Anthropic, Cursor; install SpacetimeDB CLI
- [ ] GX10 reachable; follow `docs/GX10_SETUP.md` through the CUDA smoke test
- [ ] Space-Track: pull a sample of decay/TIP data; note if live entries exist; save to `data/raw/` (git-ignored)
- [ ] `spacetime dev --template react-ts` runs on a laptop

**Checkpoint:** (a) CUDA tensor op passes on the GX10, (b) one real Space-Track response saved, (c) the SpacetimeDB template runs. If (a) fails after 45 minutes, set `USE_GPU=0` and continue; revisit later.

## Phase 1: Skeleton end to end (h2 to h6)
- [ ] `spacetimedb/`: tables + `submit_sighting`, `ingest_object`, `publish_corridor`, replay controls (names per ARCHITECTURE.md)
- [ ] `web/`: MapLibre map with a hard-coded corridor; then corridor from the `corridor` row; `/report` page inserts a sighting; pins appear live
- [ ] `gx10-compute`: `/health` plus a stub `/update` returning a fake shrinking polygon
- [ ] `gx10-bridge`: subscribe → stub compute → `publish_corridor`

**Checkpoint:** a phone tap shows a pin and the corridor changes on the big screen within about 2 seconds. This is already a demo.

## Phase 2: Real simulation (h6 to h14)
- [ ] Sampling, propagation, likelihood weighting, corridor extraction on the GPU (see `docs/SIM_SPEC.md`)
- [ ] `tools/sighting-gen`: truth path from the replay event; noisy sightings with 20 to 30% bad reports
- [ ] Scoring script: 90% band area vs number of sightings; truth coverage rate over many runs

**Checkpoint:** on the synthetic case the 90% band shrinks as sightings arrive, and still contains the true path at or above the target rate across repeated runs. If not, tune the likelihood and outlier model first. If it still does not hold, change the story to "reweighting uncertainty" rather than faking a shrink.

## Phase 3: Live feeds and vision (h14 to h22)
- [ ] `feed-poller`: TIP/decay, CelesTrak GP, NOAA SWPC → reducers; feed status panel
- [ ] `tools/imagine-gen`: ~100 synthetic labeled images (4 classes); keep a held-out test split
- [ ] `/classify` with CLIP-style zero-shot; bridge sets verdicts with a reason; rejected pins show why
- [ ] Optional: Grok Voice sighting reports (check docs first)

**Checkpoint:** live panels show real data with timestamps; a plane image is rejected with a visible reason.

## Phase 4: Polish and robustness (h22 to h28)
- [ ] Corridor animation, before/after area readout, GX10 status panel, replay timeline
- [ ] "Auto-fire sightings" button; offline-capable mode
- [ ] Failure handling per ARCHITECTURE.md
- [ ] Stretch only: globe view

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
- Hosting for SpacetimeDB during the demo: _local on a laptop or maincloud (check docs)_
- Which team member sits where during the pitch.
