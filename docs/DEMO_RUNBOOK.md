# Demo runbook: one real debris result, then GPU-to-CPU failover

Do this on the GX10 (and a second machine for the CPU worker). A cloud agent cannot reach the GX10, and this change does not publish the SpacetimeDB module or write to `skyfall-calhacks`. The module already on maincloud has `request_debris`, `publish_debris`, `claim_job` and `sweep`. Use a checkout that includes this change (latest `main` after it merges) so `/debris` returns the shape those reducers store.

Debris numbers are **modeled estimates**. The globe pill says **DEBRIS MOCK** until a `debris_forecast` row exists for the object you select. Do not present a yellow MOCK pill as a GX10 result.

## What you need

- Repo checkout with this branch, and the repo-root `.env` (never commit it). `SPACETIMEDB_URI=wss://maincloud.spacetimedb.com` and `SPACETIMEDB_MODULE=skyfall-calhacks` if those are not already set. `demo-ctl` also accepts the token from `spacetime login` (`~/.config/spacetime/cli.toml`).
- Operator identity. `cd tools/demo-ctl && npm start -- whoami`. If `claim-operator` was already done by Steven, use that same identity. Do not claim the role from a second identity.
- GPU compute on the GX10: `USE_GPU=1` (the default). CPU backup, on a laptop: `USE_GPU=0` and `WORKER_TIER=cpu`. A worker with `WORKER_TIER=gpu` is treated as the GPU even if its compute process is on CPU, and it blocks the fallback.

## 1. Real debris for one object

Four processes. Paths are from the repo root. Install once with the commands in `docs/GX10_SETUP.md` and `docs/TEAM_HANDOFF.md` §8.

```bash
# Terminal A, on the GX10. CUDA build of PyTorch.
cd services/gx10-compute && source .venv/bin/activate
USE_GPU=1 uvicorn app:app --host 127.0.0.1 --port 8000
# curl -s http://127.0.0.1:8000/health
# expect "ok": true, "debris_available": true, "debris_mode": "gpu", and a real gpu name

# Terminal B, on the GX10.
cd services/gx10-bridge && npm start
# WORKER_TIER defaults to gpu. Leave services/gx10-bridge/.gpu.token in place across restarts.
# The log prints the identity hex. Until approval it says "not approved yet".

# Terminal C, operator (Steven's machine, or the GX10 if that identity lives there).
cd tools/demo-ctl
npm start -- approve <gpu-identity-hex>
npm start -- seed-archetypes
npm start -- status
```

`seed-archetypes` loads `data/archetypes/*.json` and re-matches profiles. Without it, the worker fails the job with `archetype ... not loaded`.

`status` lists workers, debris candidates, and debris results. Candidates are forecasts with probability at least 0.2 and a median inside 72 hours: the same rule `publish_forecast` uses to queue DEBRIS by itself.

If `status` shows no objects, fetch the public feeds once (this writes to maincloud; it is the normal operator poll, not a schema publish):

```bash
npm start -- poll
```

Wait until `status` shows CelesTrak rows, then:

```bash
npm start -- forecast
```

A full-catalog forecast is the slow step (on the order of ten minutes on the GPU; the module comment on the bulk lease calls out about 11 minutes). Watch terminal B until it logs the forecast done. `status` should then show `debris candidates`. `publish_forecast` already queues DEBRIS for those candidates. If your demo object is not in that list, queue it yourself:

```bash
npm start -- debris <object-id>
```

`<object-id>` is the id from `status`, shaped like `CT-<norad>`, not the satellite name. Pick a candidate. An object that does not cross 80 km inside the forecast horizon makes `/debris` return HTTP 422 (`no particles crossing the 80 km re-entry boundary`) and the job fails. After 3 attempts it stays `FAILED`. `status` prints that error.

Wait until `status` prints a line like:

```text
debris CT-12345 <name> v1 gpu cuda:0 archetype=starlink p_any=... particles=...
```

`tier` must be `gpu` for the demo result. CPU mode uses 100 particles and only the three heaviest components.

## 2. Confirm it on the globe

```bash
cd web && npm run dev
```

`status` may already list debris rows from earlier GX10 runs. Confirm the pill before spending another full-catalog forecast. Landing lines need `breakup` and per-component `impact` in the stored row. If the lines are missing, run `debris <object-id>` again after pulling this change and restarting compute.

Open `http://localhost:5173`.

- Top center, green: `GPU: <device name> online`, and under it `last DEBRIS · GPU <name>` (or `claimed ...` while a job is in flight).
- Top left pill: `DEBRIS LIVE · <count>` before you select, then `DEBRIS LIVE · GPU` on the demo object.
- The left list "Live debris" includes that object, tagged `GPU`. Click it.
- The card says `DEBRIS LIVE · GPU` and `modeled estimate (<archetype>)`. Landing lines and zones are that run, not the placeholder.
- A yellow `DEBRIS MOCK` pill means this object has no `debris_forecast` row. The pieces on screen are the placeholder in `web/src/mock/debris.ts`.

Refresh `status` if the pill stays MOCK: the web app only subscribes, it does not compute.

## 3. Failover rehearsal

Start the CPU worker **before** you kill the GPU, on the laptop, pointed at the same database. Give it its own compute process (`USE_GPU=0`, port 8000 on that machine) or it will report unhealthy and take no jobs.

```bash
# Terminal D, laptop.
cd services/gx10-compute && source .venv/bin/activate
USE_GPU=0 uvicorn app:app --host 127.0.0.1 --port 8000

# Terminal E, laptop. Do not copy .gpu.token onto this machine.
cd services/gx10-bridge
WORKER_TIER=cpu COMPUTE_URL=http://127.0.0.1:8000 npm start
```

Approve the identity it prints:

```bash
cd tools/demo-ctl && npm start -- approve <cpu-identity-hex>
npm start -- status
```

You want two workers: GPU `HEALTHY` and CPU `HEALTHY`. The banner stays green. `claim_job` gives the CPU nothing while any GPU row is healthy. That rule is in the database, not in the workers.

Timings, from `spacetimedb/src/index.ts` and `services/gx10-bridge/src/worker.ts`:

| Constant | Value | What it does |
|---|---|---|
| Worker heartbeat | every 3 s | `report_compute_status` |
| `HEARTBEAT_STALE` | 10 s | `sweep` sets `compute_status.healthy = false` |
| `sweep` | every 2 s | applies the stale check |
| UI check | every 1 s | banner treats a GPU as down when `healthy` is false **or** the heartbeat is older than 10 s |
| `HEARTBEAT_STALE_BULK` | 60 s | a FORECAST or DEBRIS the dead worker already held is requeued |
| Fast-lane lease | 60 s | CLASSIFY / UPDATE; those requeue at the 10 s stale mark |
| Bulk lease | 15 min | only if the worker is still considered up |
| CPU claim poll | every 0.3 s | also on the `compute_status` update |

What the room should see:

1. Banner is green: `GPU: … online`.
2. In terminal B, Ctrl-C the **bridge** (leave the GX10 compute process up so the restart is fast).
3. **About 8–12 seconds** later the banner turns amber: `DEGRADED: CPU fallback active`, because the last heartbeat was at most 3 s old and the 10 s stale mark plus the 1 s UI tick lands in that window. If the CPU worker is not healthy, the banner says `DEGRADED: GPU offline` instead. Fix that before the show.
4. A FORECAST or DEBRIS the GPU had already claimed stays on that worker until **60 seconds** after its last heartbeat. The subtitle then says `requeues after 60s`. Do not wait that out on stage.
5. After the banner has been amber for a few seconds (so `sweep` has set `healthy=false`, which is 10 s after the last heartbeat plus up to 2 s), queue a fresh job:

```bash
cd tools/demo-ctl && npm start -- debris <object-id>
```

The CPU claims it within about a second of the row being unhealthy. The subtitle switches to `claimed DEBRIS · CPU`. When it finishes, that object's pill reads `DEBRIS LIVE · CPU`. CPU runs are 100 particles and three components, so the zones are wider. Say that out loud.

6. Recover: start terminal B again (`npm start` in `services/gx10-bridge` on the GX10). The first heartbeat is sent as soon as the subscription is up, so the green `GPU: … online` banner returns in **about 5 seconds**, once `/health` succeeds. New jobs go back to the GPU. The CPU result stays on screen until a GPU debris job for that object finishes and replaces it.

`status` during the rehearsal should show the GPU worker `down` (heartbeat age climbing) and the CPU worker `HEALTHY`, then the GPU `HEALTHY` again after the restart.

## If it fails

- Worker log `not approved yet`: `approve` the hex it printed. Approval is once per identity; `.gpu.token` / `.cpu.token` keep the identity.
- Debris job `unsupported v0 component shape` or `unsupported v0 material`: the compute process is on an old checkout. Pull latest `main` and restart terminal A.
- Debris job `profile mass cannot be reconciled`: old checkout. Current `main` keeps the archetype masses instead of failing the job.
- Pill stays MOCK: `status` has no `debris <id>` line for the object you clicked, or the web app is pointed at a different database (`VITE_SPACETIMEDB_MODULE`).
- Banner never leaves `compute connecting…`: the page has no SpacetimeDB connection. Check the URI and the browser console.
