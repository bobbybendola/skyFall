# SKYFALL team handoff

Read this first. It is enough to pick up any task without asking Steven. Deeper detail lives in the files linked from each section.

Cal Hacks 13.0, Oct 23–25 2026. **Devpost submission due Sunday 9:00 AM.**
Repo: https://github.com/bobbybendola/skyFall (private for now).

---

## 1. What we are building (30-second version)

**Pivot on Oct 24, after talking to SpaceX.** Full reasoning and scope: `docs/PIVOT.md`.

**SKYFALL predicts what survives when satellites come down: which pieces, how big, what they're made of, and where they land, live on a 3D globe and computed on our own GPU.**

1. Real orbit data (CelesTrak, Space-Track), real space weather (NOAA) and real catalog data about each satellite's mass, size and shape (GCAT, SATCAT, DISCOSweb) flow into **SpacetimeDB**.
2. The **ASUS GX10** forecasts when and where each decaying object re-enters (Monte Carlo over orbit and atmosphere uncertainty).
3. For every object likely to come down soon, the GX10 then simulates its **break-up**:
   - the satellite splits into components from a documented "archetype" (tanks, reaction wheels, panels, structure)
   - each piece flies through the atmosphere, heats up and melts or survives
   - outputs: survival chance, mass, impact zone and impact energy per piece
4. Everything streams through SpacetimeDB to a **3D globe**: live objects, falling-debris trajectories, impact zones, and a per-object breakdown. If the GX10 is unplugged, a backup worker runs a much smaller, visibly degraded model.

**Honesty rules:**
- We don't have operators' internal designs, so every debris number is a **modeled estimate**, with its archetype and sources one click away.
- We show probabilities and zones, never a pinpoint.
- Anything simulated or replayed is labeled.

---

## 2. Status (updated Oct 24, ~14:00 PT)

| Area | State |
|---|---|
| SpacetimeDB module (`spacetimedb/`) | **Live on maincloud** as `skyfall-calhacks`. Queue, two lanes, failover, NOAA + CelesTrak feeds, forecasts, archives. Debris tables **not built yet** (contract in ARCHITECTURE.md) |
| Forecast engine (`services/gx10-compute/sim.py`) | Done; ran on CPU for all 71 objects. Not yet run on the GX10 |
| Debris model (`/debris`) | **Spec only** (`docs/DEBRIS_MODEL.md`) |
| Worker, operator console | Done for FORECAST; DEBRIS handler to add |
| Web | 2D prototype (MapLibre) with live forecasts. **To be replaced by the 3D globe** |
| Crowd sightings, replay, corridor | Parked (code stays, not in the demo) |
| Archive | Element sets and forecasts archived since ~11:00 PT, for validating a real re-entry this weekend |

---

## 3. Decisions already made (don't reopen without Steven)

- **SpacetimeDB is the backend**, not just storage. Every rule lives in a reducer or procedure; workers and pages are thin. See `AGENTS.md`.
- **Debris focus: re-entry break-up** (pieces reaching the ground). In-orbit breakup clouds are a stretch.
- **Archetypes, not designs:** about 6 documented component lists per satellite class, every number sourced; outputs labeled "modeled estimate".
- **The GX10 does the heavy work:** forecasts for all objects + debris Monte Carlo per object. CPU fallback = degraded mode, shown on screen.
- **Hosting:** free .Tech domain (MLH) + Vultr server for the web build and the CPU fallback worker.
- **Design and slides** after the prototype works (Claude Design).
- **Database:** `skyfall-calhacks` on maincloud.

**Open decisions:** globe library (CesiumJS recommended), validation case, 4th sponsor track (Anthropic or Mana), exact domain name.

---

## 4. Sponsor tracks we're entering

Details: `docs/SPONSORS.md`.

| Track | What judges need to see |
|---|---|
| **SpacetimeDB** (core) | SpacetimeDB as the real-time backend: GPU job queue with failover, forecasts → debris jobs chained by reducers, live sync of large result sets to every globe |
| **SpaceXAI "Make it Legendary"** | Built with **Cursor**; **Grok Voice** assistant ("what's coming down near me, does any of it survive?"); real space data; directly relevant to constellation operators |
| **MLH A-Team** | Cursor as the main coding agent + Grok Bot for planning, described in the Devpost write-up |
| **4th: Anthropic or Mana.space** | TBD |
| **MLH .Tech domain, MLH Best Use of Vultr** | Domain → site; Vultr hosts the site and the degraded backup worker |

**Everyone:** do real work in **Cursor** and log notable Cursor or Grok uses in `docs/TOOL_LOG.md`.

---

## 5. How it fits together

See the diagram in `docs/ARCHITECTURE.md`. In short:
- CelesTrak / NOAA → fetched by the database itself → `reentry_object`, `space_weather`.
- Every 20 min (or on new data) a FORECAST job → GPU → `forecast`.
- `publish_forecast` queues a DEBRIS job for each object likely to re-enter within 72 h → GPU `/debris` → `publish_debris` → `debris_forecast`, `debris_component`, `debris_track`.
- The 3D globe subscribes to those tables and animates them.
- **Failover is a database rule:** CPU workers only get jobs while no healthy GPU worker exists; `sweep` requeues a dead worker's jobs.

---

## 6. Repo map

| Path | What it is | Language |
|---|---|---|
| `spacetimedb/src/index.ts` | The backend: all tables, reducers, scheduled jobs, feed fetchers | TypeScript |
| `services/gx10-compute/app.py`, `sim.py` | GPU physics over plain HTTP: `/forecast` (built), `/debris` (planned, `debris.py`), `/fragment` (stretch); never touches the DB | Python, FastAPI, PyTorch |
| `services/gx10-bridge/src/worker.ts` | Stateless worker: claim job → call compute → write result | TypeScript (Node 22) |
| `tools/demo-ctl/src/ctl.ts` | Operator console: approve workers, seed, replay controls, status | TypeScript |
| `web/src/` | Today: 2D prototype (`BigScreen.tsx`, `MapView.tsx`). Planned: CesiumJS 3D globe; `orbit.ts` (SGP4) and `live.ts` (helpers) are reused | React, Vite, CesiumJS |
| `*/src/module_bindings/` | **Generated** client code. Never edit by hand; regenerate (section 8) | — |
| `data/archetypes/`, `data/materials.json` (planned) | Component lists per satellite class and material properties, every number sourced | JSON |
| `data/replay/` | Parked placeholder replay | JSON |
| `docs/` | `PIVOT` (why/scope/reuse), `ARCHITECTURE` (contract), `DEBRIS_MODEL`, `SIM_SPEC`, `DEV_PLAN`, `SETUP`, `DATA_SOURCES`, `LIVE_DATA_SOURCES`, `SPONSORS`, `DEMO`, `GX10_SETUP` | — |

---

## 7. Git workflow (everyone, every change)

**Never push to `main` directly.** `main` must always run.

1. Start from fresh main:
   ```bash
   git checkout main && git pull
   git checkout -b <type>/<short-name>     # e.g. feat/all-object-corridors, fix/report-tap, docs/demo-script
   ```
2. Commit small, clear commits. No secrets (`.env` is ignored; add new variable *names* to `.env.example`).
3. **Test before you push** (whatever applies to what you touched):
   ```bash
   cd spacetimedb && npm run typecheck
   cd services/gx10-bridge && npx tsc --noEmit
   cd web && npm run typecheck && npm run build
   cd services/gx10-compute && python -m py_compile app.py && curl -s localhost:8000/health
   ```
   Plus the relevant checkpoint in `docs/DEV_PLAN.md` (e.g. tap → corridor still updates).
4. Push and open a PR:
   ```bash
   git push -u origin <branch>
   gh pr create --fill --base main
   ```
   In the PR description: what changed, how you tested it, and anything simulated.
5. **Merge to main only after it's tested.** One teammate glances at it if anyone's free; at 4 AM, self-merge is fine if the checks pass.
6. **Module changes are special.** The database is shared and live, so publishing affects everyone immediately.
   - Only publish a module change from a branch once it typechecks, and tell the team in chat first.
   - Prefer adding columns/tables over renaming.
   - A breaking change can wipe data (`spacetime publish` will warn you). Ask Steven before using `--delete-data`.
   - After publishing, regenerate bindings (section 8) and commit them in the same PR.

---

## 8. Running things

Full version: `docs/SETUP.md`, section E0.

```bash
# one time per machine
# Node 22+, Python 3.11+. The SpacetimeDB CLI is only needed by whoever publishes the module.

# compute (on the GX10; USE_GPU=0 on a laptop)
cd services/gx10-compute && python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt && uvicorn app:app --host 127.0.0.1 --port 8000

# worker (prints its identity, then waits for approval)
cd services/gx10-bridge && npm ci && WORKER_TIER=gpu npm start      # cpu on the backup machine

# operator (Steven's laptop: uses his `spacetime login` identity)
cd tools/demo-ctl && npm ci
npm start -- approve <identity-hex>      # let a worker take jobs
npm start -- status                      # objects, corridor, jobs, workers, feeds
npm start -- poll                        # fetch NOAA + CelesTrak now

# web
cd web && npm ci && npm run dev          # http://localhost:5173 (big screen), /report (phone)

# after a module change (from the repo root)
spacetime publish skyfall-calhacks --server maincloud --module-path spacetimedb -y
for d in web/src services/gx10-bridge/src tools/demo-ctl/src; do
  spacetime generate --lang typescript --out-dir $d/module_bindings --module-path spacetimedb -y
done
```

Gotchas:
- **Never run two workers with the same token** (`services/gx10-bridge/.gpu.token` / `.cpu.token`). The database refuses the second one's results.
- `spacetime call` with negative numbers needs `--` before the arguments.
- A fresh publish runs the scheduled fetches only after one interval (15 min for NOAA), so run `npm start -- poll` after publishing.
- Free maincloud databases pause when idle; the first connection wakes them.

---

## 9. Roles, branches and tasks (works for any team size)

Branches already exist on GitHub (created from `docs/debris-pivot`). Each owner works on their branch, pulls `main` often, and opens a PR per finished piece. **R3's schema PR merges first.**

| Role | Owns | Branch(es) | Block 1 (→18:00) | Block 2 (→23:00) | Block 3+ |
|---|---|---|---|---|---|
| **R1 Globe & UX** (Steven) | `web/` (read `docs/VIS_NOTES.md` first; the globe is split into 4 tasks in `docs/GLOBE_TASKS.md`) | `feat/globe-3d` | CesiumJS globe, live objects with altitude, coming-down-next, select | falling-debris animation, impact zones, breakdown + compute panels, degraded banner | debris clouds layer, Claude Design pass, deck |
| **R2 Debris physics + GX10** | `services/gx10-compute/` | `feat/debris-physics` | GX10 setup + first GPU forecast; `sim.py` state at 80 km; `/debris` v0 (sphere/cylinder heating) with unit checks | v1: all shapes, parent–child, footprints, sample tracks, CUDA batch | perf (CUDA graphs), stretch `/fragment` (NASA SBM) |
| **R3 Data & backend** | `spacetimedb/`, `services/feed-poller/`, `data/archetypes/`, worker DEBRIS handler | `feat/debris-schema`, `feat/sat-profiles` | debris tables + reducers + DEBRIS job (publish, bindings, merge first); 6 archetypes + materials with sources | GCAT/SATCAT ingest → `ingest_profile` → archetype match; worker DEBRIS handler | CelesTrak debris groups; Space-Track poller |
| **R4 AI, validation, demo** | `services/assistant/`, validation, hosting, docs | `feat/assistant`, `feat/validation` | pick the validation case (watch tonight's re-entries; find a recovered-debris case) | Grok assistant from tables; validation panel data | Grok Voice; Vultr + .Tech; demo script, README, Devpost |

**Fewer people?**
- **3:** R4's work splits. Assistant → R3; validation, hosting and demo → R1.
- **2:** person A = R1 + R4 (web, assistant, demo); person B = R2 + R3 (physics, GX10, backend).
- **1 + Claude:** follow the block order; Claude takes R3 and R2 first.
- **More than 4:** split R2 into heating/flight vs footprints/perf, and R1 into globe vs panels.

**Interfaces you can build against right now** (no need to wait for each other):
- DB tables and reducers: `docs/ARCHITECTURE.md` (planned rows)
- `/debris` request/response and archetype JSON: `docs/DEBRIS_MODEL.md` §2, §5. R1 can mock the response from that example while R2 builds it
- Live data already in the DB: `reentry_object`, `forecast`, `space_weather`, `compute_run`

---

## 10. Rules of the road

- Everything simulated is **labeled simulated**: UI badge, code comments, README.
- No scraping. Use official APIs only, within their limits (`docs/LIVE_DATA_SOURCES.md`): CelesTrak at most once per 2-hour update, never in a retry loop; Space-Track under 30 requests/min and 300/hr, one account, never share the login.
- Never commit secrets or tokens (`*.token` and `.env` are ignored).
- `gx10-compute` stays independent of SpacetimeDB (plain HTTP, testable with curl).
- If a doc says **"check"**, verify it before relying on it, then update the doc.
- Stuck for more than 30 minutes? Say so in chat and pick a different task.

---

## 11. Who to ask
- **Steven:** operator identity (demo-ctl), GX10 access, Space-Track account, final calls on the open decisions.
- Unsure about a table or reducer: `docs/ARCHITECTURE.md` is the contract.
