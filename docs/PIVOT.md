# Pivot: from re-entry tracker to debris prediction (Oct 24, after talking to SpaceX)

**Old idea:** show where a decaying satellite might come down, and shrink that corridor with crowd sightings.
**Why change:** plotting satellite positions is easy to copy, and the corridor alone says nothing about what actually reaches the ground.
**New idea:** **predict the debris.** For each satellite we track that is coming down (and, as a stretch goal, each breakup in orbit), the GX10 runs our own model of how it breaks apart. It estimates which pieces survive, how big they are and what they're made of, and where they land with what probability. Everything streams through SpacetimeDB to a **3D globe**.

> One line: *SKYFALL predicts what survives when satellites come down: which pieces, how big, and where they land, live on a 3D globe and computed on our own GPU.*

## Why this is a real problem
- More satellites means more re-entries. Large constellations replace thousands of satellites on short lifetimes, and rocket stages and debris add to it.
- Operators' break-up and survivability analyses (tools such as NASA DAS/ORSAT, ESA DRAMA, SCARAB) are mostly internal or need expert setup. The public sees an orbit dot, or nothing.
- Public statements about whether some satellites fully burn up have differed (check: FAA 2023 report vs SpaceX's response). An independent, transparent model is useful in that debate.

## What we can honestly claim
- We **model** debris from public data: orbit elements, size/mass/shape catalogs, space weather, and documented generic breakdowns per satellite class ("archetypes"). We do **not** have operators' internal designs. Every output is labeled **"modeled estimate"** with the archetype and assumptions behind it.
- We report **probabilities and ranges** (chance a piece survives, impact footprint at 50/90%), never a pinpoint.
- We test against public cases: past re-entries with recovered debris (check: Dragon trunk pieces found in 2024; Aerospace Corp re-entry database), and re-entries that happen this weekend while we archive the data.

---

## Scope (19 hours left at the time of writing; deadline Sunday 9:00 AM PT)

### Must have (the demo)
1. **Live object layer on a 3D globe.** Real tracked objects (CelesTrak decaying list and selected groups) moving in real time, colored by predicted re-entry time.
2. **Re-entry forecast** for every decaying object (already built, reused).
3. **Break-up and survivability simulation on the GX10.** For each object likely to re-enter within ~72 h:
   - Monte Carlo over re-entry states (from the forecast), break-up altitude and component properties.
   - Each component flies its own 3D trajectory with heating and melting.
   - Outputs: per piece, the chance it survives, its remaining mass, its impact zone and impact energy, plus the object's overall ground footprint.
4. **Debris on the globe:** falling trajectories in 3D (time-animated), impact zones colored by piece size and material, and a per-object breakdown panel (which components, what survives).
5. **SpacetimeDB as the backend:** jobs, failover, live updates, archive (reused) plus the new debris tables.
6. **Degraded mode:** without the GX10, few samples and wide, rough zones, clearly labeled.

### Should have
7. **Satellite profiles from real catalogs** (GCAT, CelesTrak SATCAT, DISCOSweb if we get an account), mapped to archetypes, with the source and confidence shown.
8. **Real tracked debris clouds** from past breakups (CelesTrak debris groups, e.g. Cosmos 1408, Fengyun-1C; check the group names) on the globe.
9. **Validation panel:** a real re-entry from this weekend, showing our forecast and footprint from hours before next to what happened.
10. **Grok Voice assistant** ("what's coming down near me, and does any of it survive?"), answering only from our tables. Needed for the SpaceXAI track.

### Stretch
11. **What-if breakup in orbit:** pick a satellite, apply the NASA Standard Breakup Model (explosion or collision), get thousands of fragments with sizes and area-to-mass ratios, and propagate the cloud on the GPU: how it spreads, and when pieces re-enter.
12. **Ground risk:** casualty area per surviving piece × population density → expected casualties against the 1-in-10,000 guideline (check NASA-STD-8719.14).
13. Fireball reports from the public (the old sighting pipeline) as extra evidence.

### Out of scope
Operator-specific internal designs, aerodynamic break-up physics beyond a lumped model, real-time radar.

---

## What we keep, change, park

| Piece | Status | Notes |
|---|---|---|
| SpacetimeDB job queue, two lanes, leases, GPU→CPU failover, worker approval | **Keep** | Add job kinds `DEBRIS` (fast-ish, per object) and later `FRAGMENT` (bulk) |
| Feeds inside the DB (NOAA, CelesTrak), `feed_status`, `space_weather` | **Keep** | Add SATCAT/GCAT and debris-group fetches |
| `forecast`, `forecast_history`, `elements_history`, `compute_run` | **Keep** | The forecast now feeds the debris job |
| `gx10-compute` service and `sim.py` orbit engine (SGP4, J2 + drag RK4, NRLMSIS, drag calibration) | **Keep + extend** | Return the full state at 80 km (not just lat/lon) as the start of the break-up |
| Worker (`gx10-bridge`), operator console (`demo-ctl`) | **Keep** | New job handlers and commands |
| Web data layer (SpacetimeDB React hooks, `live.ts` helpers) | **Keep** | Same subscriptions; new tables |
| 2D MapLibre map, corridor drawing | **Replace** | 3D globe (CesiumJS recommended) |
| Crowd sightings, reporter trust, replay clock, `/report` page | **Park** | Code stays; not in the demo. May return as "report a fireball" |
| Vision classifier + Grok Imagine test images | **Drop** | The Grok requirement is covered by Grok Voice |
| Phase 1 corridor stub | **Drop** | Only the placeholder replay object uses it |

Rough reuse: backend about 75%, compute about 40% (the orbit half), web about 30% (data layer only).

---

## Decisions (recommendations marked; confirm or change)
1. **Globe library: CesiumJS (recommended).** It's built for space: real 3D positions with altitude, time-animated paths, an ECEF/inertial-aware clock, and it works offline with its bundled Natural Earth imagery (no ion token needed). Alternative: globe.gl (three.js), which is prettier and quicker but weaker for time and altitude.
2. **Core debris type: re-entry break-up (recommended)**, with in-orbit breakup as a stretch. Re-entry break-up reuses our forecast and ends on the ground, which is the problem we're pitching.
3. **Archetypes instead of designs.** About 6 documented classes:
   - Starlink-class flat-panel satellite
   - generic small LEO satellite (100–500 kg)
   - CubeSat
   - rocket upper stage (e.g. CZ-6A, Falcon 9 second stage)
   - Dragon-trunk-like structure
   - large satellite (>1 t)
   Component lists use public numbers, with a source on each line.
4. **The replay is a real re-entry from this weekend** (archived live), if one with good data comes down. Otherwise use a past case with public debris reports.
5. The **4th sponsor track** is still open (Anthropic or Mana).
