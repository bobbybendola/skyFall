# Architecture

## Components and responsibilities

| Component | Runs on | Language | Job | Talks to |
|---|---|---|---|---|
| SpacetimeDB module | local server / maincloud (check) | TypeScript | All shared state, validation, who-may-write rules | everything below via subscriptions + reducers |
| web | laptops, phones | React + MapLibre GL | Big-screen map (`/`), phone sighting page (`/report`) | SpacetimeDB only |
| feed-poller | any laptop (or GX10) | Node/TS | Pull Space-Track, CelesTrak, NOAA; write via reducers | external feeds, SpacetimeDB |
| gx10-bridge | the GX10 | Node/TS | Subscribe to new sightings; call compute; write verdicts/corridors | SpacetimeDB, gx10-compute (localhost) |
| gx10-compute | the GX10 | Python + PyTorch (CUDA 13) | Orbit Monte Carlo + sighting classification | gx10-bridge only |
| imagine-gen | laptop | Python/TS | Offline: generate labeled synthetic images with Grok Imagine | xAI API, `data/synthetic-images/` |
| sighting-gen | laptop/GX10 | Python | Offline: noisy synthetic sightings from the replay's true path + scoring | `data/replay/` |

Rules:
- Only SpacetimeDB holds shared state.
- gx10-compute never touches SpacetimeDB. gx10-bridge is the only adapter.
- The web app never calls the GX10 or any external feed directly.

## Diagram
```
 Space-Track TIP/decay ─┐
 CelesTrak GP elements ─┼─► feed-poller ──reducers──► ┌──────────────────┐
 NOAA SWPC ─────────────┘                              │   SpacetimeDB    │
 Phones (/report) ◄─────── subscriptions ────────────► │ tables+reducers  │
 Big screen (/) ◄────────── subscriptions ───────────► └────────▲─────────┘
                                                                │ subscribe + reducers
                                                        ┌───────┴────────┐
                                                        │ gx10-bridge    │  (GX10)
                                                        └───────┬────────┘
                                                          HTTP localhost
                                                        ┌───────┴────────┐
                                                        │ gx10-compute   │  (GX10, CUDA)
                                                        └────────────────┘
```

## Tables
Public unless noted. Field lists are the contract; add fields only by editing this file too.

- `reentry_object`: `id`, `name`, `norad_id`, `source` (`TIP` | `REPLAY`), `window_start`, `window_end`, `elements` (JSON/GP fields), `status`, `updated_at`
- `sighting`: `id`, `object_id`, `lat`, `lon`, `observed_at`, `bearing_deg?`, `clip_ref?`, `reporter` (identity), `mode` (`DEMO` | `LIVE`), `verdict` (`PENDING` | `ACCEPTED` | `HELD` | `REJECTED`), `reason`
- `corridor`: `object_id` (unique), `version`, `bands` (JSON array of `{level, polygon}`), `area_km2_90`, `n_samples`, `n_sightings_used`, `computed_at`
- `compute_status`: `worker` (identity), `variants_run_total`, `last_job_ms`, `sightings_classified`, `healthy`
- `feed_status`: `feed`, `last_ok_at`, `last_error`, `rows_ingested`
- `replay_state`: `running`, `t_offset`, `event_id`
- `worker_registry` (private): identity allowed to write verdicts, corridors and compute status

## Reducers
| Reducer | Who may call | Effect |
|---|---|---|
| `ingest_object` | poller identity | upsert `reentry_object` |
| `submit_sighting` | anyone | validate, insert `PENDING` |
| `set_verdict` | worker | set verdict + reason |
| `publish_corridor` | worker | replace the object's `corridor` row |
| `report_compute_status` | worker | update `compute_status` |
| `start_replay`, `reset_demo` | operator | drive the demo, clear demo sightings, reset corridor |
| `register_worker` | owner, once | store worker identity in `worker_registry` |

Identity checks: confirm the exact SpacetimeDB identity API in the docs during Phase 1 (**check**). If it is awkward, use a single trusted worker identity compared inside the reducer and document the limit.

## One sighting, end to end
1. Phone → `submit_sighting` → `PENDING` row; big screen shows a grey pin.
2. gx10-bridge sees the row → `POST /classify` (if a clip exists) → `set_verdict`.
3. If accepted/held → bridge gathers all accepted/held sightings for the object → `POST /update`.
4. Compute returns bands + area → bridge → `publish_corridor`.
5. Every subscribed screen animates the new corridor.
Target: a tap to a visible change in about 2 seconds.

## gx10-compute API
- `GET /health` → GPU name, free memory, model status, `use_gpu`
- `POST /classify` → body `{image_b64 | clip_ref}` → `{label, confidence, reason}`; labels: `reentry`, `meteor`, `aircraft_or_train`, `nothing`
- `POST /update` → body `{object: {elements, window_start, window_end}, sightings: [{lat, lon, observed_at, bearing_deg?}]}` → `{bands: [{level, polygon}], area_km2_90, n_samples, ess, ms}`
Polygons are GeoJSON-style `[lon, lat]` rings, simplified to at most a few hundred points before leaving compute.

## Map layers (web `/`)
1. Corridor bands (50% and 90%), animated between versions
2. Sighting pins (grey pending, green accepted, orange held, dark grey rejected with the reason on tap)
3. Predicted ground track with a moving marker during replay
4. Optional context overlay (no "flights affected" count unless backed by data)
Panels: object + feed status, GX10 status, timeline, before/after area.

## Failure behavior
- Compute down: bridge marks `compute_status.healthy=false`; sightings stay `PENDING`; UI shows it.
- Feed errors: shown in `feed_status`, never hidden.
- Bridge restart: on reconnect it re-subscribes and processes any `PENDING` sightings.
