"""SKYFALL re-entry engine (Phase 2).

Monte Carlo decay forecast + sighting fusion, batched over many objects on the GPU.

Model (documented limitations, not an operational tool):
- Initial state: SGP4 from the object's latest GP elements (CelesTrak / Space-Track),
  propagated to `as_of`. Frame TEME, treated as inertial.
- Dynamics: two-body + J2 + atmospheric drag against an atmosphere co-rotating
  with the Earth. RK4, fixed step (default 30 s), float32.
- Atmosphere: NRLMSIS 2.1 (pymsis) density vs altitude for the current F10.7 and
  Ap, averaged over longitude and latitude (no day/night bulge). Day/night and
  model error are absorbed by a per-particle drag factor.
- Ballistic coefficient: calibrated per object so the simulated decay rate of the
  mean motion matches the observed rate in the elements (MEAN_MOTION_DOT). Falls
  back to BSTAR when the rate is not usable.
- Uncertainty (per particle): log drag factor (calibration + density error,
  widened with Kp), along-track / radial / cross-track position error growing
  with element age.
- Re-entry = altitude crossing 80 km (start of breakup). Impact point = sub-point
  at that crossing. Debris footprint downrange is not modelled.

Sighting fusion: each sighting (time, ground position) is evidence about the
re-entry time and place. Particles are weighted with a robust likelihood
(Gaussian in time and distance + outlier floor set by reporter trust).
When the weights collapse (low ESS) the engine refits a proposal in parameter
space from the weighted particles, draws fresh particles and re-propagates them
(adaptive importance sampling; weights = prior/proposal x likelihood), so
corridors narrow from evidence, not from a rule.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np
import torch

MU = 398600.4418  # km^3 / s^2
RE = 6378.137  # km
J2 = 1.08262668e-3
FLAT = 1 / 298.257223563
E2 = FLAT * (2 - FLAT)
OMEGA_E = 7.292115e-5  # rad / s
H_REENTRY = 80.0  # km
ALT_GRID = (60.0, 1200.0)  # km, 1 km spacing for the density table

# Prior spreads (1 sigma). Documented knobs.
SIG_LOG_DRAG = 0.25  # calibration + density model error, before Kp widening
SIG_ALONG_KM = 1.0  # plus SIG_ALONG_PER_DAY * element age
SIG_ALONG_PER_DAY = 2.0
SIG_RADIAL_KM = 0.3
SIG_CROSS_KM = 0.3

# Sighting likelihood
SIG_T_S = 300.0  # observer time error + fireball duration
SIG_D_KM = 400.0  # observer sees the fireball within a few hundred km
EPS_BASE = 0.25


def kp_to_ap(kp: float) -> float:
    table = [(0, 0), (1, 4), (2, 7), (3, 15), (4, 27), (5, 48), (6, 80), (7, 140), (8, 240), (9, 400)]
    lo = int(max(0, min(8, math.floor(kp))))
    f = kp - lo
    return table[lo][1] * (1 - f) + table[lo + 1][1] * f


# ------------------------------------------------------------------ atmosphere

_density_cache: dict[tuple, np.ndarray] = {}


def density_table(f107: float, kp: float, when: datetime, alt_grid: tuple[float, float] = ALT_GRID) -> np.ndarray:
    """log(rho [kg/m^3]) on a 1 km grid from alt_grid[0], NRLMSIS 2.1 averaged over lon/lat."""
    key = (round(f107), round(kp, 1), when.strftime('%Y-%m-%dT%H'), alt_grid)
    if key in _density_cache:
        return _density_cache[key]
    alts = np.arange(alt_grid[0], alt_grid[1] + 1.0, 1.0)
    try:
        from pymsis import msis

        ap = kp_to_ap(kp)
        lons = np.arange(-180.0, 180.0, 30.0)
        lats = np.arange(-75.0, 76.0, 25.0)
        out = msis.calculate(
            np.array([np.datetime64(when.replace(tzinfo=None))]),
            lons,
            lats,
            alts,
            f107s=[f107],
            f107as=[f107],
            aps=[[ap] * 7],
        )
        rho = out[0, :, :, :, 0]  # (lon, lat, alt) total mass density
        w = np.cos(np.radians(lats))[None, :, None]
        mean = (rho * w).sum(axis=(0, 1)) / (w.sum() * rho.shape[0])
        table = np.log(np.maximum(mean, 1e-20))
    except Exception:  # pymsis missing: static exponential model, much rougher
        table = _exponential_fallback(alts)
    _density_cache[key] = table
    return table


def _exponential_fallback(alts: np.ndarray) -> np.ndarray:
    # Vallado exponential atmosphere (base alt km, rho kg/m^3, scale height km). Check values.
    base = [
        (0, 1.225, 7.249), (25, 3.899e-2, 6.349), (30, 1.774e-2, 6.682), (40, 3.972e-3, 7.554),
        (50, 1.057e-3, 8.382), (60, 3.206e-4, 7.714), (70, 8.770e-5, 6.549), (80, 1.905e-5, 5.799),
        (90, 3.396e-6, 5.382), (100, 5.297e-7, 5.877), (110, 9.661e-8, 7.263), (120, 2.438e-8, 9.473),
        (130, 8.484e-9, 12.636), (140, 3.845e-9, 16.149), (150, 2.070e-9, 22.523), (180, 5.464e-10, 29.740),
        (200, 2.789e-10, 37.105), (250, 7.248e-11, 45.546), (300, 2.418e-11, 53.628), (350, 9.518e-12, 53.298),
        (400, 3.725e-12, 58.515), (450, 1.585e-12, 60.828), (500, 6.967e-13, 63.822), (600, 1.454e-13, 71.835),
        (700, 3.614e-14, 88.667), (800, 1.170e-14, 124.64), (900, 5.245e-15, 181.05), (1000, 3.019e-15, 268.0),
    ]
    out = np.empty_like(alts)
    for i, h in enumerate(alts):
        b = max(x for x in base if x[0] <= h)
        out[i] = math.log(b[1]) - (h - b[0]) / b[2]
    return out


# ------------------------------------------------------------------ time / frames


def parse_time(s: str) -> datetime:
    s = s.replace('Z', '+00:00')
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def jd_of(d: datetime) -> float:
    return d.timestamp() / 86400.0 + 2440587.5


def gmst_rad(unix_s: torch.Tensor | float) -> torch.Tensor | float:
    jd = unix_s / 86400.0 + 2440587.5
    deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    if isinstance(deg, torch.Tensor):
        return torch.deg2rad(torch.remainder(deg, 360.0))
    return math.radians(deg % 360.0)


def eci_to_latlon(r: torch.Tensor, unix_s: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    p = torch.sqrt(x * x + y * y)
    lat = torch.atan2(z, p * (1 - E2))
    lon = torch.atan2(y, x) - gmst_rad(unix_s.to(torch.float64)).to(r.dtype)
    lon = torch.remainder(lon + math.pi, 2 * math.pi) - math.pi
    return torch.rad2deg(lat), torch.rad2deg(lon)


# ------------------------------------------------------------------ initial states


def sgp4_state(gp: dict, when: datetime) -> tuple[np.ndarray, np.ndarray]:
    from sgp4.api import Satrec
    from sgp4 import omm

    fields = {k: str(v) for k, v in gp.items()}
    fields.setdefault('CLASSIFICATION_TYPE', 'U')
    fields.setdefault('EPHEMERIS_TYPE', '0')
    fields.setdefault('ELEMENT_SET_NO', '999')
    fields.setdefault('REV_AT_EPOCH', '0')
    fields.setdefault('MEAN_MOTION_DDOT', '0')
    fields.setdefault('OBJECT_ID', '0000-000A')
    ep = fields['EPOCH']
    if '.' not in ep:
        fields['EPOCH'] = ep + '.000000'
    sat = Satrec()
    omm.initialize(sat, fields)
    jd = jd_of(when)
    e, r, v = sat.sgp4(math.floor(jd - 0.5) + 0.5, jd - (math.floor(jd - 0.5) + 0.5))
    if e != 0:
        raise ValueError(f'sgp4 error {e}')
    return np.array(r), np.array(v)


def bstar_to_b(bstar: float) -> float:
    """Rough Cd*A/m (m^2/kg) from BSTAR (1/earth radii); only a starting point."""
    return max(1e-3, min(0.2, 2.0 * abs(bstar) / 0.15696615 if bstar else 0.01))


# ------------------------------------------------------------------ dynamics


class Atmosphere:
    def __init__(self, log_rho: np.ndarray, device: torch.device, dtype: torch.dtype, h0: float = ALT_GRID[0]):
        self.t = torch.tensor(log_rho, device=device, dtype=dtype)
        self.h0 = h0
        self.n = len(log_rho)

    def rho(self, h: torch.Tensor) -> torch.Tensor:
        x = torch.clamp(h - self.h0, 0, self.n - 1.001)
        i = x.floor().long()
        f = x - i
        lr = self.t[i] * (1 - f) + self.t[i + 1] * f
        return torch.exp(lr)


def altitude(r: torch.Tensor) -> torch.Tensor:
    rn = torch.linalg.vector_norm(r, dim=1)
    s2 = (r[:, 2] / rn) ** 2
    return rn - RE * (1 - FLAT * s2)  # altitude over the ellipsoid, small-flattening approx


def accel(r: torch.Tensor, v: torch.Tensor, bc: torch.Tensor, atm: Atmosphere) -> torch.Tensor:
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    r2 = x * x + y * y + z * z
    rn = torch.sqrt(r2)
    r3 = r2 * rn
    zr2 = z * z / r2
    k = 1.5 * J2 * MU * RE * RE / (r2 * r2 * rn)
    ax = -MU * x / r3 + k * x * (5 * zr2 - 1)
    ay = -MU * y / r3 + k * y * (5 * zr2 - 1)
    az = -MU * z / r3 + k * z * (5 * zr2 - 3)
    # drag, relative to the co-rotating atmosphere
    vrx = v[:, 0] + OMEGA_E * y
    vry = v[:, 1] - OMEGA_E * x
    vrz = v[:, 2]
    vr = torch.sqrt(vrx * vrx + vry * vry + vrz * vrz)
    h = rn - RE * (1 - FLAT * zr2)
    d = -0.5e3 * bc * atm.rho(h) * vr  # km/s^2 per (km/s) of v_rel
    return torch.stack((ax + d * vrx, ay + d * vry, az + d * vrz), dim=1)


@dataclass
class PropResult:
    t_reentry: torch.Tensor  # unix seconds, NaN if survived the horizon
    lat: torch.Tensor
    lon: torch.Tensor
    steps: int
    particle_steps: int
    r_reentry: torch.Tensor | None = None  # (P, 3) km, inertial, at the 80 km crossing (NaN if none)
    v_reentry: torch.Tensor | None = None  # (P, 3) km/s


def _hermite(r0, v0, r1, v1, f, dt):
    """Cubic Hermite state inside one step; f in [0, 1] per row (shape (n, 1))."""
    f2, f3 = f * f, f * f * f
    r = (2 * f3 - 3 * f2 + 1) * r0 + (f3 - 2 * f2 + f) * dt * v0 + (-2 * f3 + 3 * f2) * r1 + (f3 - f2) * dt * v1
    dr = ((6 * f2 - 6 * f) * r0 + (3 * f2 - 4 * f + 1) * dt * v0 + (-6 * f2 + 6 * f) * r1 + (3 * f2 - 2 * f) * dt * v1) / dt
    return r, dr


def propagate(
    r0: torch.Tensor,
    v0: torch.Tensor,
    bc: torch.Tensor,
    t0_unix: float,
    atm: Atmosphere,
    horizon_s: float,
    dt: float = 30.0,
    compact_every: int = 200,
) -> PropResult:
    """RK4 until each particle crosses H_REENTRY or the horizon ends.

    Keeps each particle's inertial state at the crossing (Hermite interpolation
    inside the step): the start of the debris model."""
    dev, dt_ = r0.device, r0.dtype
    P = r0.shape[0]
    t_re = torch.full((P,), float('nan'), device=dev, dtype=torch.float64)
    lat_re = torch.full((P,), float('nan'), device=dev, dtype=dt_)
    lon_re = torch.full((P,), float('nan'), device=dev, dtype=dt_)
    r_re = torch.full((P, 3), float('nan'), device=dev, dtype=dt_)
    v_re = torch.full((P, 3), float('nan'), device=dev, dtype=dt_)
    idx = torch.arange(P, device=dev)
    r, v, b = r0.clone(), v0.clone(), bc.clone()
    h_prev = altitude(r)
    n_steps = int(math.ceil(horizon_s / dt))
    psteps = 0
    for s in range(n_steps):
        r_prev, v_prev = r, v
        k1v = accel(r, v, b, atm)
        k1r = v
        k2v = accel(r + 0.5 * dt * k1r, v + 0.5 * dt * k1v, b, atm)
        k2r = v + 0.5 * dt * k1v
        k3v = accel(r + 0.5 * dt * k2r, v + 0.5 * dt * k2v, b, atm)
        k3r = v + 0.5 * dt * k2v
        k4v = accel(r + dt * k3r, v + dt * k3v, b, atm)
        k4r = v + dt * k3v
        r = r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r)
        v = v + (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
        psteps += r.shape[0]
        h = altitude(r)
        down = h <= H_REENTRY
        if bool(down.any()):
            # linear interpolation of the crossing inside the step
            f = ((h_prev[down] - H_REENTRY) / (h_prev[down] - h[down]).clamp_min(1e-6)).clamp(0, 1)
            tc = t0_unix + (s + f.double()) * dt
            rc, vc = _hermite(r_prev[down], v_prev[down], r[down], v[down], f[:, None], dt)
            la, lo = eci_to_latlon(rc, tc)
            gi = idx[down]
            t_re[gi] = tc
            lat_re[gi] = la
            lon_re[gi] = lo
            r_re[gi] = rc
            v_re[gi] = vc
            keep = ~down
            r, v, b, h, idx = r[keep], v[keep], b[keep], h[keep], idx[keep]
            if r.shape[0] == 0:
                return PropResult(t_re, lat_re, lon_re, s + 1, psteps, r_re, v_re)
        h_prev = h
    return PropResult(t_re, lat_re, lon_re, n_steps, psteps, r_re, v_re)


# ------------------------------------------------------------------ calibration


def osc_sma(r: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    rn = torch.linalg.vector_norm(r, dim=1)
    v2 = (v * v).sum(dim=1)
    return 1.0 / (2.0 / rn - v2 / MU)


def calibrate_bc(
    r0: torch.Tensor, v0: torch.Tensor, b0: torch.Tensor, ndot_obs: torch.Tensor, atm: Atmosphere, dt: float = 30.0
) -> tuple[torch.Tensor, torch.Tensor]:
    """Per object: scale Cd*A/m so the simulated dn/dt matches the observed one.

    Simulates each object for one day at three trial drag levels, measures the
    mean-motion drift (orbit-averaged), and fits log(rate) vs log(B).
    Returns (bc, ok_mask).
    """
    O = r0.shape[0]
    mults = torch.tensor([0.3, 1.0, 3.0], device=r0.device, dtype=r0.dtype)
    R = r0.repeat_interleave(3, 0)
    V = v0.repeat_interleave(3, 0)
    B = (b0[:, None] * mults[None, :]).reshape(-1)
    period = 2 * math.pi * math.sqrt(RE + 220.0) ** 3 / math.sqrt(MU)
    n_orbit = int(period / dt)
    # Fast decayers would come down inside a day: measure them over 3 orbits.
    fast = bool((ndot_obs > 0.02).any())
    n_total = 3 * n_orbit + 1 if fast else int(86400 / dt)
    a_first, a_last = torch.zeros_like(B), torch.zeros_like(B)
    alive = torch.ones_like(B, dtype=torch.bool)
    r, v = R.clone(), V.clone()
    for s in range(n_total):
        k1v = accel(r, v, B, atm); k1r = v
        k2v = accel(r + 0.5 * dt * k1r, v + 0.5 * dt * k1v, B, atm); k2r = v + 0.5 * dt * k1v
        k3v = accel(r + 0.5 * dt * k2r, v + 0.5 * dt * k2v, B, atm); k3r = v + 0.5 * dt * k2v
        k4v = accel(r + dt * k3r, v + dt * k3v, B, atm); k4r = v + dt * k3v
        r = r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r)
        v = v + (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
        alive &= altitude(r) > 100.0
        a = osc_sma(r, v)
        if s < n_orbit:
            a_first += a / n_orbit
        if s >= n_total - n_orbit:
            a_last += a / n_orbit
    span_days = (n_total - n_orbit) * dt / 86400.0
    n_first = torch.sqrt(MU / a_first**3) * 86400 / (2 * math.pi)  # rev/day
    n_last = torch.sqrt(MU / a_last**3) * 86400 / (2 * math.pi)
    rate = ((n_last - n_first) / span_days).reshape(O, 3)  # rev/day^2
    ok_rows = alive.reshape(O, 3).all(dim=1) & (rate > 0).all(dim=1) & (ndot_obs > 0)
    # rate ~ c * B^p ; fit in log space, solve for target
    lb = torch.log(B.reshape(O, 3))
    lr = torch.log(rate.clamp_min(1e-12))
    p = (lr[:, 2] - lr[:, 0]) / (lb[:, 2] - lb[:, 0])
    lb_target = lb[:, 1] + (torch.log(ndot_obs.clamp_min(1e-12)) - lr[:, 1]) / p.clamp_min(0.2)
    bc = torch.exp(lb_target).clamp(1e-3, 0.5)
    return torch.where(ok_rows, bc, b0), ok_rows


# ------------------------------------------------------------------ corridor extraction


def corridor_bands(lat: np.ndarray, lon: np.ndarray, w: np.ndarray, cell: float = 1.0, max_polys: int = 15):
    """Highest-density regions holding 50% and 90% of the weight, as polygons."""
    from scipy.ndimage import gaussian_filter
    from skimage.measure import approximate_polygon, find_contours

    ny, nx = int(180 / cell), int(360 / cell)
    iy = np.clip(((lat + 90) / cell).astype(int), 0, ny - 1)
    ix = np.clip(((lon + 180) / cell).astype(int), 0, nx - 1)
    grid = np.zeros((ny, nx))
    np.add.at(grid, (iy, ix), w)
    grid = gaussian_filter(grid, sigma=1.2, mode=('nearest', 'wrap'))
    total = grid.sum()
    if total <= 0:
        return [], 0.0
    grid /= total
    flat = np.sort(grid.ravel())[::-1]
    cum = np.cumsum(flat)
    lat_c = -90 + (np.arange(ny) + 0.5) * cell
    cell_area = (math.radians(cell) * RE) ** 2 * np.cos(np.radians(lat_c))[:, None] * np.ones((1, nx))
    bands, area90 = [], 0.0
    for level in (90, 50):
        k = int(np.searchsorted(cum, level / 100.0))
        thr = flat[min(k, len(flat) - 1)]
        mask = grid >= thr
        if level == 90:
            area90 = float(cell_area[mask].sum())
        padded = np.pad(mask.astype(float), 1)
        polys = []
        for c in find_contours(padded, 0.5):
            c = approximate_polygon(c, tolerance=0.6)
            if len(c) < 4:
                continue
            ring = [[round(-180 + (x - 1 + 0.5) * cell, 3), round(-90 + (y - 1 + 0.5) * cell, 3)] for y, x in c]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            polys.append(ring)
        polys.sort(key=len, reverse=True)
        for ring in polys[:max_polys]:
            bands.append({'level': level, 'polygon': ring})
    return bands, area90


# ------------------------------------------------------------------ forecast + fusion


@dataclass
class ObjectState:
    """Particles for one object. Cached between sighting updates (an
    optimisation only: losing it means recomputing, not losing data)."""

    key: str
    t0: float
    prior_mu: np.ndarray  # theta prior mean (4,)
    prior_sd: np.ndarray  # theta prior sd (4,)
    theta: np.ndarray  # (N, 4): log drag, along km, radial km, cross km
    log_q: np.ndarray  # log proposal density of each particle
    t_re: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    bc: float
    calibrated: bool
    rv: tuple[np.ndarray, np.ndarray]
    meta: dict = field(default_factory=dict)
    r_re: np.ndarray | None = None  # (N, 3) km inertial at the 80 km crossing (debris start)
    v_re: np.ndarray | None = None  # (N, 3) km/s


def _gauss_logpdf(x: np.ndarray, mu: np.ndarray, sd: np.ndarray) -> np.ndarray:
    z = (x - mu) / sd
    return (-0.5 * z * z - np.log(sd) - 0.5 * math.log(2 * math.pi)).sum(axis=-1)


def _perturbed_states(r: np.ndarray, v: np.ndarray, theta: np.ndarray, dev, dtype):
    rt = torch.tensor(r, device=dev, dtype=torch.float64)
    vt = torch.tensor(v, device=dev, dtype=torch.float64)
    u_r = rt / rt.norm()
    u_c = torch.linalg.cross(rt, vt)
    u_c = u_c / u_c.norm()
    u_a = torch.linalg.cross(u_c, u_r)
    th = torch.tensor(theta, device=dev, dtype=torch.float64)
    dr = th[:, 1:2] * u_a + th[:, 2:3] * u_r + th[:, 3:4] * u_c
    # along-track offset: move along the orbit (keep speed direction consistent)
    r_p = rt[None, :] + dr
    v_p = vt[None, :].expand_as(r_p)
    return r_p.to(dtype), v_p.contiguous().to(dtype)


class Engine:
    def __init__(self, device: torch.device, n_per_object: int, horizon_days: float, dt: float = 30.0):
        self.device = device
        self.dtype = torch.float32
        self.n = n_per_object
        self.horizon_s = horizon_days * 86400.0
        self.dt = dt
        self.cache: dict[str, ObjectState] = {}
        self.particle_steps_total = 0

    # ---- forecast (batched)
    def forecast(self, objects: list[dict], sw: dict | None, as_of: datetime | None = None) -> list[dict]:
        t_start = time.perf_counter()
        f107 = float((sw or {}).get('f107') or 150.0)
        kp = float((sw or {}).get('kp') or 2.0)
        now = as_of or datetime.now(timezone.utc)
        atm = Atmosphere(density_table(f107, kp, now), self.device, self.dtype)
        t0 = now.timestamp()

        prepared, results = [], []
        for o in objects:
            gp = o['elements']
            try:
                r, v = sgp4_state(gp, now)
                age = (now - parse_time(gp['EPOCH'])).total_seconds() / 86400.0
                prepared.append((o, gp, r, v, age))
            except Exception as e:
                msg = str(e)
                # SGP4 codes 1 (mean elements invalid) and 6 (decayed) at `now`
                # mean the last elements already put the object below orbit.
                likely_down = 'sgp4 error 1' in msg or 'sgp4 error 6' in msg
                results.append({
                    'id': o['id'],
                    'status': 'likely_reentered' if likely_down else 'error',
                    'error': ('last elements put it below orbit before now' if likely_down else msg)[:200],
                    'bands': [],
                    'area_km2_90': 0.0,
                    'n_samples': 0,
                    'scores': [],
                })
        if not prepared:
            return results

        # calibrate ballistic coefficients for all objects at once
        r0 = torch.tensor(np.stack([p[2] for p in prepared]), device=self.device, dtype=self.dtype)
        v0 = torch.tensor(np.stack([p[3] for p in prepared]), device=self.device, dtype=self.dtype)
        b0 = torch.tensor([bstar_to_b(float(p[1].get('BSTAR', 0))) for p in prepared], device=self.device, dtype=self.dtype)
        ndot = torch.tensor([2.0 * float(p[1].get('MEAN_MOTION_DOT', 0)) for p in prepared], device=self.device, dtype=self.dtype)
        bc, ok = calibrate_bc(r0, v0, b0, ndot, atm, self.dt)
        bc_np, ok_np = bc.cpu().numpy(), ok.cpu().numpy()

        # draw particles from the prior for every object, propagate in one batch
        sig_drag = SIG_LOG_DRAG + 0.05 * kp
        thetas, states = [], []
        for j, (o, gp, r, v, age) in enumerate(prepared):
            mu = np.zeros(4)
            sd = np.array([sig_drag if ok_np[j] else 0.6, SIG_ALONG_KM + SIG_ALONG_PER_DAY * max(age, 0), SIG_RADIAL_KM, SIG_CROSS_KM])
            th = np.random.default_rng().normal(mu, sd, size=(self.n, 4))
            thetas.append(th)
            states.append((mu, sd))
        big_theta = np.concatenate(thetas)
        rr, vv = [], []
        for j, p in enumerate(prepared):
            a, b = _perturbed_states(p[2], p[3], thetas[j], self.device, self.dtype)
            rr.append(a)
            vv.append(b)
        R = torch.cat(rr)
        V = torch.cat(vv)
        BC = torch.tensor(np.repeat(bc_np, self.n) * np.exp(big_theta[:, 0]), device=self.device, dtype=self.dtype)
        res = propagate(R, V, BC, t0, atm, self.horizon_s, self.dt)
        self.particle_steps_total += res.particle_steps
        t_re = res.t_reentry.cpu().numpy()
        lat = res.lat.cpu().numpy().astype(np.float64)
        lon = res.lon.cpu().numpy().astype(np.float64)
        r_re = res.r_reentry.cpu().numpy()
        v_re = res.v_reentry.cpu().numpy()

        for j, (o, gp, r, v, age) in enumerate(prepared):
            sl = slice(j * self.n, (j + 1) * self.n)
            mu, sd = states[j]
            st = ObjectState(
                key=self._key(o, sw, now),
                t0=t0,
                prior_mu=mu,
                prior_sd=sd,
                theta=thetas[j],
                log_q=_gauss_logpdf(thetas[j], mu, sd),
                t_re=t_re[sl],
                lat=lat[sl],
                lon=lon[sl],
                bc=float(bc_np[j]),
                calibrated=bool(ok_np[j]),
                rv=(r, v),
                meta={'age_days': age, 'f107': f107, 'kp': kp, 'atm': atm},
                r_re=r_re[sl],
                v_re=v_re[sl],
            )
            self.cache[o['id']] = st
            results.append(self._summarise(o['id'], st, np.ones(self.n) / self.n, []))
        ms = (time.perf_counter() - t_start) * 1000
        for r_ in results:
            r_['batch_ms'] = round(ms)
        return results

    # ---- sighting fusion for one object
    def update(self, obj: dict, sightings: list[dict], sw: dict | None, as_of: datetime | None = None) -> dict:
        st = self.cache.get(obj['id'])
        now = as_of or datetime.now(timezone.utc)
        if st is None or st.key != self._key(obj, sw, now):
            self.forecast([obj], sw, as_of)
            st = self.cache.get(obj['id'])
            if st is None:
                raise ValueError('forecast failed for object')
        w, scores = self._weights(st, sightings)
        ess = 1.0 / float((w * w).sum()) if w.sum() > 0 else 0.0
        rounds = 0
        # adaptive importance sampling: re-propose and re-propagate when weights collapse
        while sightings and ess < 0.1 * self.n and rounds < 2:
            self._refresh(st, w)
            w, scores = self._weights(st, sightings)
            ess = 1.0 / float((w * w).sum()) if w.sum() > 0 else 0.0
            rounds += 1
        out = self._summarise(obj['id'], st, w, scores)
        out['refreshes'] = rounds
        return out

    def _weights(self, st: ObjectState, sightings: list[dict]):
        logw = _gauss_logpdf(st.theta, st.prior_mu, st.prior_sd) - st.log_q
        decayed = np.isfinite(st.t_re)
        per_s = []
        for s in sightings:
            ts = parse_time(s['observed_at']).timestamp()
            trust = float(s.get('trust', 0.5))
            eps = min(0.6, max(0.05, EPS_BASE * (1.5 - trust)))
            dt = np.where(decayed, st.t_re - ts, 1e9)
            d = _great_circle_km(st.lat, st.lon, s['lat'], s['lon'])
            d = np.where(decayed, d, 2e4)
            g = np.exp(-0.5 * (dt / SIG_T_S) ** 2 - 0.5 * (d / SIG_D_KM) ** 2)
            floor = 1e-3  # outlier density, relative
            lik = (1 - eps) * g + eps * floor
            logw = logw + np.log(lik)
            per_s.append((s, eps, g, lik))
        logw -= logw.max()
        w = np.exp(logw)
        w /= w.sum()
        scores = []
        for s, eps, g, lik in per_s:
            p = float((w * (1 - eps) * g / lik).sum())
            if 'id' in s and s['id'] is not None:
                scores.append({'id': s['id'], 'p_inlier': round(p, 4)})
        return w, scores

    def _refresh(self, st: ObjectState, w: np.ndarray) -> None:
        """Fit a Gaussian proposal to the weighted particles (widened), draw a new
        set, re-propagate them on the device."""
        mu = (w[:, None] * st.theta).sum(0)
        var = (w[:, None] * (st.theta - mu) ** 2).sum(0)
        sd = np.maximum(np.sqrt(var) * 1.5, st.prior_sd * 0.02)
        th = np.random.default_rng().normal(mu, sd, size=(self.n, 4))
        atm = st.meta['atm']
        R, V = _perturbed_states(st.rv[0], st.rv[1], th, self.device, self.dtype)
        BC = torch.tensor(st.bc * np.exp(th[:, 0]), device=self.device, dtype=self.dtype)
        res = propagate(R, V, BC, st.t0, atm, self.horizon_s, self.dt)
        self.particle_steps_total += res.particle_steps
        st.theta = th
        st.log_q = _gauss_logpdf(th, mu, sd)
        st.t_re = res.t_reentry.cpu().numpy()
        st.lat = res.lat.cpu().numpy().astype(np.float64)
        st.lon = res.lon.cpu().numpy().astype(np.float64)
        st.r_re = res.r_reentry.cpu().numpy()
        st.v_re = res.v_reentry.cpu().numpy()

    def _summarise(self, oid: str, st: ObjectState, w: np.ndarray, scores: list) -> dict:
        decayed = np.isfinite(st.t_re)
        frac = float(w[decayed].sum())
        out = {
            'id': oid,
            'status': 'ok',
            'n_samples': int(self.n),
            'ess': round(1.0 / float((w * w).sum()), 1),
            'decayed_frac': round(frac, 4),
            'horizon_days': self.horizon_s / 86400.0,
            'calibrated': st.calibrated,
            'bc_m2_kg': round(st.bc, 5),
            'scores': scores,
        }
        if decayed.sum() >= 5 and frac > 0:
            wt = w[decayed] / frac
            tt = st.t_re[decayed]
            order = np.argsort(tt)
            cw = np.cumsum(wt[order])
            q = lambda p: float(tt[order][min(np.searchsorted(cw, p), len(tt) - 1)])
            out['t_quantiles'] = {str(p): datetime.fromtimestamp(q(p / 100), timezone.utc).isoformat() for p in (5, 25, 50, 75, 95)}
            bands, area = corridor_bands(st.lat[decayed], st.lon[decayed], wt)
            out['bands'] = bands
            out['area_km2_90'] = area
        else:
            out['bands'] = []
            out['area_km2_90'] = 0.0
        return out

    @staticmethod
    def _key(o: dict, sw: dict | None, now: datetime) -> str:
        blob = json.dumps([o.get('elements'), (sw or {}).get('f107'), (sw or {}).get('kp'), now.strftime('%Y-%m-%dT%H')], sort_keys=True, default=str)
        return hashlib.sha1(blob.encode()).hexdigest()


def _great_circle_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), math.radians(lat2)
    dl = np.radians(np.asarray(lon1) - lon2)
    c = np.sin(p1) * math.sin(p2) + np.cos(p1) * math.cos(p2) * np.cos(dl)
    return RE * np.arccos(np.clip(c, -1, 1))
