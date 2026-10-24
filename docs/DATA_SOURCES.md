# Data sources

Orbital Radar (orbitalradar.com) is a reference for what a good UI looks like. It documents no API and credits Space-Track, CelesTrak and NOAA SWPC as its sources, so we use those directly. We do not scrape it. If we want its feed, we ask them (no message is sent without the team's go-ahead).

Who fetches: NOAA SWPC and CelesTrak are fetched **inside the SpacetimeDB module** by scheduled procedures (`noaa_poll`, `celestrak_poll`). Space-Track is fetched by `services/feed-poller` (login session, strict budget). Details and URLs: `docs/LIVE_DATA_SOURCES.md`.

| Source | Used for | Real/simulated | Notes (check items marked) |
|---|---|---|---|
| Space-Track decay / Tracking and Impact Prediction (TIP) | Watchlist of objects about to re-enter, predicted windows | Real | Needs a free account. Check fields, rate limits and whether entries exist tonight. Poll politely and cache. |
| CelesTrak GP | Current orbital elements for the watchlist objects | Real | Check the exact JSON query URL on celestrak.org. |
| NOAA SWPC | Solar and geomagnetic indices; drives the drag-uncertainty scale and a live chip | Real | Public JSON feeds. Check endpoints. |
| Replay event (`data/replay/`) | The demo re-entry with a known true path | Replay | Frozen elements + true ground track. Labeled REPLAY on screen. |
| CelesTrak `SPECIAL=DECAYING` | Live candidate objects on the map | Real | `source = CANDIDATE`. No account. |
| Synthetic sightings (`tools/sighting-gen`) | Demo sightings | Simulated | Noise model in SIM_SPEC.md. Loaded with `load_replay_script`, emitted by the module as `mode = SIM`. Teammate taps are `DEMO`. |
| Synthetic images (`tools/imagine-gen`) | Test set for the classifier | Synthetic | Generated with Grok Imagine, labeled. |

## Rules
- Respect each provider's terms and rate limits. Cache responses locally.
- Raw responses go in `data/raw/` (git-ignored); only small frozen samples needed for the replay are committed.
- The UI shows each feed's last-success time and any error.
- Never present replay or simulated data as live.

## Accounts to create
Space-Track (free). No account is needed for NOAA SWPC or CelesTrak. See `docs/SETUP.md`.
