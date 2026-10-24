# Data sources

Official sources and APIs only, no scraping. Orbital Radar (orbitalradar.com) is a UI reference only; we use its upstream sources directly. Endpoints, limits and politeness rules for the orbit feeds: `docs/LIVE_DATA_SOURCES.md`.

Who fetches:
- NOAA SWPC and CelesTrak: scheduled procedures **inside the SpacetimeDB module**.
- Space-Track and the large catalog downloads (GCAT, SATCAT, DISCOSweb): `services/feed-poller`, writing through reducers.

| Source | Used for | Status | Notes (**check** = verify before relying on it) |
|---|---|---|---|
| CelesTrak GP `SPECIAL=DECAYING` | Decaying objects + their orbit elements | Real, live (built) | No account. One download per 2 h update |
| NOAA SWPC Kp, F10.7 | Atmosphere density in the forecast and debris model | Real, live (built) | `10cm-flux.json` is a one-element array |
| CelesTrak debris groups (e.g. Cosmos 1408, Fengyun-1C, Iridium 33 / Cosmos 2251 debris) | Tracked debris clouds on the globe | Real (planned) | **Check** the exact `GROUP=` names on celestrak.org; same politeness rules |
| CelesTrak SATCAT | Object type (PAY / R/B / DEB), owner, launch date, radar cross-section size, decay date | Real (planned) | **Check** the CSV/JSON URL and columns. Decay dates support validation |
| GCAT (J. McDowell, planet4589.org) `satcat.tsv` | Mass, length, diameter, span, shape per object | Real catalog (planned) | Public. Many values are estimates flagged `?`; carry the flag into `confidence`. **Check** the column names in the `#` header |
| ESA DISCOSweb | Mass, shape, dimensions, cross-section | Real catalog (planned, optional) | Free account + API token. **Check** the auth scheme and rate limits |
| Space-Track (TIP, decay, GP history) | Official re-entry predictions, actual decay dates, historical elements for validation | Real (planned) | One account, never shared; < 30 req/min, < 300/h |
| Archetype component lists (`data/archetypes/`) | What each satellite class is made of | **Assumed**, from cited public sources | Every number cites a source or is marked "assumed" |
| Material properties (`data/materials.json`) | Melting point, heat capacity, heat of fusion | Literature values | **Check** against ESA DRAMA / NASA ORSAT tables |
| Recovered-debris cases (e.g. 2024 Dragon trunk pieces; Aerospace Corp re-entry database) | Validation | Real, public reports | **Check** the details and sources before quoting |
| Our own archive (`elements_history`, `forecast_history`) | Replaying a real re-entry from this weekend | Real (recording since Oct 24 ~11:00 PT) | |
| Synthetic sightings, Grok Imagine images | Old pipeline | Parked / dropped | |

## Rules
- Respect each provider's terms and rate limits; cache; never retry in a loop.
- Raw downloads go in `data/raw/` (git-ignored); commit only small samples.
- Every feed shows its last-success time and errors on screen.
- Catalog values marked as estimates stay marked; modeled outputs are labeled "modeled estimate".

## Accounts
Space-Track (free; Steven's machine only). DISCOSweb (free, optional). None needed for NOAA, CelesTrak or GCAT. See `docs/SETUP.md`.
