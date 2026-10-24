# Simulation spec (gx10-compute `/forecast` and `/update`)

> After the debris pivot this file covers the **orbit/re-entry forecast**, which feeds the debris model. Break-up and survival: `docs/DEBRIS_MODEL.md`. The sighting fusion (`/update`) is parked.

> **Implemented (Phase 2) in `services/gx10-compute/sim.py`.** What it does now, superseding sections 1 and 2 below:
> - Initial state from SGP4 on the latest GP elements; then RK4 (30 s step) with two-body + J2 + drag against a co-rotating atmosphere, float32, batched over all objects × particles on the GPU.
> - Density: NRLMSIS 2.1 (pymsis) at the current F10.7 / Ap, averaged over latitude and longitude.
> - Ballistic coefficient calibrated per object so the simulated mean-motion decay matches the observed `MEAN_MOTION_DOT`; BSTAR fallback marked "uncalibrated".
> - Particle parameters θ = (log drag factor, along-track, radial, cross-track offsets). Prior spreads widen with Kp and element age.
> - Re-entry = crossing 80 km; output = time quantiles, share re-entering inside the horizon, and 50/90% highest-density regions of the re-entry points (1° grid, smoothed).
> - Sightings: likelihood on re-entry time (σ 300 s) and distance to the observer (σ 400 km) with a trust-based outlier floor; when ESS < 10% the engine fits a Gaussian proposal in θ to the weighted particles (×1.5 widened), re-propagates, and re-weights with prior/proposal (adaptive importance sampling).
> - Defaults: GPU 20,000 particles per object, 10-day horizon; CPU (degraded) 300 particles, 3 days.
> - Measured on a laptop CPU: ~3.5M particle-steps/s. A full GPU run (70 objects × 20k × days of steps) is ~10¹⁰ particle-steps.

Goal: given an object's orbit elements, its predicted decay window and a set of sightings, return a corridor (probability bands over the ground) that tightens as consistent sightings arrive.

This is a simplified model on purpose. Public element accuracy is kilometre-scale, so we claim corridor narrowing, not a pinpoint.

## 1. Sampling (N variants, default 100,000)
For each variant draw:
- mean motion and eccentricity perturbations from the element uncertainty (assumed Gaussian; the scale is a config value, documented)
- a drag/ballistic-coefficient scale factor, with spread widened by a space-weather index (the request's `space_weather.kp` / `f107`, from the module's `space_weather` table)
- a decay time inside `[window_start, window_end]`
All on the GPU as tensors.

## 2. Propagation
For each variant compute the sub-satellite ground track over the decay window with a simplified analytic model: two-body motion + J2 precession + a decay term. Output tensor shape `[N, T, 2]` (lat, lon) for T time steps. Document the model as a limitation; do not call it SGP4.

## 3. Likelihood weighting
For each accepted or held sighting `s` (time `t_s`, position `p_s`, optional bearing `b_s`):
- `d_i` = distance from variant `i`'s track position at `t_s` to `p_s`
- position term: Gaussian in `d_i` with sigma = a report-error scale (config, default a few tens of km)
- bearing term (if given): Gaussian on the angle between `b_s` and variant `i`'s track direction at `t_s`
- outlier mixture: `L_i(s) = (1-eps_s) * gaussian_terms + eps_s * uniform`, with base eps about 0.25 so that bad reports do not collapse the distribution
- per-sighting eps from reporter trust (sent by the worker): `eps_s = clamp(eps_base * (1.5 - trust), 0.05, 0.6)`; held sightings may add more
- weight `w_i` multiplies over sightings; normalise
- per-sighting score: `p_inlier(s) = sum_i w_i * (1-eps_s) g_i(s) / L_i(s)`. Returned as `scores`; the module uses it to hold inconsistent reports and to update reporter trust

## 4. Degeneracy control
Effective sample size `ESS = 1 / sum(w^2)`. If ESS falls below half of N, resample with replacement and add small jitter (so the corridor does not collapse to a few points).

## 5. Corridor extraction
- Bin weighted track positions (over the decay window) onto a lat/lon grid
- Smooth lightly; extract the contours that enclose 50% and 90% of the weight
- Simplify polygons to a few hundred points each
- `area_km2_90` = area of the 90% region (use a spherical-area approximation)

## 6. Output
`{bands: [{level: 50, polygon}, {level: 90, polygon}], area_km2_90, n_samples, ess, ms, scores: [{id, p_inlier}]}`

## Synthetic scoring (tools/sighting-gen)
- Pick the true variant (the replay event's real path)
- Generate K sightings along it: position noise, time noise, optional bearing noise; mark about 20 to 30% as outliers (random location/time). Assign them to several simulated reporters (`sim-<n>`), some reliable, some mostly wrong
- Output a replay script JSON `[{t_offset_s, lat, lon, bearing_deg?, sim_reporter, is_outlier}]` for `load_replay_script`
- Run `/update` after each added sighting
- Record: `area_km2_90` vs K, and whether the true path lies inside the 90% band
- Repeat over many random seeds; report the shrink curve and the coverage rate
Acceptance for the demo: median shrink visible by 5 sightings, and coverage not far below 90% over repeated runs. If coverage is poor, widen sigma/eps; do not hide it.

## Config knobs (environment or file)
`SIM_N`, position sigma, bearing sigma, eps (outlier rate), element uncertainty scales, `USE_GPU`.

## Not claimed
Real-world accuracy, aerodynamic breakup modeling, or any use as an operational prediction.
