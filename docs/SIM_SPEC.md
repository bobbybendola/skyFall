# Simulation spec (gx10-compute `/update`)

Goal: given an object's orbit elements, its predicted decay window and a set of sightings, return a corridor (probability bands over the ground) that tightens as consistent sightings arrive.

This is a simplified model on purpose. Public element accuracy is kilometre-scale, so we claim corridor narrowing, not a pinpoint.

## 1. Sampling (N variants, default 100,000)
For each variant draw:
- mean motion and eccentricity perturbations from the element uncertainty (assumed Gaussian; the scale is a config value, documented)
- a drag/ballistic-coefficient scale factor, with spread widened by a space-weather index from NOAA
- a decay time inside `[window_start, window_end]`
All on the GPU as tensors.

## 2. Propagation
For each variant compute the sub-satellite ground track over the decay window with a simplified analytic model: two-body motion + J2 precession + a decay term. Output tensor shape `[N, T, 2]` (lat, lon) for T time steps. Document the model as a limitation; do not call it SGP4.

## 3. Likelihood weighting
For each accepted or held sighting `s` (time `t_s`, position `p_s`, optional bearing `b_s`):
- `d_i` = distance from variant `i`'s track position at `t_s` to `p_s`
- position term: Gaussian in `d_i` with sigma = a report-error scale (config, default a few tens of km)
- bearing term (if given): Gaussian on the angle between `b_s` and variant `i`'s track direction at `t_s`
- outlier mixture: `L_i(s) = (1-eps) * gaussian_terms + eps * uniform`, with eps about 0.25 so that bad reports do not collapse the distribution
- weight `w_i` multiplies over sightings; normalise
Held sightings may use a larger eps than accepted ones.

## 4. Degeneracy control
Effective sample size `ESS = 1 / sum(w^2)`. If ESS falls below half of N, resample with replacement and add small jitter (so the corridor does not collapse to a few points).

## 5. Corridor extraction
- Bin weighted track positions (over the decay window) onto a lat/lon grid
- Smooth lightly; extract the contours that enclose 50% and 90% of the weight
- Simplify polygons to a few hundred points each
- `area_km2_90` = area of the 90% region (use a spherical-area approximation)

## 6. Output
`{bands: [{level: 50, polygon}, {level: 90, polygon}], area_km2_90, n_samples, ess, ms}`

## Synthetic scoring (tools/sighting-gen)
- Pick the true variant (the replay event's real path)
- Generate K sightings along it: position noise, time noise, optional bearing noise; mark about 20 to 30% as outliers (random location/time)
- Run `/update` after each added sighting
- Record: `area_km2_90` vs K, and whether the true path lies inside the 90% band
- Repeat over many random seeds; report the shrink curve and the coverage rate
Acceptance for the demo: median shrink visible by 5 sightings, and coverage not far below 90% over repeated runs. If coverage is poor, widen sigma/eps; do not hide it.

## Config knobs (environment or file)
`SIM_N`, position sigma, bearing sigma, eps (outlier rate), element uncertainty scales, `USE_GPU`.

## Not claimed
Real-world accuracy, aerodynamic breakup modeling, or any use as an operational prediction.
