# Architecture

> **Built (Oct 24 evening):** debris tables, archetypes, profiles, DEBRIS jobs chained after forecasts, `publish_debris`. Archetype data: `data/archetypes/*.json`, `data/materials.json`. Still planned: `/debris` physics (gx10-compute), catalog import, `debris_piece`.
>
> **Pivot (Oct 24):** SKYFALL now predicts **debris**: which pieces of a re-entering satellite survive, how big they are, and where they land, on a **3D globe**. Why and scope: `docs/PIVOT.md`. Physics: `docs/DEBRIS_MODEL.md`. Items marked **(planned)** are the contract for the new work; build them exactly as named here, or change this file in the same PR. Items marked **(parked)** stay in the module but are not part of the demo.

## Principle: SpacetimeDB is the system
SpacetimeDB is not a cache or a message pipe here. The module in `spacetimedb/` **is** the backend. It holds every rule that coordinates the project, and every other component is a thin client that reads tables and calls reducers.

| Job | Lives in SpacetimeDB as |
|---|---|
| Who may write what | `worker_registry` + role checks in every reducer; workers approved by the operator |
| GPU work queue, leases, retries | `compute_job` + `claim_job` / `publish_forecast` / `publish_debris` (planned) / `fail_job` + the `sweep` scheduled reducer. Two lanes per worker: one bulk job (FORECAST, DEBRIS, FRAGMENT) and one fast job (ASK, and the parked CLASSIFY/UPDATE) at a time. DEBRIS is bulk because it reuses the forecast cached in the same compute process and the compute runs one simulation at a time |
| GPU-to-CPU failover | `claim_job` refuses CPU workers while a healthy GPU worker exists; `sweep` requeues the jobs of silent workers |
| Re-entry forecasts for every object | FORECAST jobs (every 20 min, on new CelesTrak elements, when Kp/F10.7 move) → `forecast`, `forecast_history`, `compute_run` |
| Debris prediction per object (planned) | `publish_forecast` queues a DEBRIS job for every object likely to re-enter within 72 h → `debris_forecast`, `debris_component`, `debris_track` |
| What each satellite is made of (planned) | `satellite_profile` (from GCAT / SATCAT / DISCOSweb) + `archetype` (documented component lists) |
| Tracked debris already in orbit (planned) | CelesTrak debris groups, stored as `reentry_object` rows with `source = DEBRIS` (fetched by `celestrak_poll`) |
| In-orbit breakup what-if (stretch) | `fragment_event` + FRAGMENT jobs → `fragment_snapshot` |
| Archive for real replays and validation | `elements_history` (every distinct element set fetched) + `forecast_history` + `debris_history` + `reentry_outcome` + `forecast_score` |
| Public live feeds | scheduled **procedures** that fetch NOAA SWPC and CelesTrak over HTTP; politeness limits enforced in the module |
| Assistant (planned) | `ask_assistant` → `assistant_message` + an `ASK` job; `post_answer`; `my_assistant_messages` view |
| Crowd sightings, trust, replay clock, corridor (parked) | `sighting`, `reporter_stats`, `replay_*`, `corridor*`: kept, not in the demo |

Outside the module, only these run, and none hold state:
- **gx10-worker** (`services/gx10-bridge`): claims jobs, calls compute on localhost, writes results. A live FORECAST skips `REPLAY` objects. A FORECAST whose `object_id` is one replay id calls `/forecast` with `as_of`. A second copy with `WORKER_TIER=cpu` is the fallback (Vultr).
- **gx10-compute**: pure HTTP physics (`/forecast`, `/debris`, `/fragment`). Never talks to SpacetimeDB.
- **feed-poller** (`services/feed-poller`): Space-Track (login and request budget), plus large catalog downloads too big for a procedure (GCAT, SATCAT). Writes through reducers.
- **assistant worker** (`services/assistant`, planned): claims `ASK` jobs, answers with Grok from its subscription. Holds the xAI key.

Rules:
- Only SpacetimeDB holds shared state. No side databases, no direct client-to-GX10 calls, no screen talks to a feed.
- Workers are stateless: kill one mid-job and the job is re-queued and finished elsewhere. (The compute service may cache particles as a speed-up only.)
- If a rule can live in a reducer, it lives in a reducer, not in a worker or the UI.
- Every modeled number on screen is labeled "modeled estimate", with the archetype and data sources one click away.

## Diagram
```
 NOAA SWPC ──HTTP──┐        ┌──────────────────── SpacetimeDB module (maincloud) ─────────────────────┐
 CelesTrak ──HTTP──┼───────►│ noaa_poll / celestrak_poll ─► reentry_object, space_weather, feed_status │
 Space-Track, GCAT,│        │ elements_history (archive)            satellite_profile ◄─ ingest_profile │
 SATCAT ─► feed-poller ────►│                                       archetype ◄──────── upsert_archetype│
                            │ sweep (2 s): leases, failover, queue FORECAST every 20 min               │
                            │ compute_job: FORECAST ─► publish_forecast ─► forecast (+history)          │
                            │                 └─ objects re-entering < 72 h ─► DEBRIS jobs              │
                            │ compute_job: DEBRIS ─► publish_debris ─► debris_forecast,                 │
                            │                                          debris_component, debris_track   │
                            └──────▲──────────────────────────────▲────────────────┬────────────────────┘
               subscriptions       │                     reducers │      job rows  │
 3D globe (/) ─────────────────────┘                              │                ▼
 (CesiumJS: objects, forecasts, falling debris,       ┌───────────┴────────────┐  ┌──────────────────────┐
  impact zones, breakdown panel, assistant)           │ gx10-worker (gpu)      │  │ cpu-worker (Vultr)   │
                                                      │ ASUS GX10              │  │ degraded mode        │
                                                      └───────────┬────────────┘  └──────────────────────┘
                                                        HTTP localhost
                                                      ┌───────────┴────────────┐
                                                      │ gx10-compute (CUDA):   │
                                                      │ /forecast /debris      │
                                                      │ /fragment (stretch)    │
                                                      └────────────────────────┘
```

Outcome validation uses the same shape: `outcome_poll` reads CelesTrak SATCAT (no login) for NORAD ids already in `elements_history`, and Space-Track decay/TIP only when `SPACETRACK_USER` and `SPACETRACK_PASS` are set on the database. It writes `reentry_outcome`. Scoring appends `forecast_score`. The live FORECAST batch skips `source = REPLAY`. A historical case is a separate FORECAST job whose `as_of` is passed to `/forecast`.

## Tables
Public unless noted. TS field names are camelCase; SpacetimeDB stores the snake_case names below. Field lists are the contract: add fields only by editing this file too.

| Table | Key | Fields |
|---|---|---|
| `reentry_object` | `id` (`TIP-<norad>`, `CT-<norad>`, `REPLAY-<name>`) | `name`, `norad_id`, `source` (`TIP` \| `REPLAY` \| `CANDIDATE` \| `DEBRIS` (planned: tracked fragments from CelesTrak debris groups)), `window_start?`, `window_end?` (absent for `CANDIDATE`), `elements` (JSON), `status` (`PREDICTED` \| `DECAYED` \| `REPLAY` \| `CANDIDATE`), `updated_at` |
| `sighting` (parked) | `id` (auto) | `object_id`, `lat`, `lon`, `observed_at`, `bearing_deg?`, `clip_ref?`, `reporter` (identity), `reporter_key` (identity hex, or `sim-<n>`), `mode` (`LIVE` \| `DEMO` \| `SIM`), `verdict` (`PENDING` \| `ACCEPTED` \| `HELD` \| `REJECTED`), `reason`, `p_inlier?` |
| `reporter_stats` (parked) | `reporter_key` | `submitted`, `accepted`, `rejected`, `agreed`, `disagreed`, `last_submit_at` |
| `compute_job` | `id` (auto) | `kind` (`FORECAST` \| `DEBRIS` (planned) \| `FRAGMENT` (stretch) \| `ASK` (planned) \| parked: `CLASSIFY`, `UPDATE`), `object_id` (`*` for a live FORECAST batch, one `REPLAY-*` id for a historical forecast, `""` for ASK), `sighting_id?`, `message_id?` (planned, ASK only), `status` (`QUEUED` \| `CLAIMED` \| `DONE` \| `FAILED`), `claimed_by?`, `claimed_at?`, `attempts`, `created_at`, `finished_at?`, `error`, `as_of?` (replay FORECAST only: the time `/forecast` is run as of, and the `computed_at` stored for that run) |
| `corridor` (parked; forecast footprints still written here) | `object_id` | `version`, `bands` (JSON `[{level, polygon}]`), `area_km2_90`, `n_samples`, `n_sightings_used`, `computed_at`, `computed_by` |
| `corridor_history` (parked) | `id` (auto) | `object_id`, `version`, `bands`, `area_km2_90`, `n_sightings_used`, `computed_at`, `job_ms`, `tier` |
| `compute_status` | `worker` (identity) | `tier` (`gpu` \| `cpu`), `gpu_name`, `healthy`, `variants_run_total` (summed by the module from finished jobs), `last_job_ms`, `sightings_classified`, `updated_at` (heartbeat) |
| `forecast` | `object_id` | `version`, `status` (`ok` \| `likely_reentered` \| `error`), `t_q05?`, `t_q25?`, `t_q50?`, `t_q75?`, `t_q95?` (re-entry time quantiles), `decayed_frac` (share re-entering inside the horizon), `horizon_days`, `n_samples`, `ess`, `calibrated`, `bc_m2_kg`, `area_km2_90`, `tier`, `device`, `computed_at`, `note` |
| `forecast_history` | `id` (auto) | `object_id`, `version`, `t_q05?`, `t_q50?`, `t_q95?`, `decayed_frac`, `n_samples`, `tier`, `computed_at`. On a replay FORECAST, `computed_at` is the job's `as_of`, not the wall clock |
| `elements_history` | `id` (auto) | `object_id`, `epoch`, `elements` (JSON), `fetched_at`. Appended whenever an object's element epoch changes |
| `compute_run` | `id` (auto) | `kind`, `tier`, `device`, `objects`, `particles`, `particle_steps`, `ms`, `finished_at` |
| `satellite_profile` | `norad_id` | `name`, `object_type` (`PAY` \| `R/B` \| `DEB` \| `UNK`), `owner`, `launch_date?`, `mass_kg?`, `dims_m` (JSON), `shape`, `rcs_size?` (`SMALL` \| `MEDIUM` \| `LARGE`), `archetype_id`, `match_reason` (why this archetype), `sources` (JSON list: GCAT / SATCAT / DISCOSweb + field), `confidence` (`low` \| `medium` \| `high`), `updated_at` |
| `archetype` | `id` | `name`, `applies_to` (JSON), `components` (JSON, see DEBRIS_MODEL.md §2), `sources` (JSON), `confidence`, `updated_at` |
| `debris_forecast` | `object_id` | `version`, `archetype_id`, `forecast_version` (which forecast it used), `n_particles`, `p_any_survives`, `surviving_mass_kg_mean`, `surviving_mass_kg_p95`, `casualty_area_m2_mean`, `footprint` (JSON bands 50/90), `area_km2_90`, `impact_t_q05?`, `impact_t_q50?`, `impact_t_q95?`, `tier`, `device`, `computed_at`, `note` |
| `debris_component` | `id` (auto) | `object_id` (index), `version`, `name`, `material`, `shape`, `count`, `mass_kg_start`, `p_survive`, `mass_kg_mean`, `impact_speed_ms_mean`, `impact_energy_j_mean`, `demise_alt_km_mean?`, `footprint` (JSON bands). Rows for the previous version are deleted on publish |
| `debris_track` | `id` (auto) | `object_id` (index), `version`, `component`, `survived` (bool), `points` (JSON `[[t_unix, lat, lon, alt_km], ...]`, ≤ 60 points). A few representative trajectories per component for the 3D animation |
| `debris_history` | `id` (auto) | `object_id`, `version`, `p_any_survives`, `surviving_mass_kg_mean`, `area_km2_90`, `tier`, `computed_at` |
| `reentry_outcome` | `norad_id` | `object_id`, `name`, `decay_at` (official decay time), `source` (`CELESTRAK_SATCAT` \| `SPACETRACK_DECAY` \| `SPACETRACK_TIP` \| `OPERATOR`), `finds` (JSON `[{lat, lon, note}]`, reported find points; may be `[]`), `note`, `replay` (true for a historical case; that row is not a live prediction), `updated_at` |
| `forecast_score` | `id` (auto) | `norad_id` (index), `object_id`, `forecast_history_id?`, `status` (`scored` \| `no_forecast`), `hours_error?`, `inside_window?`, `find_hits` (JSON `[{lat, lon, note, inside}]`), `lead_time_hours?`, `calibrated`, `replay`, `source`, `forecast_computed_at?`, `scored_at`. Public and subscribable. A new row is appended on each score; the latest per `norad_id` is current |
| `outcome_probe` (private) | `norad_id` | `checked_at`, `decay_found`. Bookkeeping so SATCAT is not re-queried for the same archived id inside 24 h |
| `fragment_event` (stretch) | `id` (auto) | `parent_norad`, `kind` (`EXPLOSION` \| `COLLISION` \| `WHATIF`), `at`, `params` (JSON), `n_fragments`, `status`, `created_by` |
| `fragment_snapshot` (stretch) | `id` (auto) | `event_id` (index), `t_offset_s`, `positions` (packed base64 float32 `[lat, lon, alt]` × N), `n_alive`, `n_reentered` |
| `feed_status` | `feed` | `last_attempt_at?`, `last_ok_at?`, `last_error`, `rows_ingested` |
| `space_weather` | `key` (`current`) | `kp?`, `kp_time`, `f107?`, `f107_time`, `updated_at` |
| `replay_state` (parked) | `id` = 0 | `running`, `t_offset` (s), `event_id`, `started_at`, `speed`. Replay clock = `t_offset + (now - started_at) * speed` |
| `replay_sighting` (private, parked) | `id` (auto) | `event_id`, `t_offset_s`, `lat`, `lon`, `bearing_deg?`, `sim_reporter`, `is_outlier` (ground truth, never public), `emitted` |
| `worker_registry` (private) | `identity` | `role` (`worker` \| `poller` \| `operator` \| `assistant` (planned)) |
| `assistant_message` (planned, private; read through the view) | `id` (auto) | `asker` (identity), `role` (`USER` \| `ASSISTANT`), `text`, `lat?`, `lon?` (where the user is, if they shared it), `data_mode` (`LIVE` \| `SIM` \| `MIXED` \| `NONE`), `tools_used` (JSON list of lookups called), `job_id?`, `created_at` |
| `sweep_tick`, `replay_tick`, `noaa_tick`, `celestrak_tick`, `outcome_tick` (private) | `scheduled_id` | `scheduled_at`: schedule rows inserted by `init` |

Feed names in `feed_status`: `noaa_swpc`, `celestrak_decaying` (module), `celestrak_satcat` (module: decay dates for NORAD ids in `elements_history`), `celestrak_debris_groups` (planned, module), `spacetrack_tip`, `spacetrack_decay` (module, only when both database env vars are set; otherwise `last_error` starts with `disabled:`), `spacetrack_gp`, `gcat_satcat`, `discosweb` (planned, poller).

### `forecast_score` fields

Written when an outcome is inserted or updated, and again when `publish_forecast` stores a forecast whose `computed_at` is before that outcome's decay time. If no `forecast_history` row has `computed_at` strictly before the decay, the row is `status = no_forecast` and the numeric fields are left empty. No value is filled in from a guess.

| Field | Meaning |
|---|---|
| `hours_error` | `t_q50` minus the official decay time, in hours. Positive means the median is later than the official time. Absent when that forecast has no median |
| `inside_window` | Official decay time is inside the closed interval `[t_q05, t_q95]`. Absent when either quantile is missing |
| `calibrated` | **True only when the official decay time falls inside that forecast's closed 5–95% window** (`t_q05` ≤ decay ≤ `t_q95`). False when the time is outside the window, when either quantile is missing, or when `status` is `no_forecast`. This is not `forecast.calibrated`, which means drag was fitted to the observed decay rate |
| `find_hits` | One entry per find point. `inside` is true when the point is inside any `level` 90 (or 0.9) ring of the `corridor_history` row from the same forecast run (same `object_id`, same `computed_at`; matching `version` preferred). `inside` is JSON `null` when that run has no 90% corridor. A ring that crosses the antimeridian can be mis-classified |
| `lead_time_hours` | Official decay time minus the chosen forecast's `computed_at`, in hours. For a replay forecast, `computed_at` is `as_of` |
| `replay` | True when the outcome says so, or when the object is `source`/`status` `REPLAY`. A true row must not be shown as a live prediction |
| `source` | Copied from the outcome (`CELESTRAK_SATCAT`, `SPACETRACK_DECAY`, `SPACETRACK_TIP`, or `OPERATOR`) |

The forecast used is the latest `forecast_history` row for that NORAD id (any `reentry_object` with that id, or the outcome's `object_id`) whose `computed_at` is before the decay. On a tie, the outcome's `object_id` wins.

Feeds will not overwrite a higher-ranked source. Rank, highest last: `SPACETRACK_TIP`, `CELESTRAK_SATCAT`, `SPACETRACK_DECAY`, `OPERATOR`. An operator correction sticks. `SPACETRACK_TIP` is written only for a `DECAY_EPOCH` that is already in the past, and only when no SATCAT or historical decay row is already stored. Its note says the TIP time is the predicted 10 km point, not a surveyed impact. Historical Space-Track decay rows are `MSG_TYPE` `SATCAT` or `Decay Entry` only (`TIP Message` and `60day Decay` are predictions and are ignored on the decay class).

CelesTrak SATCAT `DECAY_DATE` is a calendar date. It is stored as `00:00:00Z`. Hours error against that row is coarse to about a day. The note on the outcome says so.

SATCAT's documented `CATNR` query is one catalog number per request. The procedure checks at most 4 archived ids per 2 hours, and does not repeat an id for 24 hours. Space-Track, when enabled, sends one combined decay query per day and one combined TIP query per hour (comma-separated NORAD ids, capped at 40), never one request per object. Both env values have to be present. They are optional module environment variables (`SPACETRACK_USER`, `SPACETRACK_PASS`), supplied at publish time from the shell. They are not in source. If either is missing, both Space-Track feeds are recorded as disabled and no login is attempted.

## Reducers, procedures, views
| Name | Kind | Who | Effect |
|---|---|---|---|
| `init` | lifecycle | module | insert the five schedule rows |
| `register_worker(role)` | reducer | first caller for `poller` / `operator` | claim that role (one identity each) |
| `approve_worker(identity_hex)`, `revoke_worker(identity_hex)` | reducer | operator | add or remove a worker identity |
| `ingest_object(...)` | reducer | poller, operator | upsert `reentry_object`; a new tracked object gets a baseline `UPDATE` job |
| `report_feed_status(feed, ok, error, rows)` | reducer | poller, operator | upsert `feed_status` |
| `submit_sighting(...)` | reducer | anyone | validate, rate-limit (one per 2 s per identity), insert. With a clip: `PENDING` + `CLASSIFY` job. Without: `ACCEPTED` ("position-only report") + `UPDATE` job |
| `claim_job()` | reducer | worker | give the caller the next `QUEUED` job in a free lane (CLASSIFY, then UPDATE, then DEBRIS, then FORECAST; oldest first). Lanes: bulk (FORECAST, DEBRIS) and fast (the rest), one job each. Unhealthy callers get nothing; CPU tier gets nothing while a healthy GPU worker exists |
| `publish_forecast(job_id, results, job_ms, particle_steps, n_per_object, device)` | reducer | worker holding the FORECAST | upsert `forecast` + append `forecast_history` per object; new corridor version for objects that re-enter inside the horizon and have no sightings yet; log `compute_run`. `computed_at` is the job's `as_of` when set, else now. Re-scores an existing outcome for that NORAD when this `computed_at` is before the decay. A replay job (`as_of` set) does not queue DEBRIS |
| `request_forecast()` | reducer | operator | queue a FORECAST now |
| `archive_current_elements()` | reducer | operator | one-off backfill of `elements_history` |
| `set_verdict(job_id, verdict, reason)` | reducer | worker holding the job | finish CLASSIFY, set the sighting's verdict, update trust, queue `UPDATE` unless rejected |
| `publish_corridor(job_id, bands, area_km2_90, n_samples, n_sightings_used, job_ms, scores)` | reducer | worker holding the job | finish UPDATE, replace `corridor`, append `corridor_history`, add to `variants_run_total`, apply `scores` (`p_inlier` < 0.2 moves ACCEPTED → HELD; ≥ 0.5 restores) and update `agreed`/`disagreed` |
| `fail_job(job_id, error)` | reducer | worker holding the job | re-queue, or `FAILED` after 3 attempts |
| `report_compute_status(tier, gpu_name, healthy)` | reducer | worker | heartbeat |
| `sweep` | scheduled reducer, 2 s | module | requeue jobs whose worker is unhealthy or silent; expire leases (fast 60 s, bulk 15 min); mark workers silent for 10 s unhealthy; drop workers silent for 10 min; queue a live FORECAST (`object_id` `*`) if none ran for 20 min. A replay FORECAST does not count as that live job |
| `load_replay_script(event_id, rows)` | reducer | operator | load the simulated sightings from `tools/sighting-gen` |
| `start_replay(event_id, t_offset, speed)`, `pause_replay()` | reducer | operator | drive the replay clock |
| `replay_step` | scheduled reducer, 1 s | module | emit due `replay_sighting` rows as `SIM` sightings |
| `reset_demo(object_id)` | reducer | operator | delete DEMO/SIM sightings, their jobs, stats and history; rewind the script; queue a baseline corridor |
| `noaa_poll` | scheduled procedure, 15 min | module | fetch Kp + F10.7 over HTTP, write `space_weather` + `feed_status` |
| `celestrak_poll` | scheduled procedure, 2 h | module | fetch `SPECIAL=DECAYING` (skips if attempted < 2 h ago, never retries in a loop), upsert `CANDIDATE` objects |
| `poll_feeds_now` | procedure | operator | run NOAA, CelesTrak decaying, and the outcome fetch now (CelesTrak gaps still apply) |
| `outcome_poll` | scheduled procedure, 6 h | module | for NORAD ids in `elements_history`, fetch CelesTrak SATCAT decay dates; Space-Track decay and TIP only if credentials are configured |
| `upsert_outcome(norad_id, object_id, name, decay_at, source, finds, note, replay)` | reducer | operator | insert or correct one `reentry_outcome`, then score it |
| `load_replay_case(json)` | reducer | operator | load one historical case (`replay` forced true). With a GP element set, queue one FORECAST for that object with `as_of`. Without elements, store the outcome only |
| `my_sightings` | view | anyone | the caller's own sightings (parked) |
| `ingest_profile(norad_id, ...)` | reducer | poller, operator | upsert `satellite_profile`; picks `archetype_id` by the archetype's `applies_to` rules (object type, name pattern, mass range); stores `match_reason` |
| `upsert_archetype(id, json)` | reducer | operator | validate and store an archetype (components must have material, shape, mass, dims) |
| `publish_debris(job_id, result, job_ms, particle_steps, device)` | reducer | worker holding the DEBRIS job | write `debris_forecast` (+version), replace `debris_component` / `debris_track` rows, append `debris_history`, log `compute_run` |
| `rematch_profiles()` | reducer | operator | make sure every object has a profile (guessed from its name: DEB / R/B / PAY, confidence low) and re-match all profiles to archetypes; run after loading archetypes (`demo-ctl seed-archetypes`) |
| `request_debris(object_id)` | reducer | operator | queue a DEBRIS job now (also queued automatically by `publish_forecast` when `decayed_frac` ≥ 0.2 within 72 h; at most one QUEUED per object) |
| `create_fragment_event(parent_norad, kind, params)` (stretch) | reducer | operator | insert `fragment_event` + a FRAGMENT job |
| `publish_fragment(job_id, snapshots, ...)` (stretch) | reducer | worker | write `fragment_snapshot` rows; new tracked pieces are not added to `reentry_object` |
| `ask_assistant(text, lat?, lon?)` (planned) | reducer | anyone | text 1–500 chars, one question per 5 s per identity, at most 1 open ASK per identity; insert a `USER` message + an `ASK` job |
| `post_answer(job_id, text, data_mode, tools_used)` (planned) | reducer | assistant worker holding the job | finish ASK, insert the `ASSISTANT` message (max 2000 chars). If an ASK fails 3 times, the module posts "Couldn't answer right now" instead |
| `my_assistant_messages` (planned) | view | anyone | the caller's own conversation |

Scheduled reducers and procedures check `ctx.sender == ctx.databaseIdentity`, so clients cannot trigger them directly.

**Verified on maincloud (Oct 24, CLI 2.13):** the module publishes as `skyfall-calhacks`; procedures fetch NOAA and CelesTrak over HTTP and write in the same call; interval schedules fire about one interval after publish (so `poll` once after a fresh publish); a client reducer that throws `SenderError` rejects the caller's promise; a second worker holding the same identity is refused by `claim_job`'s lease check. Measured: sighting → new corridor on the big screen in 0.39 s (stub compute); GPU worker killed → CPU worker finished the next job 7 s later. NOAA's `10cm-flux.json` is a one-element array, not an object.
**Verified 2026-10-25 on a local `spacetime start`:** procedure HTTP works there. `poll_feeds_now` wrote NOAA (Kp and F10.7), CelesTrak `SPECIAL=DECAYING` (69 objects), and four CelesTrak SATCAT lookups. Space-Track was left disabled because the database had no credentials. This was a throwaway local database, not maincloud.

## One debris prediction, end to end (planned)
1. `celestrak_poll` brings new elements → `elements_history` + a FORECAST job.
2. The GPU worker runs `/forecast` for all objects → `publish_forecast` writes `forecast`. For each object with `decayed_frac ≥ 0.2` inside 72 h it queues a DEBRIS job (coalesced per object).
3. The worker claims each DEBRIS job (bulk lane, right after the forecast that queued it) and sends `/debris` the object's elements, `satellite_profile`, `archetype` and space weather. The compute reuses that object's cached forecast particles.
4. `publish_debris` writes the breakdown, footprints and sample tracks. Every globe redraws: falling pieces animate, and impact zones appear colored by size and material.
5. GX10 offline: the CPU worker (Vultr) runs the degraded settings, and the globe shows the red degraded banner.

## One sighting, end to end (parked)
1. Phone → `submit_sighting`. The module validates it and rate-limits per identity. No clip → `ACCEPTED` + one coalesced `UPDATE` job. Clip → `PENDING` + a `CLASSIFY` job. Every screen shows the pin at once.
2. A worker sees the `QUEUED` row on its subscription → `claim_job`. The module grants the lease to exactly one worker.
3. CLASSIFY: `POST /classify` → `set_verdict`. The module updates trust and queues the `UPDATE`.
4. UPDATE: the worker reads the object, accepted/held sightings, reporter trust and space weather from its subscription → `POST /update` → `publish_corridor` with per-sighting scores.
5. The module versions the corridor, logs history, adjusts verdicts and trust, and every screen animates the new corridor.
Target: tap to visible change in about 2 seconds. New sightings arriving while an UPDATE runs coalesce into the next one.

## gx10-compute API
- `POST /debris` → body `{object: {id, elements}, profile: {...}, archetype: {...}, space_weather?, n_particles?, seed?, as_of?}` → see `docs/DEBRIS_MODEL.md` §5. CUDA is required by default; `USE_GPU=0` explicitly opts into CPU-degraded mode. The SpacetimeDB DEBRIS job flow remains planned.
- `POST /fragment` (stretch) → body `{parent: {id, elements, mass_kg}, kind, params}` → fragment snapshots + decay dates
- `POST /forecast` → body `{objects: [{id, elements (GP/OMM JSON)}], space_weather?: {kp, f107}, as_of?}` → `{results: [{id, status, t_quantiles: {"5","25","50","75","95"}, decayed_frac, bands, area_km2_90, n_samples, ess, calibrated, bc_m2_kg}], ms, device, n_per_object, horizon_days, particle_steps}`. The physics is in `services/gx10-compute/sim.py`; see `docs/SIM_SPEC.md`
- `GET /health` → GPU name, free memory, model status, `use_gpu`, `debris_mode`, `debris_available`
- `POST /classify` → body `{image_b64 | clip_ref}` → `{label, confidence, reason}`; labels: `reentry`, `meteor`, `aircraft_or_train`, `nothing`
- `POST /update` → body `{object: {id, elements, window_start?, window_end?}, sightings: [{id, lat, lon, observed_at, bearing_deg?, trust}], space_weather?: {kp, f107}}` → `{bands: [{level, polygon}], area_km2_90, n_samples, ess, ms, scores: [{id, p_inlier}]}`
Polygons are GeoJSON-style `[lon, lat]` rings, simplified to at most a few hundred points before leaving compute. `trust` = `(agreed + accepted + 1) / (agreed + disagreed + accepted + rejected + 2)` from `reporter_stats`; compute lowers a sighting's outlier rate as trust rises (see SIM_SPEC.md).

## Assistant (planned): "what's coming down, and does any of it survive?"
A chat and voice panel on the globe (Grok, with Grok Voice). It answers only from our tables: what's coming down soon, near a place, which pieces of an object are predicted to survive and why (material, mass, demise altitude), how sure we are, and where the numbers come from. It never states a landing point as certain.

**Flow.** Phone or screen → `ask_assistant` → the module stores the question and queues an `ASK` job → the assistant worker claims it → calls Grok with the question, the user's location (if shared) and the lookup tools below → each tool call is answered from the worker's SpacetimeDB subscription (or a fixed file) → `post_answer` → the reply appears live through `my_assistant_messages`.

**Claiming.** `claim_job` gives `ASK` jobs only to `assistant` identities, and never gives CLASSIFY/UPDATE to them, so chat never delays the corridor. The assistant role is approved by the operator like a worker.

**Lookups (Grok function calls).** The model gets no raw page dump; it can only state what these return:
| Tool | Returns | Source |
|---|---|---|
| `get_objects()` | tracked and candidate objects: name, status, re-entry window, real or simulated | `reentry_object` |
| `get_debris(object_id)` | p(any survives), surviving mass, per-component survival, footprint area, archetype + sources, tier | `debris_forecast`, `debris_component`, `satellite_profile` |
| `get_forecast(object_id)` | re-entry time quantiles, chance inside horizon | `forecast` |
| `near_me(lat, lon, days)` | objects whose 90% footprint or forecast passes near the point | `debris_forecast`, `forecast` |
| `get_visibility(lat, lon, object_id, hours)` | upcoming passes over the user: rise time, max elevation, direction, whether it is sunlit while the sky is dark | computed in the worker from `elements` with satellite.js (check accuracy against a known pass) |
| `get_space_weather()` | Kp, F10.7 and their times; what they mean for re-entry timing | `space_weather` |

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

## 3D globe layers (web `/`, planned; CesiumJS recommended, see PIVOT.md)
Team ideas for the visualization (select a satellite → lines to predicted landing points, live `debris_piece` tracking, third-person satellite camera): `docs/VIS_NOTES.md`.
1. **Tracked objects** at their live positions (SGP4 in the browser from `reentry_object.elements`), with altitude; colored by forecast re-entry time; size by RCS/mass.
2. **Selected object:** orbit path for the next few hours, with the re-entry window marked along it.
3. **Falling debris:** `debris_track` polylines with altitude, animated on Cesium's clock (time slider); a pulse at each impact.
4. **Impact zones:** `debris_component.footprint` and `debris_forecast.footprint` (50/90%) on the surface, colored by material and sized by surviving mass.
5. **Tracked debris clouds** (should): CelesTrak debris groups as point clouds.
6. **Fragment cloud** (stretch): `fragment_snapshot` animated.
Panels: coming down next, selected-object breakdown (components: survive %, mass, material, demise altitude; archetype + sources), compute (GPU/CPU, particle-steps, degraded banner), live feeds, assistant.
Performance: one entity per object (hundreds), tracks only for the selected object or the top 5; heavy clouds as a primitive/point collection, not entities.

## Failure behavior
- GPU worker killed: its heartbeat stops → `sweep` marks it unhealthy within 10 s and expires its lease → the CPU worker's `claim_job` now succeeds → the corridor keeps updating, and the panel shows the switch.
- Compute down while a worker is up: the worker reports `healthy=false` and calls `fail_job`; jobs retry up to 3 times, then show as `FAILED`.
- Feed errors: written to `feed_status` and shown, never hidden. CelesTrak errors wait for the next 2-hour cycle.
- Worker restart: it re-subscribes; anything it held comes back through lease expiry.
- Debris job fails (bad profile, no archetype match): `fail_job` with the reason; the object falls back to the "generic" archetype on the next try and is marked low confidence.
- Assistant down or xAI failing: questions stay queued; after 3 failed attempts the user gets "Couldn't answer right now". The map and corridor are unaffected.
