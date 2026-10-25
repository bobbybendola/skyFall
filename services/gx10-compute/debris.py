"""SKYFALL debris model (gx10-compute /debris). Every output is a MODELED ESTIMATE.

A much reduced "object-oriented" survivability model in the spirit of NASA DAS /
ESA DRAMA-SARA (see docs/DEBRIS_MODEL.md). Not an operator assessment.

Pipeline, batched over (particle x component copy) rows on one device:
- Each particle starts from a re-entry state at 80 km: the forecast's cached
  particles (sim.py), or a nominal `entry` state given in the request.
- The intact body flies on the object's ballistic coefficient down to a
  break-up altitude h_b ~ U(72, 84) km drawn per particle. Top-level
  components are the outside of the intact body and heat from 80 km; children
  are shielded by their parent until released.
- At h_b the top-level components are released. Components with a `parent`
  are released when the parent demises, or at h_b - U(0, 5) km, whichever
  comes first.
- Each released piece: 3-DOF flight (two-body + J2 gravity, drag against the
  co-rotating atmosphere; second-order Strang split with exponential drag
  decay so slow light pieces stay stable), tumbling-averaged Sutton-Graves heating (capped at the
  free-molecular limit 0.5 rho v^3), radiative cooling, melting
  at the melt temperature (mass loss, dimensions shrink with (m/m0)^(1/3)).
- Demise: m < 1% of the start mass, or m < 0.01 kg. Survive: reaches 0 km.

Limitations (documented, not hidden): no winds, no oxidation heating, no
fragmentation of components, tumbling-averaged hypersonic Cd at all speeds,
lat/lon-averaged NRLMSIS density, one level of parent-child nesting.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import torch

from sim import (
    E2,
    FLAT,
    OMEGA_E,
    RE,
    J2,
    MU,
    Atmosphere,
    altitude,
    density_table,
    eci_to_latlon,
    gmst_rad,
    parse_time,
)

MODEL = 'debris-v1'
LABEL = 'modeled estimate'

SUTTON_GRAVES_K = 1.7415e-4  # kg^0.5 / m, Earth air (Sutton & Graves 1971); q = k sqrt(rho/rn) v^3
SIGMA_SB = 5.670374e-8
T_START = 300.0  # K, component temperature at release
T_AMBIENT = 250.0  # K, radiative sink
H_PERSON_M2 = 0.36  # NASA casualty-area convention (sqrt = 0.6 m)
KE_CASUALTY_J = 15.0  # pieces below this impact energy do not count toward casualty area
DEMISE_FRAC = 0.01
DEMISE_MIN_KG = 0.01
LOW_ALT_GRID = (0.0, 200.0)  # km, density table for the debris flight
T_MAX_S = 7200.0  # flight-time cap; slower pieces are reported as unresolved

# Tumbling-averaged hypersonic drag coefficients (check against DRAMA/ORSAT).
CD_SHAPE = {'sphere': 0.92, 'cylinder': 1.0, 'box': 1.1, 'plate': 1.2}
DIMS_LEN = {'sphere': 1, 'cylinder': 2, 'box': 3, 'plate': 3}

# Jitter (1 sigma, lognormal) per particle x copy. Documented knobs.
SIG_MASS = 0.10
SIG_DIMS = 0.05
SIG_CD = 0.10
SIG_HEAT = 0.20
H_BREAKUP = (72.0, 84.0)  # km, uniform
CHILD_DROP_KM = 5.0  # children released at h_b - U(0, CHILD_DROP_KM) unless the parent demises first

# Fallback material table (docs/DEBRIS_MODEL.md section 3; all values "check").
# data/materials.json (R3) or the request's `materials` override these.
DEFAULT_MATERIALS: dict[str, dict] = {
    'Al6061': {'density': 2700, 'melt_k': 867, 'cp': 896, 'h_fusion': 3.9e5, 'emissivity': 0.3},
    'Ti6Al4V': {'density': 4430, 'melt_k': 1943, 'cp': 560, 'h_fusion': 3.6e5, 'emissivity': 0.3},
    'SS304': {'density': 8000, 'melt_k': 1700, 'cp': 500, 'h_fusion': 2.7e5, 'emissivity': 0.35},
    'CFRP': {'density': 1600, 'melt_k': 600, 'cp': 1100, 'h_fusion': 2.0e5, 'emissivity': 0.85},
    'Glass': {'density': 2500, 'melt_k': 1400, 'cp': 800, 'h_fusion': 1.4e5, 'emissivity': 0.8},
    'Copper': {'density': 8960, 'melt_k': 1356, 'cp': 385, 'h_fusion': 2.05e5, 'emissivity': 0.3},
}
_MATERIAL_KEYS = ('melt_k', 'cp', 'h_fusion', 'emissivity')


class DebrisInputError(ValueError):
    """Bad archetype / profile / materials: the job should fail with this reason."""


# ------------------------------------------------------------------ inputs


def normalize_materials(raw: dict | list | None) -> dict[str, dict]:
    """Accept {name: props} or [{id|name, ...props}]; tolerate a few key spellings."""
    out = {k: dict(v) for k, v in DEFAULT_MATERIALS.items()}
    if not raw:
        return out
    items = raw.items() if isinstance(raw, dict) else [(m.get('id') or m.get('name'), m) for m in raw]
    alias = {
        'density_kg_m3': 'density', 'melt_temp_k': 'melt_k', 'melting_point_k': 'melt_k', 'melt': 'melt_k',
        'specific_heat_j_kg_k': 'cp', 'specific_heat': 'cp', 'heat_of_fusion_j_kg': 'h_fusion',
        'heat_of_fusion': 'h_fusion', 'eps': 'emissivity',
    }
    for name, props in items:
        if not name or not isinstance(props, dict):
            continue
        p = {alias.get(k, k): v for k, v in props.items()}
        merged = {**out.get(name, {}), **{k: float(p[k]) for k in (*_MATERIAL_KEYS, 'density') if k in p}}
        if all(k in merged for k in _MATERIAL_KEYS):
            out[name] = merged
    return out


def _geometry(shape: str, dims: list[float]) -> tuple[float, float]:
    """(surface area m^2, nose radius m). Mean tumbling cross-section = S/4 (Cauchy, convex bodies)."""
    if shape == 'sphere':
        d = dims[0]
        return math.pi * d * d, d / 2
    if shape == 'cylinder':
        length, d = dims[0], dims[1]
        return math.pi * d * length + 0.5 * math.pi * d * d, d / 2
    a, b, c = dims[0], dims[1], dims[2]
    s = 2 * (a * b + a * c + b * c)
    return s, math.sqrt(s / 4 / math.pi)  # box / plate: radius of the equivalent mean cross-section (check)


def _is_structure(c: dict) -> bool:
    n = c['name'].lower()
    return 'structure' in n or n.startswith('bus') or ' bus' in n


def prepare_components(archetype: dict, profile: dict | None, materials: dict[str, dict], degraded: bool) -> tuple[list[dict], list[str]]:
    """Validate the archetype, scale to the profile mass, apply degraded cuts."""
    comps = archetype.get('components') or []
    if not comps:
        raise DebrisInputError(f"archetype {archetype.get('id')!r} has no components")
    warnings: list[str] = []
    out = []
    for i, c in enumerate(comps):
        name = str(c.get('name') or f'component-{i}')
        shape = c.get('shape')
        mat = c.get('material')
        dims = c.get('dims_m')
        mass = c.get('mass_kg')
        if shape not in CD_SHAPE:
            raise DebrisInputError(f'{name}: unknown shape {shape!r}')
        if mat not in materials:
            raise DebrisInputError(f'{name}: unknown material {mat!r}')
        if any(x['name'] == name for x in out):
            raise DebrisInputError(f'{name}: duplicate component name (use count for multiples)')
        try:
            dims_f = [float(d) for d in dims[: DIMS_LEN[shape]]] if isinstance(dims, list) else []
            mass_f = float(mass) if mass is not None else 0.0
            count = max(1, int(c.get('count', 1)))
        except (TypeError, ValueError):
            raise DebrisInputError(f'{name}: mass_kg, dims_m and count must be numbers')
        if len(dims_f) < DIMS_LEN[shape] or any(d <= 0 for d in dims_f):
            raise DebrisInputError(f'{name}: dims_m must have {DIMS_LEN[shape]} positive values for a {shape}')
        if mass_f <= 0:
            raise DebrisInputError(f'{name}: mass_kg must be positive')
        out.append({'name': name, 'shape': shape, 'material': mat, 'mass_kg': mass_f, 'dims_m': dims_f, 'count': count, 'parent': c.get('parent')})

    # Scale to the catalog mass: the structure absorbs the difference.
    total = sum(c['mass_kg'] * c['count'] for c in out)
    target = (profile or {}).get('mass_kg')
    if target and float(target) > 0 and abs(float(target) - total) / total > 0.02:
        target = float(target)
        struct = [c for c in out if _is_structure(c)] or [max(out, key=lambda c: c['mass_kg'] * c['count'])]
        s = struct[0]
        new_struct = s['mass_kg'] + (target - total) / s['count']
        if new_struct >= 0.25 * s['mass_kg']:
            k = new_struct / s['mass_kg']
            s['mass_kg'] = new_struct
            s['dims_m'] = [d * k ** (1 / 3) for d in s['dims_m']]
            warnings.append(f"scaled {s['name']} to match catalog mass {target:.0f} kg")
        else:
            k = target / total
            for c in out:
                c['mass_kg'] *= k
                c['dims_m'] = [d * k ** (1 / 3) for d in c['dims_m']]
            warnings.append(f'scaled all components by {k:.2f} to match catalog mass {target:.0f} kg')

    names = {c['name'] for c in out}
    for c in out:
        p = c['parent']
        if p is None:
            continue
        pc = next((x for x in out if x['name'] == p), None)
        if p not in names or pc is c or (pc and pc['parent']):
            warnings.append(f"{c['name']}: parent {p!r} invalid (missing, self or nested); released at break-up")
            c['parent'] = None

    if degraded:
        struct = next((c for c in out if _is_structure(c)), max(out, key=lambda c: c['mass_kg'] * c['count']))
        rest = sorted((c for c in out if c is not struct), key=lambda c: c['mass_kg'] * c['count'], reverse=True)[:2]
        keep = [struct, *rest]
        for c in keep:
            if c['parent'] and c['parent'] not in {k['name'] for k in keep}:
                c['parent'] = None
        out = keep
        warnings.append('degraded mode: main structure + two most massive components only')
    return out, warnings


# ------------------------------------------------------------------ entry states


def entry_from_nominal(e: dict, n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inertial (r km, v km/s, t unix) from a nominal Earth-relative entry state.

    `e`: {t (ISO), lat, lon, alt_km=80, speed_kms=7.3 (relative to the ground),
    flight_path_deg=-0.9 (negative = descending), heading_deg=90 (from north)}.
    Defaults match a natural decay from a near-circular orbit (what sim.py's
    forecast gives at 80 km: about -0.9 deg and 7.26 km/s).
    Small spreads in flight-path angle (0.1 deg) and speed (0.3%) per particle.
    """
    try:
        t = parse_time(str(e['t'])).timestamp()
        lat, lon = math.radians(float(e['lat'])), math.radians(float(e['lon']))
    except (KeyError, TypeError, ValueError):
        raise DebrisInputError('entry needs t (ISO time), lat and lon')
    # geodetic -> geocentric latitude, and the same small-flattening ellipsoid as sim.altitude
    lat_c = math.atan((1 - E2) * math.tan(lat))
    rad = RE * (1 - FLAT * math.sin(lat_c) ** 2) + float(e.get('alt_km', 80.0))
    lat = lat_c
    gam = np.radians(float(e.get('flight_path_deg', -0.9)) + rng.normal(0, 0.1, n))
    spd = float(e.get('speed_kms', 7.3)) * (1 + rng.normal(0, 0.003, n))
    hdg = math.radians(float(e.get('heading_deg', 90.0)))
    # local east/north/up in Earth-fixed coordinates
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.cross(up, east)
    horiz = math.cos(hdg) * north + math.sin(hdg) * east
    r_ef = rad * up
    v_ef = spd[:, None] * (np.cos(gam)[:, None] * horiz[None, :] + np.sin(gam)[:, None] * up[None, :])
    g = gmst_rad(t)
    rot = np.array([[math.cos(g), -math.sin(g), 0], [math.sin(g), math.cos(g), 0], [0, 0, 1]])
    r = np.repeat((rot @ r_ef)[None, :], n, axis=0)
    v = v_ef @ rot.T
    v = v + np.cross(np.array([0, 0, OMEGA_E]), r)  # Earth-fixed -> inertial velocity
    return r, v, np.full(n, t)


def entry_from_forecast(eng, obj: dict, sw: dict | None, as_of: datetime | None, n: int, rng: np.random.Generator):
    """Resample n re-entry states from the object's forecast particles.

    Reuses the engine's cached particles when they match (same elements, space
    weather and hour); otherwise runs the forecast for this object first. Each
    state keeps its particle's drag factor for the intact-body phase.
    Returns ((r, v, t), bc_intact, info).
    """
    now = as_of or datetime.now(timezone.utc)
    st = eng.cache.get(obj['id'])
    reused = st is not None and st.key == eng._key(obj, sw, now) and st.r_re is not None
    if not reused:
        res = eng.forecast([obj], sw, as_of)
        st = eng.cache.get(obj['id'])
        if st is None:
            err = res[0].get('error') if res else 'forecast failed'
            raise DebrisInputError(f'no forecast for {obj["id"]}: {err}')
    ok = np.flatnonzero(np.isfinite(st.t_re) & np.isfinite(st.r_re).all(1))
    if len(ok) == 0:
        raise DebrisInputError(f'{obj["id"]}: no forecast particle re-enters within {eng.horizon_s / 86400:g} days')
    idx = rng.choice(ok, size=n, replace=len(ok) < n)
    bc = st.bc * np.exp(st.theta[idx, 0])
    info = {
        'source': 'forecast',
        'reused_cache': reused,
        'decayed_frac': round(len(ok) / len(st.t_re), 4),
        'forecast_particles': int(len(st.t_re)),
        'bc_m2_kg': round(st.bc, 5),
        'calibrated': st.calibrated,
    }
    return (st.r_re[idx].astype(np.float64), st.v_re[idx].astype(np.float64), st.t_re[idx]), bc, info


_repo_materials: dict | None = None


def repo_materials() -> dict | list | None:
    """data/materials.json from the repo if present (R3 owns it); None otherwise."""
    global _repo_materials
    if _repo_materials is None:
        import json
        from pathlib import Path

        p = Path(__file__).resolve().parents[2] / 'data' / 'materials.json'
        try:
            raw = json.loads(p.read_text(encoding='utf-8'))
            _repo_materials = raw.get('materials', raw) if isinstance(raw, dict) else raw
        except (OSError, ValueError):
            _repo_materials = {}
    return _repo_materials or None


def default_bc(comps: list[dict], profile: dict | None) -> float:
    """Intact-body Cd*A/m (m^2/kg) from the profile dims or the archetype."""
    mass = float((profile or {}).get('mass_kg') or 0) or sum(c['mass_kg'] * c['count'] for c in comps)
    dims = (profile or {}).get('dims_m')
    if isinstance(dims, list) and len(dims) >= 3 and all(isinstance(d, (int, float)) and d > 0 for d in dims[:3]):
        s, _ = _geometry('box', [float(d) for d in dims[:3]])
    else:
        s = max(_geometry(c['shape'], c['dims_m'])[0] for c in comps if not c['parent'])
    return CD_SHAPE['box'] * (s / 4) / mass


# ------------------------------------------------------------------ flight


def _gravity(r: torch.Tensor) -> torch.Tensor:
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    r2 = x * x + y * y + z * z
    rn = torch.sqrt(r2)
    r3 = r2 * rn
    zr2 = z * z / r2
    k = 1.5 * J2 * MU * RE * RE / (r2 * r2 * rn)
    return torch.stack((-MU * x / r3 + k * x * (5 * zr2 - 1), -MU * y / r3 + k * y * (5 * zr2 - 1), -MU * z / r3 + k * z * (5 * zr2 - 3)), dim=1)


def _omega_cross(r: torch.Tensor) -> torch.Tensor:
    return torch.stack((-OMEGA_E * r[:, 1], OMEGA_E * r[:, 0], torch.zeros_like(r[:, 0])), dim=1)


FLYING, DEMISED, LANDED, UNRESOLVED = 0, 1, 2, 3


@dataclass
class FlightResult:
    state: np.ndarray  # per row: FLYING never remains; DEMISED / LANDED / UNRESOLVED
    t_end: np.ndarray  # unix s at impact / demise
    lat: np.ndarray
    lon: np.ndarray
    alt_end: np.ndarray  # km (demise altitude, 0 for impact)
    mass: np.ndarray  # kg at the end
    speed: np.ndarray  # m/s relative to the ground at the end
    area: np.ndarray  # m^2 mean cross-section at the end
    tracks: dict  # gid -> np.ndarray (k, 4): t_unix, lat, lon, alt_km
    row_steps: int
    steps: int
    t_max: np.ndarray  # K, peak temperature
    q_max: np.ndarray  # W/m^2, peak heat flux while exposed
    release: tuple  # (t unix, lat, lon, alt km) of the top-level release; NaN for children


def fly(
    r0: torch.Tensor,
    v0: torch.Tensor,
    t0: np.ndarray,
    row: dict[str, torch.Tensor],
    atm: Atmosphere,
    track_rows: torch.Tensor,
    dt_fast: float = 0.5,
    dt_slow: float = 2.0,
) -> FlightResult:
    """Integrate all rows to demise or impact.

    row: per-row tensors m0, s0 (surface m^2), rn0, cd, cp, hf, tm, eps, heat,
    release_alt (km), parent (global row index or -1), bc_intact (m^2/kg).
    All rows of one particle start from the same state, so attached rows (same
    drag, same inputs) move exactly with their parent.
    """
    dev, dt_ = r0.device, r0.dtype
    n = r0.shape[0]
    gid = torch.arange(n, device=dev)
    r, v = r0.clone(), v0.clone()
    t_off = torch.zeros(n, device=dev, dtype=torch.float64)  # seconds since each row's t0
    m = row['m0'].clone()
    T = torch.full((n,), T_START, device=dev, dtype=dt_)
    released = torch.zeros(n, device=dev, dtype=torch.bool)
    parent = row['parent'].clone()
    R = {k: v_ for k, v_ in row.items() if k not in ('parent',)}
    tracked = torch.zeros(n, device=dev, dtype=torch.bool)
    tracked[track_rows] = True

    out_state = torch.full((n,), FLYING, device=dev, dtype=torch.int8)
    out_t = torch.zeros(n, device=dev, dtype=torch.float64)
    out_lat = torch.zeros(n, device=dev, dtype=dt_)
    out_lon = torch.zeros(n, device=dev, dtype=dt_)
    out_alt = torch.zeros(n, device=dev, dtype=dt_)
    out_m = torch.zeros(n, device=dev, dtype=dt_)
    out_spd = torch.zeros(n, device=dev, dtype=dt_)
    out_area = torch.zeros(n, device=dev, dtype=dt_)
    out_tmax = torch.zeros(n, device=dev, dtype=dt_)
    out_qmax = torch.zeros(n, device=dev, dtype=dt_)
    T_max = T.clone()
    q_max = torch.zeros(n, device=dev, dtype=dt_)
    rel_t = torch.full((n,), float('nan'), device=dev, dtype=torch.float64)  # top-level release (break-up)
    rel_r = torch.full((n, 3), float('nan'), device=dev, dtype=dt_)
    rec: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor]] = []  # (gid, t_off, r) of tracked rows per step

    def record(mask: torch.Tensor, rr: torch.Tensor, tt: torch.Tensor):
        if bool(mask.any()):
            rec.append((gid[mask], tt[mask], rr[mask]))

    t0_dev = torch.as_tensor(t0, device=dev, dtype=torch.float64)
    record(tracked, r, t_off)
    h = altitude(r)
    row_steps, steps, t_sim = 0, 0, 0.0
    while r.shape[0] > 0:
        scale = (m / R['m0']).clamp_min(1e-9) ** (1 / 3)
        area = R['s0'] * scale * scale / 4  # mean tumbling cross-section
        own_bc = R['cd'] * area / m
        has_par = parent >= 0
        pidx = parent.clamp_min(0)
        par_bc = torch.where(released[pidx], own_bc[pidx], R['bc_intact'])
        bc = torch.where(released, own_bc, torch.where(has_par, par_bc, R['bc_intact']))

        vrel = v - _omega_cross(r)
        sp = torch.linalg.vector_norm(vrel, dim=1)  # km/s
        dt = dt_fast if float(sp.max()) > 1.0 else dt_slow
        rho = atm.rho(h)
        # heating (released rows only), per unit time
        rn = R['rn0'] * scale
        v3 = (sp * 1e3) ** 3
        # continuum Sutton-Graves, capped at the free-molecular limit (full accommodation)
        q = torch.minimum(SUTTON_GRAVES_K * torch.sqrt(rho / rn) * v3, 0.5 * rho * v3) * R['heat']
        q_net = q * area - R['eps'] * SIGMA_SB * (T**4 - T_AMBIENT**4) * R['s0'] * scale * scale
        # top-level parts are the outside of the intact body and heat from the start;
        # children are shielded until released
        exposed = released | ~has_par
        e = torch.where(exposed, q_net * dt, torch.zeros_like(q_net))
        need = (m * R['cp'] * (R['tm'] - T)).clamp_min(0)
        melting = e > need
        T = torch.where(melting, R['tm'], (T + e / (m * R['cp'])).clamp_min(T_AMBIENT))
        m = torch.where(melting, m - (e - need) / R['hf'], m)
        T_max = torch.maximum(T_max, T)
        q_max = torch.maximum(q_max, torch.where(exposed, q, torch.zeros_like(q)))

        # Strang split, second order: half drag, kick-drift-kick gravity (velocity Verlet),
        # half drag. Drag decays the air-relative velocity exponentially with k frozen
        # over the half step, so it stays stable for slow light pieces (k dt >> 1).
        k = 0.5e3 * rho * sp * bc  # 1/s  (rho kg/m^3 * v m/s * m^2/kg)
        wr = _omega_cross(r)
        v_half = (v - wr) * torch.exp(-0.5 * k * dt)[:, None] + wr
        v_half = v_half + 0.5 * dt * _gravity(r)
        r_new = r + dt * v_half
        v_half = v_half + 0.5 * dt * _gravity(r_new)
        h_new = altitude(r_new)
        wr_new = _omega_cross(r_new)
        sp_new = torch.linalg.vector_norm(v_half - wr_new, dim=1)
        k_new = 0.5e3 * atm.rho(h_new) * sp_new * bc
        v_new = (v_half - wr_new) * torch.exp(-0.5 * k_new * dt)[:, None] + wr_new
        # Below 1 km/s light pieces have k ~ g/v_term ~ 1-3 /s, so k dt >> 1 and the split
        # above settles at far below terminal speed (a 2 s step lands a 0.5 kg plate at
        # 5 m/s, not 12). There, use the exact solution of du/dt = -k u + g with k, g and
        # the rotating-air velocity w frozen over the step: it reaches u = g/k (terminal
        # speed) at any dt.
        slow = sp < 1.0
        if bool(slow.any()):
            x = k * dt
            kc = k.clamp_min(1e-30)
            a = torch.where(x > 1e-3, -torch.expm1(-x) / kc, dt * (1 - 0.5 * x))  # int_0^dt e^-ks ds
            b = torch.where(x > 1e-3, (dt - a) / kc, dt * dt * (0.5 - x / 6))  # int_0^dt of that
            g0 = _gravity(r)
            u = v - wr
            r_s = r + u * a[:, None] + g0 * b[:, None] + dt * wr
            v_s = u * torch.exp(-x)[:, None] + g0 * a[:, None] + wr
            r_new = torch.where(slow[:, None], r_s, r_new)
            v_new = torch.where(slow[:, None], v_s, v_new)
            h_new = torch.where(slow, altitude(r_new), h_new)
        t_new = t_off + dt
        row_steps += r.shape[0]
        steps += 1
        t_sim += dt

        # release: top-level rows at h_b; children at their own altitude or when the parent demises
        now_rel = (h_new <= R['release_alt']) | (has_par & _demised(m[pidx], R['m0'][pidx]))
        first = now_rel & ~released & ~has_par
        if bool(first.any()):
            g = gid[first]
            rel_t[g] = t_new[first]
            rel_r[g] = r_new[first]
        released = released | now_rel

        # events
        dead = _demised(m, R['m0'])
        landed = (h_new <= 0) & ~dead
        timeout = torch.full_like(dead, t_sim >= T_MAX_S) & ~dead & ~landed
        f = (h / (h - h_new).clamp_min(1e-9)).clamp(0, 1)
        r_ev = torch.where(landed[:, None], r + f[:, None] * (r_new - r), r_new)
        t_ev = torch.where(landed, t_off + f.double() * dt, t_new)
        ev = dead | landed | timeout
        r, v, h, t_off = r_new, v_new, h_new, t_new
        if not bool(ev.any()):
            record(tracked, r, t_off)
            continue
        g = gid[ev]
        la, lo = eci_to_latlon(r_ev[ev], t0_dev[g] + t_ev[ev])
        out_state[g] = torch.where(dead[ev], DEMISED, torch.where(landed[ev], LANDED, UNRESOLVED)).to(torch.int8)
        out_t[g] = t_ev[ev]
        out_lat[g], out_lon[g] = la, lo
        out_alt[g] = torch.where(landed[ev], torch.zeros_like(h[ev]), h[ev])
        out_m[g] = m[ev].clamp_min(0)
        out_spd[g] = torch.linalg.vector_norm(v[ev] - _omega_cross(r_ev[ev]), dim=1) * 1e3
        out_area[g] = area[ev]
        out_tmax[g] = T_max[ev]
        out_qmax[g] = q_max[ev]
        record(tracked & ~ev, r, t_off)
        record(tracked & ev, r_ev, t_ev)

        # Compact. A finished parent never strands an attached child: if the parent
        # demised the child was released this step; if it landed, the child did too.
        keep = ~ev
        new_idx = torch.cumsum(keep.long(), 0) - 1
        parent = torch.where(has_par & keep[pidx], new_idx[pidx], torch.full_like(parent, -1))
        r, v, h, t_off, m, T, T_max, q_max, released, gid, tracked, parent = (
            x[keep] for x in (r, v, h, t_off, m, T, T_max, q_max, released, gid, tracked, parent)
        )
        R = {k_: x[keep] for k_, x in R.items()}
    tracks = _collect_tracks(rec, t0)
    rel_t_np = rel_t.cpu().numpy()
    rel_ok = np.isfinite(rel_t_np)
    rel_lat = np.full(n, np.nan)
    rel_lon = np.full(n, np.nan)
    rel_alt = np.full(n, np.nan)
    if rel_ok.any():
        ok_t = torch.as_tensor(rel_ok, device=dev)
        rr = rel_r[ok_t]
        la, lo = eci_to_latlon(rr, t0_dev[ok_t] + rel_t[ok_t])
        rel_lat[rel_ok], rel_lon[rel_ok] = la.cpu().numpy(), lo.cpu().numpy()
        rel_alt[rel_ok] = altitude(rr).cpu().numpy()
    return FlightResult(
        state=out_state.cpu().numpy(), t_end=(t0 + out_t.cpu().numpy()), lat=out_lat.cpu().numpy().astype(np.float64),
        lon=out_lon.cpu().numpy().astype(np.float64), alt_end=out_alt.cpu().numpy(), mass=out_m.cpu().numpy(),
        speed=out_spd.cpu().numpy(), area=out_area.cpu().numpy(), tracks=tracks, row_steps=row_steps, steps=steps,
        t_max=out_tmax.cpu().numpy(), q_max=out_qmax.cpu().numpy(),
        release=(t0 + rel_t_np, rel_lat, rel_lon, rel_alt),
    )


def _demised(m: torch.Tensor, m0: torch.Tensor) -> torch.Tensor:
    return (m < DEMISE_FRAC * m0) | (m < DEMISE_MIN_KG)


# ------------------------------------------------------------------ outputs


def _collect_tracks(rec: list, t0: np.ndarray) -> dict[int, np.ndarray]:
    if not rec:
        return {}
    gid = torch.cat([x[0] for x in rec])
    tt = torch.cat([x[1] for x in rec])
    rr = torch.cat([x[2] for x in rec])
    t_abs = torch.as_tensor(t0, device=gid.device, dtype=torch.float64)[gid] + tt
    la, lo = eci_to_latlon(rr, t_abs)
    alt = altitude(rr)
    arr = torch.stack((t_abs, la.double(), lo.double(), alt.double()), dim=1).cpu().numpy()
    g = gid.cpu().numpy()
    out: dict[int, np.ndarray] = {}
    for k in np.unique(g):
        a = arr[g == k]
        out[int(k)] = a[np.argsort(a[:, 0], kind='stable')]
    return out


def downsample_track(a: np.ndarray, n_max: int = 60) -> list[list[float]]:
    """Up to n_max points, evenly spaced along the 3D path (dense where it moves fast), ends kept."""
    if len(a) > n_max:
        lat, lon, alt = np.radians(a[:, 1]), np.radians(a[:, 2]), a[:, 3]
        x = (RE + alt) * np.cos(lat) * np.cos(lon)
        y = (RE + alt) * np.cos(lat) * np.sin(lon)
        z = (RE + alt) * np.sin(lat)
        # path length, with altitude weighted up so the slow vertical fall still gets points
        seg = np.sqrt(np.diff(x) ** 2 + np.diff(y) ** 2 + np.diff(z) ** 2) + 3.0 * np.abs(np.diff(alt)) + 1e-9
        cum = np.concatenate(([0.0], np.cumsum(seg)))
        idx = np.unique(np.searchsorted(cum, np.linspace(0, cum[-1], n_max)).clip(0, len(a) - 1))
        idx[-1] = len(a) - 1
        a = a[idx]
    return [[round(float(p[0]), 1), round(float(p[1]), 4), round(float(p[2]), 4), round(max(float(p[3]), 0.0), 3)] for p in a]


def footprint_bands(lat: np.ndarray, lon: np.ndarray, levels=(50, 90), max_cells: int = 160) -> tuple[list[dict], float]:
    """50/90% highest-density regions of impact points on a local grid.

    Cell size adapts to the spread (fine for a tight footprint, 1 deg for a global
    one). Rings are [lon, lat]; longitudes stay continuous across 180 deg (may
    exceed +-180) so a band crossing the antimeridian draws as one ring.
    """
    from scipy.ndimage import gaussian_filter
    from skimage.measure import approximate_polygon, find_contours

    if len(lat) < 5:
        return [], 0.0
    lon0 = math.degrees(math.atan2(np.sin(np.radians(lon)).mean(), np.cos(np.radians(lon)).mean()))
    dl = (lon - lon0 + 180) % 360 - 180
    lat_c = float(np.median(lat))
    coslat = max(math.cos(math.radians(lat_c)), 0.1)
    span = max(float(np.ptp(lat)), float(np.ptp(dl)) * coslat, 0.05)
    cell = float(np.clip(span / (max_cells * 0.6), 0.01, 1.0))  # degrees of latitude
    cx, cy = cell / coslat, cell
    pad = 4
    x0, y0 = dl.min() - pad * cx, lat.min() - pad * cy
    nx = int(np.ceil((dl.max() - x0) / cx)) + pad + 1
    ny = int(np.ceil((lat.max() - y0) / cy)) + pad + 1
    ix = np.clip(((dl - x0) / cx).astype(int), 0, nx - 1)
    iy = np.clip(((lat - y0) / cy).astype(int), 0, ny - 1)
    grid = np.zeros((ny, nx))
    np.add.at(grid, (iy, ix), 1.0)
    grid = gaussian_filter(grid, sigma=1.2, mode='constant')
    grid /= grid.sum()
    flat = np.sort(grid.ravel())[::-1]
    cum = np.cumsum(flat)
    lat_cells = y0 + (np.arange(ny) + 0.5) * cy
    km = math.radians(1) * RE
    cell_area = (cx * km * np.cos(np.radians(lat_cells)))[:, None] * (cy * km) * np.ones((1, nx))
    bands, area90 = [], 0.0
    for level in sorted(levels, reverse=True):
        thr = flat[min(int(np.searchsorted(cum, level / 100.0)), len(flat) - 1)]
        mask = grid >= thr
        if level == 90:
            area90 = float(cell_area[mask].sum())
        polys = []
        for c in find_contours(np.pad(mask.astype(float), 1), 0.5):
            c = approximate_polygon(c, tolerance=0.6)
            if len(c) < 4:
                continue
            ring = [[round(lon0 + x0 + (x - 1 + 0.5) * cx, 4), round(y0 + (y - 1 + 0.5) * cy, 4)] for y, x in c]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            polys.append(ring)
        polys.sort(key=len, reverse=True)
        bands.extend({'level': level, 'polygon': ring} for ring in polys[:10])
    return bands, area90


def footprint_center(lat: np.ndarray, lon: np.ndarray) -> list[float] | None:
    """[lon, lat] median impact point (circular in longitude): the end of the globe's landing line."""
    if len(lat) == 0:
        return None
    lon0 = math.degrees(math.atan2(np.sin(np.radians(lon)).mean(), np.cos(np.radians(lon)).mean()))
    dl = (lon - lon0 + 180) % 360 - 180
    c = (lon0 + float(np.median(dl)) + 180) % 360 - 180
    return [round(c, 4), round(float(np.median(lat)), 4)]


HAZARD_CELL_DEG = 1.0  # ~110 km cells for the warning-level grid


def hazard_grid(lat: np.ndarray, lon: np.ndarray, hazard: np.ndarray, cell_deg: float = HAZARD_CELL_DEG, max_cells: int = 5000) -> dict:
    """Per ground cell, the share of runs in which at least one dangerous (>= 15 J) piece
    lands there. lat/lon/hazard are (runs, pieces). Cells are [lat_south, lon_west, runs]
    on a fixed cell_deg grid; p = runs / n_runs. The smallest non-zero p is 1/n_runs.
    Keeps the max_cells highest-p cells (a far-off re-entry spreads over most of the
    orbit's latitude band); 'truncated' says whether any were dropped.
    """
    P = lat.shape[0]
    run, piece = np.nonzero(hazard)
    if len(run) == 0:
        return {'cell_deg': cell_deg, 'n_runs': P, 'cells': [], 'truncated': False}
    i = np.floor((lat[run, piece] + 90) / cell_deg).astype(np.int64)
    j = np.floor((((lon[run, piece] + 180) % 360) / cell_deg)).astype(np.int64)
    n_j = int(round(360 / cell_deg))
    cell = i * n_j + j
    pairs = np.unique(cell * P + run)  # one count per (cell, run)
    cells, runs = np.unique(pairs // P, return_counts=True)
    truncated = len(cells) > max_cells
    if truncated:
        keep = np.argsort(-runs, kind='stable')[:max_cells]
        cells, runs = cells[keep], runs[keep]
    out = [[round(float(c // n_j * cell_deg - 90), 3), round(float(c % n_j * cell_deg - 180), 3), int(r)] for c, r in zip(cells, runs)]
    return {'cell_deg': cell_deg, 'n_runs': P, 'cells': out, 'truncated': bool(truncated)}


def impact_samples(lat: np.ndarray, lon: np.ndarray, n_max: int = 40) -> list[list[float]]:
    """Up to n_max sampled [lon, lat] impact points (for per-impact lines on the globe)."""
    idx = np.linspace(0, len(lat) - 1, min(n_max, len(lat))).astype(int) if len(lat) else []
    return [[round(float(lon[i]), 4), round(float(lat[i]), 4)] for i in idx]


def _stat(x: np.ndarray, digits: int = 3) -> dict:
    if len(x) == 0:
        return {'mean': None}
    return {'mean': round(float(x.mean()), digits), 'p05': round(float(np.percentile(x, 5)), digits), 'p95': round(float(np.percentile(x, 95)), digits)}


def _iso(t: float) -> str:
    return datetime.fromtimestamp(float(t), timezone.utc).isoformat()


# ------------------------------------------------------------------ top level


def run_debris(
    object_id: str,
    archetype: dict,
    profile: dict | None,
    materials: dict[str, dict],
    entry: tuple[np.ndarray, np.ndarray, np.ndarray],
    bc_intact: np.ndarray,
    sw: dict | None,
    device: torch.device,
    degraded: bool = False,
    tracks_per_component: int = 3,
    seed: int | None = None,
) -> dict:
    """entry = (r km (P,3), v km/s (P,3), t unix (P,)) at ~80 km; bc_intact (P,) m^2/kg."""
    t_start = time.perf_counter()
    rng = np.random.default_rng(seed)
    comps, warnings = prepare_components(archetype, profile, materials, degraded)
    r_e, v_e, t_e = entry
    P = len(t_e)

    # expand components into copies; rows are particle-major (P x K)
    copies = [(ci, j) for ci, c in enumerate(comps) for j in range(c['count'])]
    K = len(copies)
    first_copy = {comps[ci]['name']: k for k, (ci, j) in enumerate(copies) if j == 0}
    base = {key: np.array([_copy_prop(comps[ci], materials, key) for ci, _ in copies]) for key in ('m0', 's0', 'rn0', 'cd', 'cp', 'hf', 'tm', 'eps')}
    par_k = np.array([first_copy[comps[ci]['parent']] if comps[ci]['parent'] else -1 for ci, _ in copies])

    n = P * K
    tile = lambda a: np.tile(a, P)
    d_j = np.exp(rng.normal(0, SIG_DIMS, n))
    rows = {
        'm0': tile(base['m0']) * np.exp(rng.normal(0, SIG_MASS, n)),
        's0': tile(base['s0']) * d_j * d_j,
        'rn0': tile(base['rn0']) * d_j,
        'cd': tile(base['cd']) * np.exp(rng.normal(0, SIG_CD, n)),
        'cp': tile(base['cp']),
        'hf': tile(base['hf']),
        'tm': tile(base['tm']),
        'eps': tile(base['eps']),
        'heat': np.exp(rng.normal(0, SIG_HEAT, n)),
    }
    h_b = rng.uniform(*H_BREAKUP, P)
    is_child = tile(par_k >= 0)
    rows['release_alt'] = np.repeat(h_b, K) - np.where(is_child, rng.uniform(0, CHILD_DROP_KM, n), 0.0)
    rows['bc_intact'] = np.repeat(bc_intact, K)
    parent = np.where(is_child, np.repeat(np.arange(P) * K, K) + tile(np.maximum(par_k, 0)), -1)

    dt_ = torch.float32
    T = {k: torch.tensor(v, device=device, dtype=dt_) for k, v in rows.items()}
    T['parent'] = torch.tensor(parent, device=device, dtype=torch.long)
    r0 = torch.tensor(np.repeat(r_e, K, axis=0), device=device, dtype=dt_)
    v0 = torch.tensor(np.repeat(v_e, K, axis=0), device=device, dtype=dt_)
    t0 = np.repeat(t_e, K).astype(np.float64)

    # tracked rows: the first copy of each component in the first few particles (picked from later)
    n_track_p = min(P, max(tracks_per_component * 3, 6))
    track_rows = torch.tensor([p * K + first_copy[c['name']] for p in range(n_track_p) for c in comps], device=device, dtype=torch.long)

    f107 = float((sw or {}).get('f107') or 150.0)
    kp = float((sw or {}).get('kp') or 2.0)
    when = datetime.fromtimestamp(float(np.median(t_e)), timezone.utc)
    atm = Atmosphere(density_table(f107, kp, when, LOW_ALT_GRID), device, dt_, h0=LOW_ALT_GRID[0])
    res = fly(r0, v0, t0, T, atm, track_rows, dt_fast=1.0 if degraded else 0.5, dt_slow=4.0 if degraded else 2.0)

    # ---- aggregate
    st = res.state.reshape(P, K)
    land = st == LANDED
    mass = res.mass.reshape(P, K)
    spd = res.speed.reshape(P, K)
    energy = 0.5 * mass * spd**2
    area = res.area.reshape(P, K)
    hazard = land & (energy >= KE_CASUALTY_J)  # what casualty-risk tools count (NASA-STD-8719.14)
    a_c = np.where(hazard, (math.sqrt(H_PERSON_M2) + np.sqrt(area)) ** 2, 0.0)
    surv_mass = np.where(land, mass, 0.0).sum(1)
    total_mass = float(sum(c['mass_kg'] * c['count'] for c in comps))
    n_hazard = hazard.sum(1)
    lat, lon, t_end, alt_end = (x.reshape(P, K) for x in (res.lat, res.lon, res.t_end, res.alt_end))
    t_max, q_max = res.t_max.reshape(P, K), res.q_max.reshape(P, K)

    comp_out = []
    for ci, c in enumerate(comps):
        ks = [k for k, (cj, _) in enumerate(copies) if cj == ci]
        ok = land[:, ks].ravel()
        dem = (st[:, ks] == DEMISED).ravel()
        c_lat, c_lon = lat[:, ks].ravel()[ok], lon[:, ks].ravel()[ok]
        bands, area90 = footprint_bands(c_lat, c_lon)
        center = footprint_center(c_lat, c_lon)
        c_imp = t_end[:, ks].ravel()[ok]
        comp_out.append({
            'name': c['name'], 'material': c['material'], 'shape': c['shape'], 'count': c['count'],
            'parent': c['parent'], 'mass_kg_start': round(c['mass_kg'], 3),
            'p_survive': round(float(ok.mean()), 4),
            'p_hazard': round(float(hazard[:, ks].mean()), 4),  # per copy, lands with >= 15 J
            'p_unresolved': round(float((st[:, ks] == UNRESOLVED).mean()), 4),
            'mass_kg': {'start': round(c['mass_kg'], 3), **_stat(mass[:, ks].ravel()[ok])},
            'impact_speed_ms': _stat(spd[:, ks].ravel()[ok], 1),
            'impact_energy_j': _stat(energy[:, ks].ravel()[ok], 0),
            'demise_alt_km': _stat(alt_end[:, ks].ravel()[dem], 2),
            'flight_s': _stat((t_end[:, ks] - t_e[:, None]).ravel()[ok], 0),  # 80 km -> impact
            'impact_time': {f'q{q:02d}': _iso(np.percentile(c_imp, q)) for q in (5, 50, 95)} if len(c_imp) else None,
            'max_temperature_k': _stat(t_max[:, ks].ravel(), 0),
            'max_heat_flux_w_m2': _stat(q_max[:, ks].ravel(), 0),
            'impact': {'lat': center[1], 'lon': center[0]} if center else None,
            'footprint': {'bands': bands, 'area_km2_90': round(area90), 'center': center, 'samples': impact_samples(c_lat, c_lon)},
        })

    all_bands, all_area = footprint_bands(lat[land], lon[land])
    t_imp = t_end[land]
    return {
        'id': object_id,
        'label': LABEL,
        'model': MODEL,
        'archetype': archetype.get('id'),
        'archetype_name': archetype.get('name'),
        'archetype_confidence': archetype.get('confidence'),
        'archetype_sources': archetype.get('sources', []),
        'note': 'Modeled estimate: generic archetype, break-up at 72-84 km, lumped-mass heating, no winds or fragmentation.',
        'breakup': _breakup(res.release),
        'n_particles': P,
        'n_pieces_per_particle': K,
        'degraded': degraded,
        # any piece at all reaches the ground, even a harmless flake: near 1 for most
        # satellites, so it is not a danger measure. Use 'hazard' for that.
        'p_any_survives': round(float(land.any(1).mean()), 4),
        'hazard': {
            'ke_threshold_j': KE_CASUALTY_J,
            'p_any': round(float(n_hazard.astype(bool).mean()), 4),
            'pieces_mean': round(float(n_hazard.mean()), 3),
            'pieces_p95': round(float(np.percentile(n_hazard, 95)), 3),
        },
        'hazard_grid': hazard_grid(lat, lon, hazard),
        'surviving_mass_frac': round(float(surv_mass.mean()) / total_mass, 4) if total_mass > 0 else 0.0,
        'surviving_mass_kg': {'mean': round(float(surv_mass.mean()), 3), 'p95': round(float(np.percentile(surv_mass, 95)), 3)},
        'casualty_area_m2': {'mean': round(float(a_c.sum(1).mean()), 3)},
        'components': comp_out,
        'footprint': {'bands': all_bands, 'area_km2_90': round(all_area), 'center': footprint_center(lat[land], lon[land])},
        'impact_time': {f'q{q:02d}': _iso(np.percentile(t_imp, q)) for q in (5, 50, 95)} if len(t_imp) else None,
        'entry_time': {f'q{q:02d}': _iso(np.percentile(t_e, q)) for q in (5, 50, 95)},
        'sample_tracks': _pick_tracks(res.tracks, comps, first_copy, K, st, tracks_per_component),
        'n_unresolved': int((st == UNRESOLVED).sum()),
        'warnings': warnings,
        'particle_steps': int(res.row_steps),
        'steps': int(res.steps),
        'device': str(device),
        'gpu_name': torch.cuda.get_device_name(device) if device.type == 'cuda' else None,
        'ms': round((time.perf_counter() - t_start) * 1000),
    }


def _breakup(release: tuple) -> dict | None:
    """Median break-up point over the rows that were released (the globe's breakup marker)."""
    t, lat, lon, alt = release
    ok = np.isfinite(t)
    if not ok.any():
        return None
    center = footprint_center(lat[ok], lon[ok])
    return {'t_unix_s': round(float(np.median(t[ok])), 1), 'lat': center[1], 'lon': center[0], 'alt_km': round(float(np.median(alt[ok])), 2)}


def _copy_prop(c: dict, materials: dict[str, dict], key: str) -> float:
    if key == 'm0':
        return c['mass_kg']
    if key in ('s0', 'rn0'):
        s, rn = _geometry(c['shape'], c['dims_m'])
        return s if key == 's0' else rn
    if key == 'cd':
        return CD_SHAPE[c['shape']]
    mat = materials[c['material']]
    return float(mat[{'cp': 'cp', 'hf': 'h_fusion', 'tm': 'melt_k', 'eps': 'emissivity'}[key]])


def _pick_tracks(tracks: dict, comps: list[dict], first_copy: dict, K: int, st: np.ndarray, per_comp: int) -> list[dict]:
    """Per component: up to two surviving and one demised trajectory (whatever exists)."""
    out = []
    for c in comps:
        k = first_copy[c['name']]
        cands = sorted(g for g in tracks if g % K == k)
        surv = [g for g in cands if st[g // K, k] == LANDED]
        dem = [g for g in cands if st[g // K, k] != LANDED]
        pick = (surv[: per_comp - 1] + dem[:1]) if surv and dem else (surv or dem)[:per_comp]
        for g in pick:
            out.append({'component': c['name'], 'survived': bool(st[g // K, k] == LANDED), 'points': downsample_track(tracks[g])})
    return out
