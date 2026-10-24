# Visualization notes (for whoever builds the globe)

Ideas from the team (Oct 24) for the visualization side, with how each maps onto what's already planned. Contract: `docs/ARCHITECTURE.md`. Physics: `docs/DEBRIS_MODEL.md`. Scope and priorities: `docs/PIVOT.md`, `docs/DEV_PLAN.md`.

## 1. 3D Earth instead of the flat world map
- Replace the 2D MapLibre map (`web/src/MapView.tsx`) with a 3D model of the Earth. **CesiumJS is recommended** (real altitude, time slider, offline Natural Earth imagery, no account). Alternative: globe.gl / three.js.
- Satellites are drawn at their real altitude, not flat on the surface.
- Reuse: `web/src/orbit.ts` (SGP4 positions) and `web/src/live.ts` (subscription helpers) carry over unchanged.

## 2. Select one satellite → lines to where its debris could land
- Click a tracked satellite to select it (one at a time).
- Draw a **set of lines from the satellite to the points on Earth where its debris could land**: one line per predicted impact point or per component's impact zone.
  - Color by material or component (e.g. steel reaction wheel vs titanium tank).
  - Opacity or thickness by probability of surviving (`p_survive`).
  - Optional: end each line in a small 50%/90% impact ellipse.
- Data: `debris_component` (impact zone + survival chance per piece) and `debris_track` (sample falling trajectories with altitude) for the selected object. When the user wants the real falling path instead of a straight "sight line", draw the `debris_track` polylines.
- Keep it to the selected satellite (plus maybe the top 5 coming down) so the globe stays fast.

## 3. Satellite designs → debris generation (data + model side, feeds the globe)
- Collect public information about the designs of the satellites we track: mass, size, shape, and main components such as tanks, reaction wheels, solar panels and structure.
  - **Catalogs/APIs first:** GCAT, CelesTrak SATCAT, ESA DISCOSweb.
  - **Then public documents:** operator press kits and fact sheets, FCC filings, published papers, Wikipedia references.
  - **Rules for collecting it:**
    - Respect each site's terms and robots.txt; no bulk scraping where it's disallowed. Cite every source.
    - Prefer turning what we find into the documented archetype files (`data/archetypes/*.json`), not storing raw pages.
- Generate the possible ways each satellite breaks into debris from its **re-entry conditions** (speed, angle, altitude and time from the forecast) and its **design** (components):
  - **Physics simulation** (planned, `docs/DEBRIS_MODEL.md`): break-up altitude, heating, melting, surviving pieces.
  - **ML (idea):** a model that learns from the physics simulation's outputs to predict break-up results instantly (a surrogate model, e.g. for interactive "what if" sliders). There is no public ground-truth debris dataset to train on directly, so any ML model must be trained on our own simulations and labeled as such.

## 4. Database shape: one table of tracked satellites, plus a debris "subtable" per satellite
SpacetimeDB has no nested tables, so the "subtable" is a child table keyed by the satellite:
- **Tracked satellites:** `reentry_object` (orbit + status) + `satellite_profile` (design info, archetype, sources), one row per satellite.
- **Debris per satellite (the subtable):** `debris_component` rows keyed by `object_id`: the predicted pieces and their survival and impact zones.
- **Debris pieces tracked dynamically during re-entry** (idea, extends the plan): a `debris_piece` table keyed by `object_id`. The GX10 writes the pieces' positions while the satellite is re-entering (or during a replay), and every globe subscribed to that satellite's pieces animates them live.
  - Suggested fields: `id`, `object_id` (index), `component`, `material`, `mass_kg`, `t`, `lat`, `lon`, `alt_km`, `speed_ms`, `state` (`falling` | `demised` | `landed`).
  - If adopted, add it to `docs/ARCHITECTURE.md` in the same PR as the code.

## 5. If there's time: third-person camera from the satellite
- A camera mode that rides along with the selected satellite and looks down and ahead, so the user sees the predicted debris landing points (the lines from §2) from the satellite's own perspective.
- Cesium makes this fairly direct (camera tracking an entity with an offset, or `camera.lookAt` each frame from the satellite's position toward its velocity).
- Nice for the demo moment: follow the satellite into re-entry, then watch the pieces separate and fall.

## Priority (fits the dev plan)
1. 3D globe with live satellites (Block 1)
2. Select a satellite → lines/zones to predicted debris landing points (Block 2)
3. Falling-debris animation from `debris_track` (Block 2)
4. Live `debris_piece` tracking during re-entry (Block 3, if the data side is ready)
5. Third-person satellite camera (Block 4, stretch)
