# Debris model spec (gx10-compute `/debris`)

Goal: for one object predicted to re-enter, estimate which pieces survive to the ground, how big they are, what they're made of, and where they land, with probabilities. It runs on the GX10. Everything below is a **simplified, documented model** (a lumped-mass "object-oriented" approach like NASA DAS / ESA DRAMA-SARA, much reduced). It is not an operator assessment. Constants marked **check** must be verified against the cited sources before the demo, and this file updated.

## Implementation status
`POST /debris` reuses the forecast engine's 80 km particle states, propagates each component with Torch RK4, drag and lumped heating, and returns component survival estimates, impact footprints and representative tracks. Spheres and cylinders use their own area; boxes and plates use the tumbling-average projected area (surface / 4) and the Cd in §4, so the archetypes in `data/archetypes/` can run. It uses CUDA when `USE_GPU=1` (the default) and returns HTTP 503 if CUDA is unavailable; `USE_GPU=0` is an explicit, labeled CPU-degraded mode limited to 100 particles and three components. This version does not implement breakup-altitude variation, parent/child shielding, or component-orientation dynamics. The response includes `breakup` and per-component `impact` (`lat` / `lon`) because `publish_debris` stores those and the globe draws lines from them. Inconel constants in code are labeled CHECK.

The numerical material, aerodynamic and heating constants below remain unverified assumptions. The current implementation applies 15% of the shape's surface area as effective heating area; this is a model knob, not a validated material or aerodynamic constant. Repeated components share the same sampled trajectory, and components are released together at 80 km. Outputs are **modeled estimates**, not operational predictions. A successful CPU unit test does not establish GPU or GX10 performance; the endpoint's reported `device`, `gpu_name` and `tier` must be checked on the actual GX10.

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
Batch: P particles (default 2,000 on GPU, 100 on CPU) × C components (10–60 including multiples) × at most 3,600 half-second steps per component in v0. The component flight and heating calculations run as GPU tensors in default mode; footprint contour extraction is CPU-side.

## 1. Inputs
- **Re-entry states:** the forecast keeps, per particle, the time of the 80 km crossing and its inertial position and velocity.
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
- Request body: `{object: {id, elements}, profile: {...}, archetype: {...}, space_weather?, n_particles?, seed?, as_of?}`. The object needs GP/OMM elements and forecast particles crossing 80 km. `n_particles` defaults to 2,000 on CUDA and 100 in explicit CPU-degraded mode.
- `device`, `tier`, `degraded`, and `particle_steps` report actual compute execution; do not infer GPU use from configuration alone.
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
- **Children of a box/bus:** parent structure first (shields its contents), then children are released at a parent-demise altitude or at h_b + U(0, 5) km (simple; check DAS "parent-child" logic).

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
  "sample_tracks": [{"component": "reaction wheel", "points": [[t_unix, lat, lon, alt_km], "..."]}]
}
```
- `sample_tracks`: one representative falling trajectory per component in v0, downsampled (≤ 60 points each), for the 3D animation. Times are Unix seconds; impacts beyond the 30-minute integration limit remain unresolved and are reported separately.
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
