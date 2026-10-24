# Architecture

## Principle: SpacetimeDB is the system
SpacetimeDB is not a cache or a message pipe here. The module in `spacetimedb/` **is** the backend. It holds every rule that coordinates the project, and every other component is a thin client that reads tables and calls reducers.

| Job | Lives in SpacetimeDB as |
|---|---|
| Who may write what | `worker_registry` + role checks in every reducer; workers approved by the operator |
| Sighting intake and validation | `submit_sighting` (range, mode, rate limit per identity) |
| Reporter trust | `reporter_stats`, updated by verdicts and by the simulation's per-sighting consistency scores |
| GPU work queue, leases, retries | `compute_job` + `claim_job` / `set_verdict` / `publish_corridor` / `fail_job` + the `sweep` scheduled reducer |
| GPU-to-CPU failover | `claim_job` refuses CPU workers while a healthy GPU worker exists; `sweep` marks silent workers unhealthy |
| Corridor and its history | `corridor` (current) + `corridor_history` (every version, for the timeline and before/after) |
| The demo replay | `replay_state` + private `replay_sighting` script + the `replay_step` scheduled reducer that emits simulated sightings |
| Public live feeds | scheduled **procedures** that fetch NOAA SWPC and CelesTrak over HTTP and write `space_weather`, `reentry_object`, `feed_status`; politeness limits enforced in the module |
| Per-user view | `my_sightings` view (each phone sees its own reports) |
| Sky assistant (planned) | `ask_assistant` → `assistant_message` + an `ASK` job; `post_answer` writes the reply; `my_assistant_messages` view |

Outside the module, only these run, and none hold state:
- **gx10-worker** (`services/gx10-bridge`): claims jobs, calls compute on localhost, writes results. Run a second copy with `WORKER_TIER=cpu` as the fallback.
- **gx10-compute**: pure HTTP physics + vision. Never talks to SpacetimeDB.
- **feed-poller** (`services/feed-poller`): Space-Track only, because it needs a login session and a strict request budget. It writes through `ingest_object` and `report_feed_status`.
- **assistant worker** (`services/assistant`, planned): claims `ASK` jobs, answers with Grok using lookups over its own subscription, writes through `post_answer`. Holds the xAI key. See "Sky assistant" below.

Rules:
- Only SpacetimeDB holds shared state. No side databases, no direct client-to-GX10 calls, no screen talks to a feed.
- Workers are stateless: kill one mid-job and the lease expires, the job is re-queued, and another worker finishes it.
- If a rule can live in a reducer, it lives in a reducer, not in a worker or the UI.

## Diagram
```
                        ┌───────────────────────── SpacetimeDB module ─────────────────────────┐
 NOAA SWPC ──HTTP──►    │  noaa_poll / celestrak_poll (scheduled procedures, polite limits)    │
 CelesTrak ──HTTP──►    │        │                                                             │
                        │        ▼                                                             │
 Space-Track ─► feed-   │  reentry_object  space_weather  feed_status                          │
          poller ─red.─►│                                                                       │
                        │  submit_sighting ─► sighting ─► compute_job (QUEUED)                 │
 Phones (/report) ─────►│        ▲   reporter_stats ◄── verdicts + scores                      │
                        │        │                         │                                   │
                        │  replay_step (every 1 s) emits SIM sightings from replay_sighting     │
                        │                                  │                                   │
                        │  sweep (every 2 s): expire leases, mark silent workers unhealthy     │
                        │                                  │                                   │
                        │  corridor + corridor_history ◄── publish_corridor                    │
                        └────▲──────────────────▲──────────────┬───────────────────────────────┘
       subscriptions         │                  │  claim_job   │ job rows (subscription)
 Big screen (/) ─────────────┘                  │              ▼
                                         ┌──────┴──────────────────────┐   ┌───────────────────┐
                                         │ gx10-worker (tier=gpu)      │   │ cpu-worker        │
                                         │ GX10                        │   │ (fallback laptop) │
                                         └──────┬──────────────────────┘   └───────────────────┘
                                          HTTP localhost
                                         ┌──────┴────────┐
                                         │ gx10-compute  │ (CUDA)
                                         └───────────────┘
```

## Tables
Public unless noted. TS field names are camelCase; SpacetimeDB stores the snake_case names below. Field lists are the contract: add fields only by editing this file too.

| Table | Key | Fields |
|---|---|---|
| `reentry_object` | `id` (`TIP-<norad>`, `CT-<norad>`, `REPLAY-<name>`) | `name`, `norad_id`, `source` (`TIP` \| `REPLAY` \| `CANDIDATE`), `window_start?`, `window_end?` (absent for `CANDIDATE`), `elements` (JSON), `status` (`PREDICTED` \| `DECAYED` \| `REPLAY` \| `CANDIDATE`), `updated_at` |
| `sighting` | `id` (auto) | `object_id`, `lat`, `lon`, `observed_at`, `bearing_deg?`, `clip_ref?`, `reporter` (identity), `reporter_key` (identity hex, or `sim-<n>`), `mode` (`LIVE` \| `DEMO` \| `SIM`), `verdict` (`PENDING` \| `ACCEPTED` \| `HELD` \| `REJECTED`), `reason`, `p_inlier?` |
| `reporter_stats` | `reporter_key` | `submitted`, `accepted`, `rejected`, `agreed`, `disagreed`, `last_submit_at` |
| `compute_job` | `id` (auto) | `kind` (`CLASSIFY` \| `UPDATE` \| `ASK` (planned)), `object_id` (`""` for ASK), `sighting_id?`, `message_id?` (planned, ASK only), `status` (`QUEUED` \| `CLAIMED` \| `DONE` \| `FAILED`), `claimed_by?`, `claimed_at?`, `attempts`, `created_at`, `finished_at?`, `error` |
| `corridor` | `object_id` | `version`, `bands` (JSON `[{level, polygon}]`), `area_km2_90`, `n_samples`, `n_sightings_used`, `computed_at`, `computed_by` |
| `corridor_history` | `id` (auto) | `object_id`, `version`, `bands`, `area_km2_90`, `n_sightings_used`, `computed_at`, `job_ms`, `tier` |
| `compute_status` | `worker` (identity) | `tier` (`gpu` \| `cpu`), `gpu_name`, `healthy`, `variants_run_total` (summed by the module from finished jobs), `last_job_ms`, `sightings_classified`, `updated_at` (heartbeat) |
| `feed_status` | `feed` | `last_attempt_at?`, `last_ok_at?`, `last_error`, `rows_ingested` |
| `space_weather` | `key` (`current`) | `kp?`, `kp_time`, `f107?`, `f107_time`, `updated_at` |
| `replay_state` | `id` = 0 | `running`, `t_offset` (s), `event_id`, `started_at`, `speed`. Replay clock = `t_offset + (now - started_at) * speed` |
| `replay_sighting` (private) | `id` (auto) | `event_id`, `t_offset_s`, `lat`, `lon`, `bearing_deg?`, `sim_reporter`, `is_outlier` (ground truth, never public), `emitted` |
| `worker_registry` (private) | `identity` | `role` (`worker` \| `poller` \| `operator` \| `assistant` (planned)) |
| `assistant_message` (planned, private; read through the view) | `id` (auto) | `asker` (identity), `role` (`USER` \| `ASSISTANT`), `text`, `lat?`, `lon?` (where the user is, if they shared it), `data_mode` (`LIVE` \| `SIM` \| `MIXED` \| `NONE`), `tools_used` (JSON list of lookups called), `job_id?`, `created_at` |
| `sweep_tick`, `replay_tick`, `noaa_tick`, `celestrak_tick` (private) | `scheduled_id` | `scheduled_at`: schedule rows inserted by `init` |

Feed names in `feed_status`: `noaa_swpc`, `celestrak_decaying` (module), `spacetrack_tip`, `spacetrack_decay`, `spacetrack_gp` (poller).

## Reducers, procedures, views
| Name | Kind | Who | Effect |
|---|---|---|---|
| `init` | lifecycle | module | insert the four schedule rows |
| `register_worker(role)` | reducer | first caller for `poller` / `operator` | claim that role (one identity each) |
| `approve_worker(identity_hex)`, `revoke_worker(identity_hex)` | reducer | operator | add or remove a worker identity |
| `ingest_object(...)` | reducer | poller, operator | upsert `reentry_object`; a new tracked object gets a baseline `UPDATE` job |
| `report_feed_status(feed, ok, error, rows)` | reducer | poller, operator | upsert `feed_status` |
| `submit_sighting(...)` | reducer | anyone | validate, rate-limit (one per 2 s per identity), insert. With a clip: `PENDING` + `CLASSIFY` job. Without: `ACCEPTED` ("position-only report") + `UPDATE` job |
| `claim_job()` | reducer | worker | give the caller the next `QUEUED` job (CLASSIFY first, then oldest), one at a time; CPU tier gets nothing while a healthy GPU worker exists |
| `set_verdict(job_id, verdict, reason)` | reducer | worker holding the job | finish CLASSIFY, set the sighting's verdict, update trust, queue `UPDATE` unless rejected |
| `publish_corridor(job_id, bands, area_km2_90, n_samples, n_sightings_used, job_ms, scores)` | reducer | worker holding the job | finish UPDATE, replace `corridor`, append `corridor_history`, add to `variants_run_total`, apply `scores` (`p_inlier` < 0.2 moves ACCEPTED → HELD; ≥ 0.5 restores) and update `agreed`/`disagreed` |
| `fail_job(job_id, error)` | reducer | worker holding the job | re-queue, or `FAILED` after 3 attempts |
| `report_compute_status(tier, gpu_name, healthy)` | reducer | worker | heartbeat |
| `sweep` | scheduled reducer, 2 s | module | expire job leases older than 10 s; mark workers silent for 10 s unhealthy |
| `load_replay_script(event_id, rows)` | reducer | operator | load the simulated sightings from `tools/sighting-gen` |
| `start_replay(event_id, t_offset, speed)`, `pause_replay()` | reducer | operator | drive the replay clock |
| `replay_step` | scheduled reducer, 1 s | module | emit due `replay_sighting` rows as `SIM` sightings |
| `reset_demo(object_id)` | reducer | operator | delete DEMO/SIM sightings, their jobs, stats and history; rewind the script; queue a baseline corridor |
| `noaa_poll` | scheduled procedure, 15 min | module | fetch Kp + F10.7 over HTTP, write `space_weather` + `feed_status` |
| `celestrak_poll` | scheduled procedure, 2 h | module | fetch `SPECIAL=DECAYING` (skips if attempted < 2 h ago, never retries in a loop), upsert `CANDIDATE` objects |
| `poll_feeds_now` | procedure | operator | run both fetches now (CelesTrak still respects its gap) |
| `my_sightings` | view | anyone | the caller's own sightings |
| `ask_assistant(text, lat?, lon?)` (planned) | reducer | anyone | text 1–500 chars, one question per 5 s per identity, at most 1 open ASK per identity; insert a `USER` message + an `ASK` job |
| `post_answer(job_id, text, data_mode, tools_used)` (planned) | reducer | assistant worker holding the job | finish ASK, insert the `ASSISTANT` message (max 2000 chars). If an ASK fails 3 times, the module posts "Couldn't answer right now" instead |
| `my_assistant_messages` (planned) | view | anyone | the caller's own conversation |

Scheduled reducers and procedures check `ctx.sender == ctx.databaseIdentity`, so clients cannot trigger them directly.

**Verified on maincloud (Oct 24, CLI 2.13):** the module publishes as `skyfall-calhacks`; procedures fetch NOAA and CelesTrak over HTTP and write in the same call; interval schedules fire about one interval after publish (so `poll` once after a fresh publish); a client reducer that throws `SenderError` rejects the caller's promise; a second worker holding the same identity is refused by `claim_job`'s lease check. Measured: sighting → new corridor on the big screen in 0.39 s (stub compute); GPU worker killed → CPU worker finished the next job 7 s later. NOAA's `10cm-flux.json` is a one-element array, not an object.
**Still check:** procedure HTTP on a local `spacetime start` server (only matters if we fall back to local).

## One sighting, end to end
1. Phone → `submit_sighting`. The module validates it and rate-limits per identity. No clip → `ACCEPTED` + one coalesced `UPDATE` job. Clip → `PENDING` + a `CLASSIFY` job. Every screen shows the pin at once.
2. A worker sees the `QUEUED` row on its subscription → `claim_job`. The module grants the lease to exactly one worker.
3. CLASSIFY: `POST /classify` → `set_verdict`. The module updates trust and queues the `UPDATE`.
4. UPDATE: the worker reads the object, accepted/held sightings, reporter trust and space weather from its subscription → `POST /update` → `publish_corridor` with per-sighting scores.
5. The module versions the corridor, logs history, adjusts verdicts and trust, and every screen animates the new corridor.
Target: tap to visible change in about 2 seconds. New sightings arriving while an UPDATE runs coalesce into the next one.

## gx10-compute API
- `GET /health` → GPU name, free memory, model status, `use_gpu`
- `POST /classify` → body `{image_b64 | clip_ref}` → `{label, confidence, reason}`; labels: `reentry`, `meteor`, `aircraft_or_train`, `nothing`
- `POST /update` → body `{object: {elements, window_start, window_end}, sightings: [{id, lat, lon, observed_at, bearing_deg?, trust}], space_weather?: {kp, f107}}` → `{bands: [{level, polygon}], area_km2_90, n_samples, ess, ms, scores: [{id, p_inlier}]}`
Polygons are GeoJSON-style `[lon, lat]` rings, simplified to at most a few hundred points before leaving compute. `trust` = `(agreed + accepted + 1) / (agreed + disagreed + accepted + rejected + 2)` from `reporter_stats`; compute lowers a sighting's outlier rate as trust rises (see SIM_SPEC.md).

## Sky assistant (planned, Phase 3)
A chat panel (and optionally voice) on the big screen and on `/report`. It answers questions about what is on the page and tells people **where and when to look**. It does not predict where anything lands: meteors are random and burn up, and re-entry corridors are wide and uncertain. Its answers say so.

**Flow.** Phone or screen → `ask_assistant` → the module stores the question and queues an `ASK` job → the assistant worker claims it → calls Grok with the question, the user's location (if shared) and the lookup tools below → each tool call is answered from the worker's SpacetimeDB subscription (or a fixed file) → `post_answer` → the reply appears live through `my_assistant_messages`.

**Claiming.** `claim_job` gives `ASK` jobs only to `assistant` identities, and never gives CLASSIFY/UPDATE to them, so chat never delays the corridor. The assistant role is approved by the operator like a worker.

**Lookups (Grok function calls).** The model gets no raw page dump; it can only state what these return:
| Tool | Returns | Source |
|---|---|---|
| `get_objects()` | tracked and candidate objects: name, status, re-entry window, real or simulated | `reentry_object` |
| `get_corridor(object_id)` | current version, 90% area, sightings used, a few points along the band, when computed | `corridor`, `corridor_history` |
| `get_visibility(lat, lon, object_id, hours)` | upcoming passes over the user: rise time, max elevation, direction, whether it is sunlit while the sky is dark | computed in the worker from `elements` with satellite.js (check accuracy against a known pass) |
| `get_space_weather()` | Kp, F10.7 and their times; what they mean for re-entry timing | `space_weather` |
| `get_shower_calendar(days)` | upcoming meteor showers: peak date, radiant direction, typical rate | fixed `data/meteor_showers.json` (from the IMO calendar; check dates) |
| `explain_sighting(id)` | verdict, reason, consistency score, reporter trust | `sighting`, `reporter_stats` |
| `get_feed_status()` | when each feed last succeeded | `feed_status` |

**Rules the worker enforces (system prompt + checks on the output):**
- Every answer names its data mode: anything from a `REPLAY` object or `SIM` sighting is called simulated. `data_mode` is set from the tools actually called, not from the model's text.
- Times come from tool results only, in the user's local time, with the uncertainty (re-entry windows are often hours wide).
- No landing-point claims ("it will land in your town"). Point to the band and the window instead.
- Never says debris is safe or dangerous to approach; falling debris questions get "do not touch it, contact local authorities".
- Off-topic questions get a short redirect.
- The model and timeout are fixed in the worker (`XAI_MODEL`, 15 s). On error it calls `fail_job`.

**Voice (optional).** Grok Voice for speaking questions and hearing answers. **Check** the API shape first; the xAI key must stay off phones, so voice may need a short-lived token from the assistant worker. Fallback: the browser's built-in speech recognition, with the text going through `ask_assistant`.

**Check:** that the xAI chat API supports function calling in the OpenAI-compatible format, the model name, and hackathon credits.

## Map layers (web `/`)
1. Corridor bands (50% and 90%), animated between versions
2. Sighting pins (grey pending, green accepted, orange held, dark grey rejected; tap for the reason). SIM pins carry a "simulated" marker.
3. Predicted ground track with a moving marker driven by the replay clock
4. CelesTrak candidates as small markers (real, live)
Panels: object + feed status, space weather, GX10/CPU workers and job queue depth, corridor timeline from `corridor_history` (before/after area), reporter trust leaderboard (optional), sky assistant chat (planned).

## Failure behavior
- GPU worker killed: its heartbeat stops → `sweep` marks it unhealthy within 10 s and expires its lease → the CPU worker's `claim_job` now succeeds → the corridor keeps updating, and the panel shows the switch.
- Compute down while a worker is up: the worker reports `healthy=false` and calls `fail_job`; jobs retry up to 3 times, then show as `FAILED`.
- Feed errors: written to `feed_status` and shown, never hidden. CelesTrak errors wait for the next 2-hour cycle.
- Worker restart: it re-subscribes; anything it held comes back through lease expiry.
- Assistant down or xAI failing: questions stay queued; after 3 failed attempts the user gets "Couldn't answer right now". The map and corridor are unaffected.
