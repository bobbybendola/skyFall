# Space-Track: what we found and how G1 should use it (Oct 24, ~21:45 UTC)

Explored with Steven's logged-in session: the API docs page plus 5 small queries (well under the limits). **Credentials never go in the repo.** The feed-poller reads `SPACETRACK_USER` / `SPACETRACK_PASS` from `.env` on Steven's machine only (one account, never shared; the User Agreement forbids sharing).

## Limits (from https://www.space-track.org/documentation, "API Use Guidelines")
- **< 30 requests/minute and < 300/hour**, one account only. Breaking these can get the account suspended.
- Data-specific rates:

| Class | Max rate | How |
|---|---|---|
| `gp` (current elements, whole catalog) | **1 / hour** | Pick a minute 10–20 min off the hour (e.g. :19 / :48). Once at start: `/class/gp/decay_date/null-val/epoch/%3Enow-10/format/json`. Hourly, changes only: `/class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.042/format/json` |
| `tip` (official re-entry predictions) | 1 / hour; **every 10 min** for an object re-entering within 12 h | `/class/tip/INSERT_EPOCH/%3Enow-0.042/format/json` (hourly) or `%3Enow-0.005` (10 min) |
| `satcat` (catalog metadata) | **1 / day**, after 17:00 UTC | Changed records only: `/class/satcat/file/%3E<last file number>` |
| `decay` (decay history / announcements) | 1 / day; store it, never re-download | `/class/decay/MSG_EPOCH/%3Enow-1/format/json` |
| `gp_history` | **1 / lifetime** per object/range | Comma list of NORAD IDs + a short epoch range; or the yearly zip files |
| `boxscore` | 1 / day | Totals by country |
| `cdm_public` (conjunctions) | 3 / day | Possible stretch: close approaches |

Never send one request per satellite: combine IDs with commas.

## What the data looks like
- **Catalog size right now (on-orbit, element sets < 10 days old):**
  - 18,904 payloads
  - 2,207 rocket bodies
  - **10,056 debris**
  - ≈ **31,200 objects** in total
- **`gp` row fields** (JSON; OMM keywords, the same as CelesTrak, so `sim.py`, `orbit.ts` and SGP4 work unchanged):
  - elements: `OBJECT_NAME`, `OBJECT_ID`, `EPOCH`, `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY`, `BSTAR`, `MEAN_MOTION_DOT`, `MEAN_MOTION_DDOT`, `SEMIMAJOR_AXIS`, `PERIOD`, `APOAPSIS`, `PERIAPSIS`
  - catalog metadata: **`OBJECT_TYPE`** (PAYLOAD / ROCKET BODY / DEBRIS / UNKNOWN), **`RCS_SIZE`** (SMALL / MEDIUM / LARGE), `COUNTRY_CODE`, `LAUNCH_DATE`, `SITE`, `DECAY_DATE`
  - bookkeeping: `NORAD_CAT_ID`, `GP_ID`, `FILE`, `CREATION_DATE`, plus `TLE_LINE0..2`
- **Example low debris (lowest perigee):**

  | NORAD | Object | RCS | Perigee × apogee |
  |---|---|---|---|
  | 32374 | BREEZE-M DEB (TANK) | LARGE | 161 × 13,831 km |
  | 28947 | ARIANE 5 DEB (SYLDA) | LARGE | 187 × 3,183 km |
  | 28264 | DELTA 2 DEB | MEDIUM | 190 × 7,652 km |
  | 36983 | TITAN 3C TRANSTAGE DEB | MEDIUM | 197 × 9,975 km |

  Tanks and structural parts like these are exactly our story.
- **`tip` rows:**
  - fields: `NORAD_CAT_ID`, `MSG_EPOCH`, `INSERT_EPOCH`, `DECAY_EPOCH` (predicted re-entry), `WINDOW` (± minutes, ~95%), `REV`, `DIRECTION`, `LAT`, `LON` (0–360 east), `INCL`, `NEXT_REPORT`, `HIGH_INTEREST`
  - **LAT/LON is the point 10 km above which the object passes at `DECAY_EPOCH`, not an impact point.**
  - Last 2 days: 29 messages for 12 objects, several of them already in our forecast list.

## Finding: our forecast runs about 7–11 hours late (fix before the demo)
| Object | TIP (official) | Our CPU forecast (run 17:55 UTC) |
|---|---|---|
| 47625 | Oct 24 18:11 ±60 min | median Oct 25 05:24 (5%: 01:09) |
| 45671 | Oct 25 02:13 ±120 min | median Oct 25 10:52 |
| 46066 | Oct 25 11:15 ±240 min | median Oct 25 17:58 |
| 57416 STARLINK-30224 | Oct 24 18:06 ±56 min | one run said "likely already re-entered" |

**Likely cause:** we calibrate drag to `MEAN_MOTION_DOT`, which averages the decay over the days of tracking data behind the element set. Decay speeds up sharply in the last day, so we predict too late.

**Fixes for R2:**
- calibrate from the change between recent element sets in `elements_history` (or `gp_history` once per object)
- condition on TIP when one exists (treat `DECAY_EPOCH ± WINDOW` as an observation, like a sighting)
- report this comparison honestly in the validation panel

TIP is our **ground truth for validation**. Store every TIP message.

## How G1 (globe core) uses this
1. **Whole-catalog layer:** ~31k objects as one point collection, colored by `OBJECT_TYPE` (payload / rocket body / debris) and sized by `RCS_SIZE`, with filter toggles (e.g. "debris only", "re-entering this week"). Decaying objects highlighted.
2. **Positions:** SGP4 in the browser for 31k objects is ~0.5 s per update. Update every few seconds in a Web Worker, or only near the camera; or (GPU story) let the GX10 propagate the catalog and stream packed positions (see the `fragment_snapshot` pattern in ARCHITECTURE.md).
3. **TIP markers:** for objects with a TIP, a marker at `LAT`/`LON` (convert LON 0–360 → −180–180) labeled with `DECAY_EPOCH ± WINDOW`, and the "10 km above, not impact" note in the tooltip.
4. **Selection:** clicking any object shows name, type, RCS size, perigee/apogee and launch date; debris prediction (G2/G3) applies to objects with a forecast.

## Backend changes this implies (R3; add to ARCHITECTURE.md when built)
- `catalog_object` table (planned): one row per tracked object. Fields:
  - `norad_id` pk, `name`, `object_type`, `rcs_size`, `country`, `launch_date`
  - `periapsis_km`, `apoapsis_km`, `epoch`, `elements` (JSON), `updated_at`

  Written in chunks of ~1,000 rows per reducer call (reducer argument size). `reentry_object` stays the "watch" set that gets forecasts.
- `tip_message` table (planned): every TIP, keyed by `ID`. Each new TIP for a watched object queues a FORECAST/DEBRIS refresh.
- `services/feed-poller` (Node) on Steven's machine:
  - log in with `POST /ajaxauth/login` (`identity`, `password` from `.env`) and keep the session cookie
  - schedule: GP hourly at :19, TIP hourly (every 10 min when an object is < 12 h out), SATCAT and DECAY daily after 17:00 UTC
  - log every call to `feed_status`, and hard-cap requests at 20/min in code
