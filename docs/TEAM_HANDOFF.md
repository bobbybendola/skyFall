# SKYFALL team handoff

Read this first. It is enough to pick up any task without asking Steven. Deeper detail lives in the files linked from each section.

Cal Hacks 13.0, Oct 23–25 2026. **Devpost submission due Sunday 9:00 AM.**
Repo: https://github.com/bobbybendola/skyFall (private for now).

---

## 1. What we are building (30-second version)

When a satellite or rocket body falls back to Earth, the official prediction is a time window hours wide and a path thousands of kilometres long. SKYFALL turns that into a live map that **narrows as people report seeing it**:

1. Real orbit data (CelesTrak, Space-Track) and real space weather (NOAA) flow into **SpacetimeDB**.
2. The **ASUS GX10** (GPU) runs a Monte Carlo simulation, with thousands of slightly different versions of the orbit, to draw a re-entry corridor (50% and 90% bands).
3. People tap where they saw a streak on their phone (`/report`). Each sighting goes to the GX10, which reweights the simulation and checks whether the report is consistent. Bad reports are held and good reporters gain trust.
4. Every screen sees the corridor shrink live. If the GX10 is unplugged, a backup worker takes over in degraded mode, and the screen says so.

**Demo:** a replay of a **real past re-entry** (real orbit data; the sightings are simulated and labeled), plus a live map of the ~70 objects actually decaying right now.

**Honesty rules:** anything simulated is labeled simulated in code, UI and README. We never claim to know where something lands, only where to look and how uncertain that is.

---

## 2. Status (updated Oct 24, ~10:00 PT)

| Area | State |
|---|---|
| SpacetimeDB module (`spacetimedb/`) | **Live on maincloud** as `skyfall-calhacks`. Job queue, leases, GPU→CPU failover, trust, replay clock, NOAA + CelesTrak fetching inside the database |
| Worker (`services/gx10-bridge`) | Done. Tested with a laptop standing in for the GX10 |
| Compute (`services/gx10-compute`) | **Stub only** (fake shrink). Phase 2 replaces it with the real GPU simulation |
| Operator console (`tools/demo-ctl`) | Done |
| Web (`web/`) | Working prototype with plain styling. The visual design comes later in Claude Design |
| Phase 1 checkpoint | **Passed:** sighting → new corridor on screen in 0.39 s; GPU worker killed → backup took over in 7 s |
| GX10 | Being set up by Steven (CUDA, PyTorch, worker) |
| Live data now | NOAA Kp/F10.7 every 15 min; 70–71 CelesTrak decaying objects every 2 h, plotted live with SGP4 |

---

## 3. Decisions already made (don't reopen without Steven)

- **SpacetimeDB is the backend**, not just storage. Every rule (validation, queue, leases, failover, trust, feed politeness) lives in a reducer or procedure. Workers and web pages are thin. See `AGENTS.md`.
- **GX10 job for Phase 2:** Monte Carlo corridors for **all** decaying objects (not just the demo replay), refreshed when orbit or space-weather data changes. Without the GX10 the product falls back to a much smaller, visibly degraded run.
- **Replay event:** a **real past re-entry**. Candidates to be proposed; pick in Phase 2.
- **Hosting:** a free **.Tech domain** (MLH prize) plus a **Vultr** server that hosts the website and runs the degraded CPU backup worker (MLH Best Use of Vultr).
- **Design and slides:** only after the prototype is solid. Then use Claude Design for the UI, and a deck after the demo works.
- **Database name:** `skyfall-calhacks` on maincloud. Phones reach it from any network.

**Open decisions:** 4th sponsor track (Anthropic vs Mana.space); which real re-entry to replay; exact domain name.

---

## 4. Sponsor tracks we're entering

Details and criteria: `docs/SPONSORS.md`.

| Track | What judges need to see | Owner of the story |
|---|---|---|
| **SpacetimeDB** (core, $2048/$1024/$512) | SpacetimeDB as the real-time backend: the shared job queue, failover, live sync to every screen | backend |
| **SpaceXAI "Make it Legendary"** | Built with **Cursor**; uses the **Grok Voice or Imagine API**; space/public data. Plan: Grok sky assistant ("where and when to look"), Grok Imagine test images. Starlink re-entries are most of the live list | AI |
| **MLH Build Your Hackathon A-Team** | Cursor as the main coding agent + Grok Bot for planning, described in the Devpost write-up | everyone |
| **4th: Anthropic or Mana.space** | TBD | TBD |
| **MLH Best .Tech Domain**, **MLH Best Use of Vultr** | Domain points at the site; Vultr hosts the site and the backup worker | infra |

**Everyone:** do real work in **Cursor** and add a line to `docs/TOOL_LOG.md` when Cursor or Grok does something notable. The SpaceXAI and MLH tracks require it.

---

## 5. How it fits together

```
NOAA, CelesTrak ──HTTP (fetched by the database itself)──┐
Space-Track ──► feed-poller ──reducers──┐                │
                                        ▼                ▼
Phones /report ──submit_sighting──►  SpacetimeDB (maincloud, skyfall-calhacks)
Big screen /   ◄──live subscriptions── tables: reentry_object, sighting, corridor,
                                        corridor_history, compute_job, compute_status,
                                        feed_status, space_weather, replay_state ...
                                        │ jobs (QUEUED)        ▲ results via reducers
                                        ▼                      │
                          gx10-bridge worker (gpu on GX10, cpu on Vultr) ──HTTP──► gx10-compute
```

- A sighting creates a job row. A worker claims it (`claim_job`, with a 10 s lease), calls compute, and writes back (`publish_corridor` / `set_verdict`). The database versions the corridor, updates trust, and every screen redraws.
- **Failover is a database rule:** CPU workers only get jobs while no healthy GPU worker exists. `sweep` (every 2 s) expires leases and marks silent workers unhealthy.
- Full table/reducer contract: `docs/ARCHITECTURE.md`. Change names only by editing that file in the same PR.

---

## 6. Repo map

| Path | What it is | Language |
|---|---|---|
| `spacetimedb/src/index.ts` | The backend: all tables, reducers, scheduled jobs, feed fetchers | TypeScript |
| `services/gx10-compute/app.py` | Physics + vision over plain HTTP (`/health`, `/update`, `/classify`); never touches the DB | Python, FastAPI, PyTorch |
| `services/gx10-bridge/src/worker.ts` | Stateless worker: claim job → call compute → write result | TypeScript (Node 22) |
| `tools/demo-ctl/src/ctl.ts` | Operator console: approve workers, seed, replay controls, status | TypeScript |
| `web/src/` | `BigScreen.tsx` (`/`), `Report.tsx` (`/report`), `MapView.tsx` (MapLibre), `orbit.ts` (SGP4 + track), `live.ts` (helpers) | React, Vite, MapLibre |
| `*/src/module_bindings/` | **Generated** client code. Never edit by hand; regenerate (section 8) | — |
| `data/replay/` | Replay event files (currently a labeled placeholder) | JSON |
| `docs/` | `ARCHITECTURE`, `DEV_PLAN`, `SETUP`, `SIM_SPEC`, `LIVE_DATA_SOURCES`, `SPONSORS`, `DEMO`, `GX10_SETUP` | — |

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

## 9. Open tasks (pick one, put your name on it in chat, branch, go)

Order matters; earlier items unblock later ones. Estimates are rough.

### Phase 2: real GPU simulation, all decaying objects (top priority)
| # | Task | Where | Est. | Notes |
|---|---|---|---|---|
| 2.1 | **Decay simulation on GPU.** From GP elements (mean motion, BSTAR) + Kp/F10.7, Monte Carlo over drag/density uncertainty → re-entry time distribution + ground corridor (50/90%). Batch all objects in one GPU run | `gx10-compute` `/update` (+ new batch endpoint) | 4 h | Follow `docs/SIM_SPEC.md`; PyTorch on CUDA 13. Keep `USE_GPU=0` path with small N |
| 2.2 | **Module: corridors for CANDIDATE objects.** Queue UPDATE jobs for candidates when CelesTrak/NOAA data changes; store predicted window on the corridor; longer lease (or lease renewal) for big batch jobs | `spacetimedb/src/index.ts` | 2 h | Update ARCHITECTURE.md in the same PR |
| 2.3 | **Degraded mode.** CPU tier runs small N, only the selected object; corridor rows record tier + N; UI shows "GPU offline: degraded" | module + worker + web | 1.5 h | This is the GX10-dependency demo moment |
| 2.4 | **Real replay event.** Pick a real past re-entry; get its last orbit data + decay time; write `data/replay/<event>.json` | `data/replay/` | 1.5 h | Space-Track gives the best data (Steven's account only); CelesTrak may be enough |
| 2.5 | **Simulated sightings + scoring.** `tools/sighting-gen`: noisy reporters, 20–30% bad; score shrink + truth coverage | `tools/sighting-gen` (Python) | 2 h | Output feeds `demo-ctl script` |
| 2.6 | **Web: all-object view.** Corridors for every decaying object, list sorted by predicted re-entry, click to focus | `web/` | 2 h | Plain styling still |

### Phase 3: live feeds, AI, hosting
| # | Task | Est. |
|---|---|---|
| 3.1 | Space-Track feed-poller (TIP + decay) → `ingest_object` (Steven's machine only; one account) | 2 h |
| 3.2 | Grok sky assistant (`ASK` jobs, `services/assistant`, chat panel). Spec: ARCHITECTURE.md "Sky assistant" | 4 h |
| 3.3 | Grok Voice for the assistant (check API first) | 1.5 h |
| 3.4 | Grok Imagine test images + `/classify` (CLIP-style) | 3 h |
| 3.5 | **Hosting:** claim the .Tech domain (MLH); Vultr server serves `web` build + runs the `cpu` worker + compute with `USE_GPU=0`; QR code to `/report` | 2 h |

### Phase 4–5: polish, design, submission
Claude Design pass on the UI, corridor animation, timeline scrubber, demo script runs 5× clean, slide deck (after the demo works), backup video, README + Devpost write-up (real vs simulated; tool use for each track).

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
