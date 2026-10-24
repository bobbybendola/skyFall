> **Update Oct 24:** Space-Track explored with a live account. Limits, fields, catalog size and the TIP comparison are in `docs/SPACETRACK_NOTES.md`.

# Live data sources

Research notes for `services/feed-poller`. Checked 2026-10-24. "Verified" means one of two things: the field names came from a single unauthenticated fetch of the public endpoint that day, or the text came from the provider's own docs page. Anything marked **(check)** was not verified. Confirm it before relying on it (AGENTS.md rule).

We do **not** scrape orbitalradar.com and we do not recommend it. It documents no API. We use its upstream sources directly (see DATA_SOURCES.md).

> **Resolved in ARCHITECTURE.md (2026-10-24):** `report_feed_status`, a `space_weather` table and a `CANDIDATE` source/status were adopted. NOAA and CelesTrak are fetched by scheduled procedures inside the module (`noaa_poll`, `celestrak_poll`), not by the poller; the module enforces the CelesTrak 2-hour gap. Space-Track stays in `services/feed-poller`. `status` values: `PREDICTED | DECAYED | REPLAY | CANDIDATE`. The proposals below are kept for the record.

## TL;DR

| Feed | Endpoint | Auth | Limit / politeness | Poll |
|---|---|---|---|---|
| Space-Track TIP | `https://www.space-track.org/basicspacedata/query/class/tip/INSERT_EPOCH/%3Enow-0.042/format/json` | free account, cookie | <30 req/min, <300 req/hr; TIP 1/hr, or 1/10 min if re-entry < 12 h | 1 h (10 min near re-entry) |
| Space-Track decay | `.../class/decay/MSG_EPOCH/%3Enow-1/format/json` | same | once per day | 24 h (once at startup) |
| Space-Track GP | `.../class/gp/NORAD_CAT_ID/<id,id,...>/format/json` | same | once per hour, at an off-:00/:30 minute, batched | 1 h |
| CelesTrak GP | `https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=json` | none | ≤1 download per 2 h update, 403 on repeats | 2 h per query |
| CelesTrak decaying | `https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=json` | none | same | 2 h |
| CelesTrak SATCAT | `https://celestrak.org/satcat/records.php?CATNR=<id>&FORMAT=json` | none | same spirit | once per object |
| NOAA Kp | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | none | none published **(check)** | 15 min |
| NOAA Kp 1-min | `https://services.swpc.noaa.gov/json/planetary_k_index_1m.json` | none | **(check)** | 5 min (optional) |
| NOAA F10.7 | `https://services.swpc.noaa.gov/products/summary/10cm-flux.json` | none | **(check)** | 6 h |
| NOAA solar wind | `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json`, `.../rtsw_mag_1m.json` | none | **(check)** | 5 min (optional chip) |
| Launch Library 2 | `https://ll.thespacedevs.com/2.3.0/launches/upcoming/?mode=list` | none (free tier) | 15 req/hr unauthenticated | 1 h (optional) |
| ESA DISCOSweb / re-entry portal | account and token required | yes | **(check)** | not for demo |
| Aerospace Corp CORDS | no documented API | n/a | n/a | do not scrape |

---

## 1. Space-Track.org (18th/19th SDS, USSPACECOM)

**Provides:** the authoritative re-entry predictions.
- `tip`: Tracking and Impact Prediction messages, described as "Projected satellite reentry predictions for objects which have the potential for generating debris". TIP lat/lon is "the location above which an object is predicted to arrive at 10km altitude". Source: [documentation](https://www.space-track.org/documentation).
- `decay`: decay history plus predictions. Message types are SATCAT, Decay Entry, TIP Message and 60day Decay. A lower `PRECEDENCE` means more recent data ([documentation](https://www.space-track.org/documentation)).
- `gp`: "an efficient listing of the newest SGP4 keplerian element set" ([documentation](https://www.space-track.org/documentation)).

A Space-Track presentation to UNOOSA says TIPs are produced for objects over about 1 m² once they are within about 4 days of predicted re-entry ([UNOOSA slides](https://spacesustainability.unoosa.org/sites/spacesustainability.unoosa.org/files/unoosa_space-track_presentation_-_finalnotes.pdf)). On a given night the TIP list may therefore be empty. That is why the demo uses REPLAY.

**Auth / login flow:** create a free account. The poller authenticates with a cookie session:
```bash
curl -c cookies.txt -d "identity=$ST_USER&password=$ST_PASS" https://www.space-track.org/ajaxauth/login
curl -b cookies.txt "https://www.space-track.org/basicspacedata/query/class/tip/INSERT_EPOCH/%3Enow-0.042/format/json"
curl -b cookies.txt https://www.space-track.org/ajaxauth/logout
```
This POST `identity`/`password` → cookie flow is confirmed only by secondary sources ([Fabric thread](https://community.fabric.microsoft.com/t5/Power-Query/Power-Query-API-Authentication/m-p/3117522), [SpaceTrackSdk](https://github.com/hughesjs/SpaceTrackSdk)). The official how-to is behind the login wall **(check after creating the account)**.
- Watch out: a failed login can still return HTTP 200. Treat a missing session cookie as failure, and re-login once on a 401 ([SpaceTrackSdk](https://github.com/hughesjs/SpaceTrackSdk)).
- Keep credentials in `.env` (`SPACETRACK_USER`, `SPACETRACK_PASS`), never on the command line. The User Agreement forbids sharing a login ([documentation](https://www.space-track.org/documentation)). Use one account only: running several accounts to get around the limits is prohibited.

**Query URL syntax:** `https://www.space-track.org/basicspacedata/query/class/<class>/<FIELD>/<value>/.../format/json`. Operators are URL-encoded (`%3Enow-1` means "> now minus 1 day"). Comma lists (`1,2,3`), ranges (`100--200`) and `null-val` all work ([documentation](https://www.space-track.org/documentation)).

**Rate limits (verified):** "Limit API queries to less than **30 requests per 1 minute(s)** and **300 requests per 1 hour(s)**" ([documentation](https://www.space-track.org/documentation)). Your recollection was right. The per-class guidance from the same page:

| Class | Guidance |
|---|---|
| gp | Once per hour, "randomly choose a minute that is not at the top or bottom of the hour". Add `/decay_date/null-val/epoch/%3Enow-10/` for live objects only. Batch IDs comma-delimited; "Do not send hundreds of individual /class/gp/ … queries". |
| gp_history | Once per lifetime, then store locally. Useful for building the REPLAY event. |
| decay | Once per day with `/MSG_EPOCH/%3Enow-1/`. |
| tip | Once per hour with `/INSERT_EPOCH/%3Enow-0.042/`. If re-entry is < 12 h away, every 10 min with `/INSERT_EPOCH/%3Enow-0.005/`. |

**Does TIP need special access?** Basic TIP data in `basicspacedata/class/tip` does not appear to need special permission. The public docs only describe the query practice and say nothing about a gate. The *Advanced* "Deorbit and Reentry Support" products are a separate tier "available to all entities who sign an SSA Sharing Agreement" ([documentation](https://www.space-track.org/documentation)). Conclusion: a free account should be enough for `class/tip` **(check on first login)**.

**Terms (redistribution/display):** the User Agreement says "The User agrees not to transfer any data or technical information received from this website" without approval. However, "USSPACECOM has provided express blanket approval for transfer/redistribution of basic SSA data", provided it is properly cited, and "Publications of analysis based on USSPACECOM data also require appropriate citations" ([documentation](https://www.space-track.org/documentation)).
- Implication: showing TIP windows and GP-derived tracks on our public map should count as basic SSA data. **Cite "Source: USSPACECOM via Space-Track.org" in the UI.** Whether TIP counts as "basic SSA" is **(check)**.
- Do not expose raw bulk dumps to clients. The web app only sees our `reentry_object` rows, which also matches ARCHITECTURE.md.

**Key JSON fields** (field names inferred, not verified: the docs are behind login, **(check)**):
- `tip`: `NORAD_CAT_ID`, `MSG_EPOCH`, `INSERT_EPOCH`, `DECAY_EPOCH`, `WINDOW` (± minutes), `REV`, `DIRECTION`, `LAT`, `LON`, `INCL`, `NEXT_REPORT`, `HIGH_INTEREST`, `ID`. Only `INSERT_EPOCH` is confirmed, because the docs use it as a query filter.
- `decay`: `NORAD_CAT_ID`, `OBJECT_NAME`, `INTLDES`, `RCS_SIZE`, `COUNTRY`, `MSG_EPOCH`, `DECAY_EPOCH`, `SOURCE`, `MSG_TYPE`, `PRECEDENCE`. `PRECEDENCE` is confirmed and `DECAY_EPOCH` is a known filter ([apis.io spec](https://apis.io/apis/us-space-comman/us-space-comman-decay-and-reentry-api/)).
- `gp`: OMM keys, the same as the CelesTrak JSON below (`OBJECT_NAME`, `NORAD_CAT_ID`, `EPOCH`, `MEAN_MOTION`, `BSTAR`, …) plus extra fields such as `DECAY_DATE` and `TLE_LINE1`/`TLE_LINE2` **(check)**.

**SpacetimeDB mapping:**

| `reentry_object` field | From |
|---|---|
| `id` | `"TIP-" + NORAD_CAT_ID` (one row per object; newest TIP wins) |
| `name` | `decay.OBJECT_NAME` or `gp.OBJECT_NAME` (TIP rows may lack a name **(check)**) |
| `norad_id` | `NORAD_CAT_ID` |
| `source` | `TIP` |
| `window_start` / `window_end` | `DECAY_EPOCH ∓ WINDOW minutes` (UTC) |
| `elements` | latest `gp` record JSON for that ID (Space-Track gp or CelesTrak) plus the TIP `LAT/LON/DIRECTION/INCL` |
| `status` | e.g. `PREDICTED` (TIP present), `DECAYED` (decay `MSG_TYPE` historical) **(check enum; ARCHITECTURE.md does not define status values)** |
| `updated_at` | `INSERT_EPOCH` of the TIP, or poll time |

Reducer: `ingest_object`. Feed status rows: `feed = "spacetrack_tip" | "spacetrack_decay" | "spacetrack_gp"`.

---

## 2. CelesTrak (Dr. T.S. Kelso)

**Provides:** GP/OMM elements re-published from 18 SDS. No account is needed, which answers the open question in DATA_SOURCES.md.
- **GP query format** (verified, [gp-data-formats](https://celestrak.org/NORAD/documentation/gp-data-formats.php)): `https://celestrak.org/NORAD/elements/gp.php?{CATNR|INTDES|GROUP|NAME|SPECIAL}=VALUE&FORMAT=json`. Parameter names must be uppercase. `FORMAT` accepts TLE/3LE, 2LE, XML, KVN, JSON, JSON-PRETTY or CSV (the default is CSV).
  - One object: `https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json`
  - Group: `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json` (group names are on the [Current Data page](https://celestrak.org/NORAD/elements/))
  - **Re-entry candidates:** `https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=json`. This is documented. One fetch on 2026-10-24 returned 69 objects with the same fields as below. It is a good unauthenticated "about to re-enter" list.
- **SATCAT:** `https://celestrak.org/satcat/records.php?CATNR=25544&FORMAT=json`. It accepts `CATNR|INTDES|GROUP|NAME|SPECIAL` plus `ONORBIT`, `PAYLOADS`, `ACTIVE`, `MAX`. JSON is the default format. `DECAY_DATE` is ISO and blank if the object has not decayed. There is no documented "recent decays" filter ([satcat-format](https://celestrak.org/satcat/satcat-format.php)).

**Update cadence (verified):** CelesTrak checks for new GP data every 2 hours. 18 SDS updates GP two to three times a day ([gp-data-formats](https://celestrak.org/NORAD/documentation/gp-data-formats.php)).

**Politeness rules (verified, same page):**
- Do not poll faster than the 2 h cycle. Re-download only if your cached copy is more than 2 h old.
- Since 2026-03-26 CelesTrak enforces one download per update. A repeat request returns **HTTP 403** until the data changes (applied to Active/Starlink first, extending to all users).
- Check for HTTP 200. On any other status (301/403/404/500), stop and surface the error. Do not retry in a loop. **50 errors in 2 h gets your IP firewalled**, and a whole hackathon Wi-Fi network could share one IP.
- Use `celestrak.org`. The `.com` domain answers with a 301.

**Terms:** the docs above set usage rules. I found no explicit redistribution license **(check [celestrak.org](https://celestrak.org/) for a usage/terms page)**. Credit "CelesTrak" in the UI. The data originates from USSPACECOM, so the Space-Track citation norm applies too.

**Key JSON fields** (verified by fetch): `OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, EPHEMERIS_TYPE, CLASSIFICATION_TYPE, NORAD_CAT_ID, ELEMENT_SET_NO, REV_AT_EPOCH, BSTAR, MEAN_MOTION_DOT, MEAN_MOTION_DDOT`. The response is a JSON array, even for one object. SATCAT fields: `OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID, OBJECT_TYPE, OPS_STATUS_CODE, OWNER, LAUNCH_DATE, LAUNCH_SITE, DECAY_DATE, PERIOD, INCLINATION, APOGEE, PERIGEE, RCS, DATA_STATUS_CODE, ORBIT_CENTER, ORBIT_TYPE`.

**SpacetimeDB mapping:**
- GP for watchlist IDs: fill `reentry_object.elements` (the whole OMM object) and `updated_at` through `ingest_object` on the existing `TIP-<id>` row. Leave `window_*` untouched.
- SATCAT: `name` (and `DECAY_DATE` sets `status = DECAYED`) through `ingest_object`.
- `SPECIAL=DECAYING` objects with no TIP: `source` only allows `TIP | REPLAY`, so either (a) use them only to pick which IDs to watch, or (b) **proposal:** add a `CANDIDATE` source value. Option (b) needs an ARCHITECTURE.md edit.
- `feed_status.feed = "celestrak_gp"` / `"celestrak_decaying"`, with `rows_ingested` = array length.

---

## 3. NOAA SWPC (space weather)

**Provides:** the geomagnetic (Kp) and solar (F10.7) indices that drive thermospheric density, and so the drag uncertainty in SIM_SPEC.md. No auth. US Government data, generally public domain **(check the [SWPC disclaimer](https://www.swpc.noaa.gov/disclaimers))**. Credit "NOAA SWPC". No published rate limit **(check)**. All of these are static JSON files, so polling every few minutes is plenty.

All URLs below were fetched once on 2026-10-24 (HTTP 200). Directory listings: [/products/](https://services.swpc.noaa.gov/products/), [/json/](https://services.swpc.noaa.gov/json/).

| Product | URL | Fields (verified) | Cadence |
|---|---|---|---|
| Planetary Kp (3-hourly, ~7 days) | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | `time_tag, Kp, a_running, station_count` | 3 h |
| Kp observed + forecast | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json` | `time_tag, kp, observed, noaa_scale` | 3 h |
| Estimated Kp, 1-min | `https://services.swpc.noaa.gov/json/planetary_k_index_1m.json` | `time_tag, kp_index, estimated_kp, kp` | 1 min |
| F10.7 latest | `https://services.swpc.noaa.gov/products/summary/10cm-flux.json` | `flux, time_tag` | daily (~20:00 UTC) |
| F10.7 30-day | `https://services.swpc.noaa.gov/products/10cm-flux-30-day.json` | `time_tag, flux` | daily |
| F10.7 detail + 90-day mean | `https://services.swpc.noaa.gov/json/f107_cm_flux.json` | `time_tag, frequency, flux, reporting_schedule, ninety_day_mean, rec_count` | 3×/day |
| Solar wind plasma, 1-min | `https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` | `time_tag, active, source, proton_speed, proton_density, proton_temperature, …` | 1 min |
| Solar wind mag, 1-min | `https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json` | `time_tag, active, source, bt, bz_gsm, …` | 1 min |
| Latest wind speed | `https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json` | `proton_speed, time_tag` | 1 min |
| NOAA G/S/R scales | `https://services.swpc.noaa.gov/products/noaa-scales.json` | `{"0": {R, S, G, DateStamp, TimeStamp}, ...}` | minutes |

Gotchas found by fetching:
- The old `products/solar-wind/plasma-5-minute.json` and `mag-5-minute.json` URLs now return **404**. Use `json/rtsw/*` instead.
- `products/noaa-planetary-k-index.json` now returns an **array of objects**. Older tutorials show an array of arrays with a header row. Parse by key.
- `rtsw_*` contains rows from several spacecraft (e.g. `IMAP`, `SOLAR1`). Filter `active == true`.

**SpacetimeDB mapping:** no table in ARCHITECTURE.md holds space weather.
- **Proposal (needs an ARCHITECTURE.md edit):** a `space_weather` table (`key`, `kp`, `f107`, `f107_81d_or_90d`, `sw_speed`, `observed_at`, `updated_at`) and an `ingest_space_weather` reducer (poller identity).
- Until that exists: record health in `feed_status` (`feed = "noaa_kp"`, `"noaa_f107"`) and pass Kp/F10.7 to compute from the poller's cache. Alternatively, stash them inside `reentry_object.elements` as `elements.space_weather`. That avoids a schema change but is less clean.
- Either way, `feed_status` needs a writer. ARCHITECTURE.md lists no reducer for it. **Proposal:** `report_feed_status(feed, ok, error?, rows)` (poller identity), which upserts `last_ok_at` / `last_error` / `rows_ingested`.

---

## 4. The Space Devs, Launch Library 2

**Provides:** launches and events (e.g. upcoming launches, "re-entry" style events **(check)**). This is context only and does not feed the corridor. Base URL `https://ll.thespacedevs.com/2.3.0/`. Example `launches/upcoming/?limit=1&mode=list` returned HTTP 200 with `count, next, results[].{id, name, status, net, net_precision, launch_designator, last_updated}`.
- **Limit (verified):** "free for up to **15 non-authenticated requests per hour**". Higher rates come through Patreon ([llapi](https://thespacedevs.com/llapi)). A dev mirror `lldev.thespacedevs.com` with stale data and no limit exists **(check)**.
- **Terms:** free; attribution expected **(check [docs](https://ll.thespacedevs.com/docs))**.
- **Mapping:** none required. If used, `feed_status.feed = "ll2"` only. Poll at most hourly.

## 5. ESA (DISCOSweb and the Re-entry Prediction portal)

- [DISCOSweb](https://discosweb.esoc.esa.int/) has a REST API (believed to be JSON:API with a Bearer token from your account, plus a `reentries` resource **(check)**). It requires an ESA account; we could only reach the OAuth login redirect.
- The [ESA Re-entry Prediction portal](https://reentry.esoc.esa.int/) has Register/Login. No public API or terms were visible without logging in **(check)**.
- Recommendation: skip for the hackathon. If used, it needs an account and the terms must be read first. **Do not scrape.**

## 6. Aerospace Corp CORDS re-entry list

- [aerospace.org/reentries](https://aerospace.org/reentries/grid?page=22) is a web listing with predictions, plus CSV downloads for data older than 2 years. **No documented API.** Its terms are behind the site's "Copyright and Terms of Use" link **(check)**.
- Recommendation: link to it for humans only. **Do not scrape.** Ask Aerospace if we ever want a feed.

## Not used
- orbitalradar.com: no API, and it is a downstream consumer of the sources above. **Do not scrape.**

---

## Recommended polling plan for the demo

Budget: Space-Track about 6 req/hr, far under 300/hr. CelesTrak 1 request per query per 2 h. NOAA about 20 req/hr. Cache every raw response in `data/raw/` with a timestamp. If the poller restarts, serve from cache and don't refetch until it is stale.

1. **Startup:** Space-Track login, then `decay` (`MSG_EPOCH >now-1`, once per day), then `tip` (`INSERT_EPOCH >now-0.042`). Upsert each TIP object through `ingest_object` with `source=TIP`.
2. **Every hour at a random off-:00/:30 minute:** run `tip`. Then run one batched `gp` query for all TIP IDs (comma list), or CelesTrak GP per ID if we prefer no-auth. Switch TIP to every 10 min with `INSERT_EPOCH >now-0.005` if any `DECAY_EPOCH` is < 12 h away.
3. **Every 2 h:** CelesTrak `SPECIAL=DECAYING` (one request) as the candidate list and fallback element source. Read the file mtime first, and never refetch within 2 h. On a non-200 response, stop that feed and write `last_error`.
4. **Every 15 min:** NOAA Kp. **Every 6 h:** F10.7. **Every 5 min (optional chip):** `summary/solar-wind-speed.json`.
5. **After every fetch:** update `feed_status` (proposed `report_feed_status`) so the UI shows last-success time and any error, never hidden.
6. **REPLAY event:** pull its history once, before the event, with Space-Track `gp_history` (once per lifetime). Freeze it into `data/replay/`. It never touches live polling.

## Open questions
1. Confirm the TIP field names and that a free account can read `class/tip` (first login).
2. Does "basic SSA data" blanket redistribution cover TIP windows on a public page? Add the citation either way.
3. ARCHITECTURE.md has no reducer for `feed_status` and no table for space weather. Should we adopt the proposed `report_feed_status`, `space_weather` and `ingest_space_weather`, or stash the values in `elements`?
4. `reentry_object.status` has no defined values. Pick an enum (e.g. `PREDICTED | DECAYED | REPLAY`).
5. Should CelesTrak `DECAYING` objects without a TIP appear on the map? That needs a new `source` value.
6. Venue NAT: the whole hackathon may share one IP towards CelesTrak, so 403s may be caused by other people. Treat 403 as "use cache" and never retry-loop.
7. Is there an explicit CelesTrak redistribution/terms page, and are there NOAA SWPC request limits?
