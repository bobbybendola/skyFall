# Debris model spec (gx10-compute `/debris`)

Goal: for one object predicted to re-enter, estimate which pieces survive to the ground, how big they are, what they're made of, and where they land, with probabilities. It runs on the GX10. Everything below is a **simplified, documented model** (a lumped-mass "object-oriented" approach like NASA DAS / ESA DRAMA-SARA, much reduced). It is not an operator assessment. Constants marked **check** must be verified against the cited sources before the demo, and this file updated.

> **Implemented (debris-v1) in `services/gx10-compute/debris.py`, served at `POST /debris`.** Where it differs from or settles the text below:
> - **Start states:** the forecast now keeps each particle's inertial state at the 80 km crossing (Hermite interpolation inside the 30 s step; test: altitude within 0.5 km of 80). `/debris` resamples them from the cached forecast, or runs the forecast for that object if the cache is cold. Each state keeps its particle's drag factor for the intact-body phase. A natural decay enters at about −0.9° and 7.26 km/s relative to the air. A request may instead give a nominal `entry` state (tests, past cases); its defaults are those values.
> - **Batching:** one row per particle × component copy (`count` is expanded, each copy jittered), all on one device. Finished rows are compacted away.
> - **Integration:** second-order Strang split: half a drag step, velocity-Verlet gravity (two-body + J2), half a drag step. Drag decays the air-relative velocity exponentially with k frozen over the half step, so slow light pieces stay stable (k·dt ≫ 1 is fine). At dt 0.5 s the impact point is within 5 km of a 10× finer step (unit test). dt 0.5 s while anything is hypersonic (> 1 km/s), then 2 s. Degraded mode uses 1 s / 4 s. Flight is capped at 2 h of sim time; pieces still flying are reported in `n_unresolved`.
> - **Geometry:** mean tumbling cross-section A = S/4 (Cauchy's formula for convex bodies; exact for spheres). Nose radius: sphere d/2, cylinder D/2, box and plate √(A/π) (**check**). Radiating area = S. Dimensions shrink with (m/m₀)^⅓.
> - **Heating:** Q = q · A with q = min(Sutton–Graves, ½ρv³). The cap is the free-molecular limit, for the rarefied top of the flight. ±20% lognormal model-error jitter per row. Radiation εσ(T⁴ − 250⁴)·S.
> - **Who heats when:** top-level components are the outside of the intact body and heat from 80 km, flying on the intact-body drag until h_b. Components with a `parent` are shielded (no heating, the parent's drag) until the parent demises or h_b − U(0, 5) km. (The spec text in §4 said "h_b + U(0, 5)", read as a typo.) One level of nesting only.
> - **Archetype field `parent` (optional):** the name of another component that contains this one. A missing, self or nested parent is dropped with a warning.
> - **Jitter (1σ lognormal, per row):** mass 10%, dims 5%, Cd 10%, heating 20%. h_b ~ U(72, 84) km per particle.
> - **Casualty area:** only pieces with impact energy ≥ 15 J count (NASA-STD-8719.14 threshold; confirmed in secondary sources, see below).
> - **Degraded (CPU default):** 100 particles, the main structure (name contains "structure"/"bus", else the heaviest) + the two heaviest other components, coarse steps.
> - **Materials:** request `materials` > `data/materials.json` (R3) > the built-in copy of the §3 table. Keys `density, melt_k, cp, h_fusion, emissivity` (common spellings accepted), as `{name: {...}}` or `[{id, ...}]`.
> - **GPU guard:** with `USE_GPU=1` and no CUDA, `/debris` returns 503 instead of running on CPU, so a GPU-tier worker never publishes CPU results. `USE_GPU=0` is the explicit, labeled degraded mode. `/health` reports `debris_mode` (`gpu`, `cpu_degraded`, `unavailable`) and `debris_available`.
> - **Fields the reducer and globe read:** `breakup {t_unix_s, lat, lon, alt_km}` (median top-level release point), `note`, per component `mass_kg.start` and `impact {lat, lon}` (median impact). Diagnostics: per component `p_unresolved`, `impact_time` quantiles, `max_temperature_k`, `max_heat_flux_w_m2`; top level `archetype_name`, `archetype_sources`, `gpu_name`, `tier`.
> - **Example response** (test fixture, for building the globe): `services/gx10-compute/examples/debris-example.json`. Tests: `cd services/gx10-compute && python -m pytest -q tests` (needs `pytest httpx`).
>
> **Notes for archetype authors (R3), from the unit runs:**
> - Cylinder `dims_m` is **[length, diameter]**. A reaction wheel is a disc, e.g. `[0.10, 0.25]`, not a rod `[0.25, 0.10]`. The rod heats far faster: 5% survival vs 75%.
> - A whole bus as one solid box survives almost always (lumped mass: all of it must melt). Model the structure as several panels (`plate`, realistic thickness and mass), the way DAS/ORSAT break structures up, or the debris totals will be dominated by an unrealistic surviving bus.
> - Results are sensitive to emissivity: stainless at 0.35 vs 0.8 (oxidised) moves a steel part from 5% to 65% survival. Pick and source it deliberately.
>
> **Check status (Oct 24):** Sutton–Graves k: secondary sources quote 1.74e-4 to 1.75e-4 SI for Earth (we use 1.7415e-4); the original NASA TR R-376 was not retrieved, so this is still **check**. 15 J casualty threshold: confirmed. Casualty area (0.6 + √A)²: not yet confirmed against the standard's text, still **check**. Cd by shape and the box/plate nose radius: still **check**.

## Pipeline
```
forecast particles (sim.py) ──► state at 80 km for each particle (r, v, t)
        │
        ├─ break-up altitude h_b ~ U(72, 84) km per particle (check: 78 km is the usual nominal)
        │     propagate the intact body from 80 km to h_b (same RK4, smaller step)
        │
        ├─ split into components from the object's archetype (+ jitter on mass/size)
        │
        └─ for every (particle × component): 3-DOF flight to the ground with heating
              → demised (altitude where it burned up) or survived (impact lat/lon/time, mass, speed, energy)
```
Batch: P particles (default 2,000 on GPU, 100 on CPU) × C components (10–60 including multiples) × steps (0.5 s steps over ~5–10 min of flight ≈ 600–1,200) ≈ 10⁸ component-steps per object. GPU tensors throughout.

## 1. Inputs
- **Re-entry states:** the forecast keeps, per particle, the time of the 80 km crossing and its inertial position and velocity. (Change needed in `sim.py`: today it stores only time and lat/lon.)
- **Profile:** mass, dimensions, shape and object type from `satellite_profile` (GCAT / SATCAT / DISCOSweb), mapped to an archetype.
- **Space weather:** atmospheric density from NRLMSIS, as in the forecast.

## 2. Archetype file (`data/archetypes/<id>.json`)
```json
{
  "id": "starlink-v1",
  "name": "Starlink-class flat-panel LEO satellite",
  "applies_to": {"object_type": "PAY", "name_regex": "^STARLINK", "mass_kg": [200, 350]},
  "sources": ["<public URL or paper for each number>"],
  "confidence": "low|medium|high",
  "components": [
    {"name": "bus structure",   "material": "Al6061",  "shape": "box",      "mass_kg": 120, "dims_m": [2.8, 1.4, 0.2], "count": 1},
    {"name": "solar array",     "material": "CFRP",    "shape": "plate",    "mass_kg": 40,  "dims_m": [8.0, 2.8, 0.03], "count": 1},
    {"name": "reaction wheel",  "material": "SS304",   "shape": "cylinder", "mass_kg": 3.0, "dims_m": [0.25, 0.10], "count": 4},
    {"name": "propellant tank", "material": "Ti6Al4V", "shape": "sphere",   "mass_kg": 4.0, "dims_m": [0.30], "count": 1}
  ]
}
```
- `dims_m`: box [l, w, h], plate [l, w, t], cylinder [length, diameter], sphere [diameter].
- Masses scale to the profile's mass when it is known (the structure absorbs the difference); otherwise use the archetype's values.
- Every number has a source or an "assumed" note. **The archetype is part of what we show judges.**

## 3. Materials (`data/materials.json`)
| Material | density kg/m³ | melt K | specific heat J/kg·K | heat of fusion J/kg | emissivity |
|---|---|---|---|---|---|
| Al6061 | 2700 | 867 | 896 | 3.9e5 | 0.3 |
| Ti6Al4V | 4430 | 1943 | 560 | 3.6e5 | 0.3 |
| SS304 (stainless) | 8000 | 1700 | 500 | 2.7e5 | 0.35 |
| CFRP | 1600 | 600 (pyrolysis; check) | 1100 | 2.0e5 (effective; check) | 0.85 |
| Glass / silicon (cells) | 2500 | 1400 | 800 | 1.4e5 | 0.8 |
| Copper | 8960 | 1356 | 385 | 2.05e5 | 0.3 |
All values are **check** against ESA DRAMA/SESAM or ORSAT material tables.

## 4. Flight + heating per component (3-DOF, tumbling, lumped mass)
- **State:** position, velocity (inertial), mass m, temperature T.
- **Forces:** gravity (two-body + J2) and drag `a = -½ ρ v_rel² · Cd A / m`.
  - Cd by shape, tumbling-averaged: sphere 0.92, cylinder ~1.0, box ~1.1, plate ~1.2 (check).
  - A = average tumbling cross-section of the shape.
  - ρ from NRLMSIS, extended down to 0 km (sim.py's table starts at 60 km; extend it).
- **Heating:** Sutton–Graves stagnation heat flux `q = k · sqrt(ρ / r_n) · v³`, with k ≈ 1.74e-4 (SI, Earth air; check) and r_n the effective nose radius of the shape. Shape factors reduce the average over the surface (check, DRAMA/ORSAT).
- **Energy:** `m c dT/dt = q·A_h − ε σ T⁴ A_s`. At T = T_melt the net heat goes into melting: `dm/dt = −(q·A_h − ε σ T⁴ A_s) / h_f`. Dimensions shrink with mass (keep the same shape).
- **Demise:** m < 1% of the start mass, or below 0.01 kg. Record the demise altitude.
- **Survive:** reaches the ground with mass > 0. Record time, lat/lon, mass, speed and impact energy ½mv².
- **Children of a box/bus:** parent structure first (shields its contents), then children are released at a parent-demise altitude or at h_b − U(0, 5) km, whichever comes first (simple; check DAS "parent-child" logic). Mark a child with `"parent": "<component name>"` in the archetype.

## 5. Outputs per object (`/debris` response)
```json
{
  "id": "CT-47625", "archetype": "starlink-v1", "n_particles": 2000, "ms": 4210, "device": "cuda:0",
  "p_any_survives": 0.18,
  "surviving_mass_kg": {"mean": 3.1, "p95": 9.4},
  "casualty_area_m2": {"mean": 0.9},
  "components": [
    {"name": "reaction wheel", "material": "SS304", "count": 4, "p_survive": 0.71,
     "mass_kg": {"mean": 1.9}, "impact_speed_ms": {"mean": 85}, "impact_energy_j": {"mean": 6900},
     "demise_alt_km": {"mean": null}, "footprint": {"bands": [{"level": 50, "polygon": [[lon, lat], "..."]}, {"level": 90, "polygon": "..."}]}}
  ],
  "footprint": {"bands": ["...all survivors combined..."], "area_km2_90": 41000},
  "sample_tracks": [{"component": "reaction wheel", "points": [[t_s, lat, lon, alt_km], "..."]}]
}
```
- `sample_tracks`: a few representative falling trajectories per component, downsampled (≤ 60 points each), for the 3D animation.
  - Each is `{component, survived, points}`, with points `[t_unix, lat, lon, alt_km]` from 80 km to the ground (`survived: true`) or to the demise altitude.
  - Up to two surviving and one demised track per component.
- Implemented extras (debris-v1):
  - **Top level:**
    - `label: "modeled estimate"`, `model`, `archetype_confidence`, `degraded`, `n_pieces_per_particle`
    - `impact_time` / `entry_time` (`q05`, `q50`, `q95` ISO)
    - `n_unresolved`, `warnings` (e.g. mass scaling, degraded cuts), `particle_steps` (row-steps, for `compute_run`), `steps`
    - `entry` (`source: forecast|entry`, cache reuse, `decayed_frac`, `bc_m2_kg`, `calibrated`)
  - **Per component:** `shape`, `parent`, `mass_kg_start`, `flight_s` (80 km → impact). Stats are `{mean, p05, p95}`, or `{mean: null}` when nothing survived or demised.
  - **Every `footprint`:** also `center: [lon, lat]`, the median impact point, for the globe's satellite→landing line. Per component it also has `samples: [[lon, lat], …]`, up to 40 sampled impacts, for one line per sampled impact when the footprint is wide.
  - Footprint rings use a local grid whose cell adapts to the spread. Longitudes stay continuous across ±180°, so they may exceed 180.
  - A bad archetype or missing input returns HTTP 422 with the reason, for `fail_job`.
- Casualty area per surviving piece: `A_c = (0.6 + sqrt(A_i))²` m² (NASA DAS form, 0.36 m² person; check NASA-STD-8719.14).

## 6. In-orbit breakup (stretch: `/fragment`)
NASA Standard Breakup Model (check the equations against the NASA SBM 2000 revision and arXiv:2111.12196):
- Number of fragments larger than a characteristic length Lc:
  - explosion `N(>Lc) = 6 S Lc^-1.6`
  - collision `N(>Lc) = 0.1 M^0.75 Lc^-1.71`
- Area-to-mass ratio: (bi)normal distributions in log10(A/m) as a function of Lc.
- Δv: normal in log10(Δv) as a function of A/m.

Then the fragment cloud (10⁴–10⁵ pieces) is propagated with the forecast engine. Outputs: cloud snapshots for the globe, plus each fragment's decay date (which pieces come down, and when).

## 7. Degraded mode
The CPU tier runs 100 particles, only the main structure and the two most massive components, with coarse steps. The UI shows it as degraded with wide zones.

## 8. Validation
- **Unit checks:**
  - an aluminium sphere of 1 kg from 80 km should demise
  - a steel or titanium tank should survive
  - impact speeds should be terminal-velocity scale (tens of m/s for dense small parts)
  - compare with published DAS/DRAMA examples (check)
- **Real cases:** a re-entry from this weekend (archived), and a past re-entry with recovered debris (check: 2024 Dragon trunk debris; Aerospace Corp re-entry records).

## Not claimed
Exact break-up sequence, fragment shapes after break-up, winds, operator-specific designs, legal risk numbers.
