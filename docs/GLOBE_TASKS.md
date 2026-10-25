# 3D globe: tasks for 4 people

Ideas and background: `docs/VIS_NOTES.md`. Data contract: `docs/ARCHITECTURE.md` (tables) and `docs/DEBRIS_MODEL.md` §5 (debris result shape).
Stack: React + Vite + **CesiumJS** (imperative, no wrapper library) + SpacetimeDB React hooks. Everything lives in `web/`.

## How the work is split
**G1 (the globe core) merges first.** It gives everyone the shared pieces:
- `GlobeView` component and `useViewer()`
- satellites on the globe with selection (`selectedId`)
- Cesium's clock and timeline
- mock debris data (`web/src/mock/debris.ts`), so G2–G4 can build before the real debris tables exist

After G1 lands, G2, G3 and G4 work in parallel. Each owns its own files and adds one hook call in `Globe.tsx`, which keeps merge conflicts small.

| | Owner | Branch | Files | Depends on |
|---|---|---|---|---|
| **G1** | teammate 1 (Steven) | `feat/globe-3d` | `web/src/globe/GlobeView.tsx`, `satellites.ts`, `cesium-setup.ts`, `mock/debris.ts`, `Globe.tsx` | — |
| **G2** | teammate 2 | `feat/globe-debris-lines` | `web/src/globe/debrisLines.ts`, `impactZones.ts` | G1 |
| **G3** | teammate 3 | `feat/globe-animation` | `web/src/globe/fallingDebris.ts`, `liveDebris.ts`, `satCamera.ts` | G1 |
| **G4** | teammate 4 | `feat/globe-panels` | `web/src/panels/*` (coming down next, breakdown, compute + degraded banner, sources, assistant slot) | G1 |

Branch each of G2–G4 from `feat/globe-3d` once G1 is merged to main (or from the branch tip if you start earlier), and open your PR against `main`.

---

## G1: globe core (stages 1–4 done in PR from `feat/globe-3d`; catalog + TIP layers wait on R3)
**Data for G1: read `docs/SPACETRACK_NOTES.md`** (the ~31k-object catalog with type and radar size, TIP re-entry markers, rate limits).
- [ ] Whole-catalog layer: ~31k objects colored by type (payload / rocket body / debris), sized by radar size, with filter toggles; decaying objects highlighted (needs R3's `catalog_object`; until then use `reentry_object`)
- [ ] TIP markers for objects with an official re-entry prediction (`DECAY_EPOCH ± WINDOW`; the point is 10 km up, not an impact)
- [x] Add CesiumJS to `web/` (copy its Workers/Assets/Widgets to `web/public/cesium` with a small script, set `CESIUM_BASE_URL`), offline Natural Earth imagery, no Cesium ion account
- [x] `GlobeView`: one Cesium Viewer for the whole app. Exposes the viewer through context (`useViewer()`); timeline + animation widgets on; real-time clock by default
- [x] Satellites: every `reentry_object` with orbit elements as a point at its **real altitude** (SGP4 from `orbit.ts`), updated with the Cesium clock (so scrubbing the timeline moves them). Color by forecast re-entry time (soon = red → later = yellow; no forecast = grey); one point collection for speed
- [x] Select: click a satellite → `selectedId` in shared state; draw its orbit path for the next ~3 h (with altitude) and a label (name, NORAD, re-entry median)
- [x] Mock debris for the selected object, in the exact `/debris` result shape, until `debris_*` tables exist
- **Done when:** the live objects from the DB move on the 3D globe, clicking one shows its orbit path and label, and the timeline moves everything. ✅

**How to plug in (G2–G4):**
- In `web/src/Globe.tsx` → `Layers`, add one hook call: `useDebrisLines(viewer, debris)` (G2) or `useFallingDebris(viewer, debris)` (G3); G4 renders panels inside `<GlobeView>`.
- `debris` comes from `useSelectedDebris()` (`web/src/globe/debris.ts`), typed by `web/src/globe/debrisTypes.ts`. It is MOCK today (label it), and becomes live when the debris tables land, without consumer changes.
- Selection: `useSelected()` / `setSelected()` in `web/src/globe/selection.ts`.
- Clock: `viewer.clock` (real time; the timeline spans now − 1 h → now + 4 days).
- Material colors: `MATERIAL_COLOR` in `debrisTypes.ts`.

## G2: lines to landing points + impact zones (teammate 2; done in PR from `feat/globe-debris-lines`)
- [x] For the selected satellite: a **line from the satellite to each predicted landing point**, one per component (or per sampled impact).
  - Color by material: steel = blue-grey, titanium = white, aluminium = orange, CFRP = black, other = purple.
  - Opacity and width by `p_survive`. Lines follow the satellite as it moves.
- [x] Impact zones on the surface: each component's 50/90% footprint polygons (`debris_component.footprint`), plus the combined footprint (`debris_forecast.footprint`). Clamped to the ground; translucent fill + outline.
- [x] Hover/click a line or zone → show component, material, survive %, mass, impact energy (tooltip; G4 owns the panel).
- [x] Toggle: "show only pieces with ≥ 10% survival".
- Data: mock first (`mock/debris.ts`), then `useTable(tables.debrisComponent)` filtered by `objectId` once R3's schema lands.
- **Done when:** selecting a satellite shows colored lines to landing zones, and the zones read clearly from orbit height and when zoomed in. ✅ (checked in headless Chrome against live objects + mock debris)

**How G2 works (for G3/G4 and the live-data switch):**
- One call in `Globe.tsx`: `const debrisUi = useDebrisLines(viewer, debris)`, rendered as `{debrisUi}` (toggle + MOCK/modeled label + tooltip). Files: `globe/debrisLines.ts` (lines, landing markers, hover/click), `globe/impactZones.ts` (zones), `globe/debrisPick.ts` (toggle + tooltip stores, `materialColor`), `globe/debrisOverlay.tsx` + `.css`.
- **Where a line starts:** the landing zones belong to the forecast re-entry time, but the satellite may be anywhere on its orbit at the current clock time. A line starts at the live satellite (G1's `selected-orbit:<id>` entity) while its landing point is above the satellite's horizon (e.g. when the clock is at break-up), otherwise at `debris.breakup`, so lines never cut through the Earth.
- Landing point per component: `impact` (mock), else the real `/debris` `footprint.center` (`[lon, lat]`). If the real `footprint.samples` are present, up to 12 faint extra lines per component show the spread.
- Each layer is its own `CustomDataSource` (`g2-debris-lines`, `g2-impact-zones`), removed when the selection changes. Clicking a G2 line/zone pins its tooltip and does not change the selection.
- **Live data (after #8):** `debris.ts` maps the `debris_*` tables to this shape (`impact` from `impact_lat/lon`, `breakup` JSON). Open R2/R3 item: the GX10 `/debris` result must carry `breakup` and per-component `impact` for those columns (it currently returns `entry_time` and `footprint.center`). Until then live components have no landing point (the module stores only `footprint.bands`), so G2 shows their zones but no lines; it uses `footprint.center` if a future adapter passes it, and without a valid `breakup` it draws no line rather than NaN positions.

## G3: falling-debris animation, live pieces, satellite camera (teammate 3)
- [ ] Falling paths: for the selected object, turn `debris_track.points` (`[t, lat, lon, alt_km]`) into Cesium time-dynamic positions (`SampledPositionProperty`) so pieces fall in 3D as the clock plays.
  - Show a fading trail.
  - When a piece burns up (demised track), fade it out with a small flash at its demise altitude.
  - When a piece lands, show a pulse at the impact point.
- [ ] "Play re-entry" button: jumps the clock to just before the predicted break-up and plays at ×20.
- [ ] Live pieces (if R3/R2 ship `debris_piece`): animate rows as they arrive from the subscription.
- [ ] **Stretch, third-person satellite camera:** follow the selected satellite (offset behind and above, looking down and ahead) so the user sees the landing lines from the satellite's perspective; a button to switch back to the free camera.
- **Done when:** "Play re-entry" shows the object breaking up and pieces streaming to the ground on the timeline, smooth at ×20.

## G4: panels and UI around the globe (teammate 4)
- [ ] Port from the 2D prototype (`web/src/BigScreen.tsx`):
  - "Coming down next" list (click → select on the globe)
  - live feeds + space weather
  - compute panel (last run: objects, particles, particle-steps, device, tier)
  - **red degraded-mode banner**
- [ ] New **breakdown panel** for the selected object:
  - components table: name, material, count, survive %, mass left, impact energy, demise altitude
  - totals: chance anything survives, surviving mass, casualty area
  - "modeled estimate" label
- [ ] **Sources popover:** archetype name, match reason, catalog sources and confidence (`satellite_profile`, `archetype`).
- [ ] Layout: globe full-screen, panels as an overlay sidebar; works on a laptop screen and a projector; leave a slot for the assistant chat (R4).
- [ ] Later: Claude Design pass (visual style), then apply.
- **Done when:** every number shown comes from a table, nothing simulated or modeled is unlabeled, and the panels never cover the selected satellite.

---

## Shared rules
- One Cesium `Viewer` only. Add your layers through `useViewer()` and clean them up in your effect's cleanup.
- Performance: primitives/point collections for many objects; entities only for the selected object; no per-frame React state.
- Don't edit another task's files; if you need a shared helper, put it in `web/src/globe/util.ts` and say so in your PR.
- Test before PR: `npm run typecheck && npm run build`, then open the globe, select an object, play the clock.
