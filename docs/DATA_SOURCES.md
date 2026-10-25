# Data sources

Official sources and APIs only, no scraping. Orbital Radar (orbitalradar.com) is a UI reference only; we use its upstream sources directly. Endpoints, limits and politeness rules for the orbit feeds: `docs/LIVE_DATA_SOURCES.md`.

Who fetches:
- NOAA SWPC and CelesTrak: scheduled procedures **inside the SpacetimeDB module**.
- CelesTrak SATCAT decay dates for objects already in `elements_history`: the module's `outcome_poll` (one catalog number per request, at most 4 per 2 h).
- Space-Track decay and TIP: the same procedure, only when the database has both `SPACETRACK_USER` and `SPACETRACK_PASS`. Otherwise the feeds are recorded as disabled. Large catalog downloads (GCAT, full SATCAT, DISCOSweb) stay in `services/feed-poller`.

| Source | Used for | Status | Notes (**check** = verify before relying on it) |
|---|---|---|---|
| CelesTrak GP `SPECIAL=DECAYING` | Decaying objects + their orbit elements | Real, live (built) | No account. One download per 2 h update |
| NOAA SWPC Kp, F10.7 | Atmosphere density in the forecast and debris model | Real, live (built) | `10cm-flux.json` is a one-element array |
| CelesTrak debris groups (e.g. Cosmos 1408, Fengyun-1C, Iridium 33 / Cosmos 2251 debris) | Tracked debris clouds on the globe | Real (planned) | **Check** the exact `GROUP=` names on celestrak.org; same politeness rules |
| CelesTrak SATCAT | Object type (PAY / R/B / DEB), owner, launch date, radar cross-section size, decay date | Real (decay dates built) | `https://celestrak.org/satcat/records.php?CATNR=<id>&FORMAT=json`. `CATNR` is one id. `DECAY_DATE` is `YYYY-MM-DD` or empty (verified 2026-10-25 on 23852 and 47782). Stored as 00:00:00Z |
| GCAT (J. McDowell, planet4589.org) `satcat.tsv` | Mass, length, diameter, span, shape per object | Real catalog (planned) | Public. Many values are estimates flagged `?`; carry the flag into `confidence`. **Check** the column names in the `#` header |
| ESA DISCOSweb | Mass, shape, dimensions, cross-section | Real catalog (planned, optional) | Free account + API token. **Check** the auth scheme and rate limits |
| Space-Track (TIP, decay, GP history) | Official re-entry predictions, actual decay dates, historical elements for validation | Decay + TIP path built, off without credentials. Not called in the local test | One account, never shared; decay 1/day and TIP 1/hour, combined by NORAD id. `gp_history` is still not fetched (1/lifetime, needs the account) |
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
