"""gx10-compute: plain HTTP in, JSON out. Never talks to SpacetimeDB.

/forecast  batched Monte Carlo decay forecast for many objects (sim.py), the GX10's main job
/debris    break-up and survivability Monte Carlo for one object (debris.py); MODELED ESTIMATE
/update    sighting fusion for one object (sim.py). Objects whose elements are the
           old "circular-ground-track-stub" model still use the Phase 1 stub below.
/classify  stub that accepts everything (Phase 3).

USE_GPU=1 runs on CUDA with SIM_N particles per object (default 20000) and a
HORIZON_DAYS horizon (default 10). On CPU the defaults drop to 300 particles and
3 days: that is the degraded mode the UI labels. /debris uses DEBRIS_N particles
(default 2000 on CUDA; 100 on CPU, degraded: main structure + 2 heaviest parts).
"""

from __future__ import annotations

import math
import os
import time
from datetime import datetime

import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

USE_GPU = os.environ.get("USE_GPU", "1") == "1"
EARTH_R_KM = 6371.0
EARTH_ROT_DEG_S = 360.0 / 86164.0

app = FastAPI(title="gx10-compute")

_engine = None
_engine_lock = threading.Lock()  # one simulation at a time; torch state is shared


def engine():
    global _engine
    if _engine is None:
        import torch

        from sim import Engine

        cuda = USE_GPU and torch.cuda.is_available()
        dev = torch.device("cuda" if cuda else "cpu")
        n = int(os.environ.get("SIM_N") or (20000 if cuda else 300))
        horizon = float(os.environ.get("HORIZON_DAYS") or (10 if cuda else 3))
        _engine = Engine(dev, n_per_object=n, horizon_days=horizon)
    return _engine


class ObjectIn(BaseModel):
    id: str | None = None
    elements: dict
    window_start: str | None = None  # ISO 8601; only the stub uses it
    window_end: str | None = None


class ForecastObject(BaseModel):
    id: str
    elements: dict  # GP / OMM JSON (CelesTrak, Space-Track)


class ForecastIn(BaseModel):
    objects: list[ForecastObject]
    space_weather: dict | None = None
    as_of: str | None = None  # ISO 8601; default now (replays pass the event time)


class SightingIn(BaseModel):
    id: int | None = None
    trust: float = 0.5  # from reporter_stats via the worker; lowers eps for good reporters
    lat: float
    lon: float
    observed_at: str
    bearing_deg: float | None = None


class UpdateIn(BaseModel):
    object: ObjectIn
    sightings: list[SightingIn] = []
    space_weather: dict | None = None  # {kp, f107}
    as_of: str | None = None


class DebrisObject(BaseModel):
    id: str
    elements: dict | None = None  # GP / OMM JSON; not needed when `entry` is given


class DebrisIn(BaseModel):
    object: DebrisObject
    archetype: dict  # docs/DEBRIS_MODEL.md section 2
    profile: dict | None = None  # satellite_profile row (mass_kg, dims_m, ...)
    materials: dict | list | None = None  # overrides data/materials.json and the built-in table
    space_weather: dict | None = None
    n_particles: int | None = None
    entry: dict | None = None  # nominal 80 km state instead of the forecast (tests, past cases)
    as_of: str | None = None
    degraded: bool | None = None  # default: degraded when not on CUDA
    seed: int | None = None


class ClassifyIn(BaseModel):
    image_b64: str | None = None
    clip_ref: str | None = None


def _gpu_info() -> tuple[str, float | None]:
    if not USE_GPU:
        return "cpu (USE_GPU=0)", None
    try:
        import torch  # optional in phase 1

        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return torch.cuda.get_device_name(0), free / 2**30
        return "cpu (cuda unavailable)", None
    except ImportError:
        return "cpu (torch not installed)", None


def _ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def _ground_point(el: dict, t: float) -> tuple[float, float]:
    """Sub-satellite point for a circular orbit. Simplified on purpose."""
    inc = math.radians(el.get("inclination_deg", 51.6))
    raan = el.get("raan_deg", 0.0)
    period_s = el.get("period_min", 88.0) * 60.0
    epoch = _ts(el["epoch"]) if "epoch" in el else 0.0
    u = math.radians(el.get("arg_lat_deg", 0.0)) + 2 * math.pi * (t - epoch) / period_s
    lat = math.degrees(math.asin(math.sin(inc) * math.sin(u)))
    lon = raan + math.degrees(math.atan2(math.cos(inc) * math.sin(u), math.cos(u)))
    lon -= EARTH_ROT_DEG_S * (t - epoch)
    return lat, lon


def _unwrap(lons: list[float]) -> list[float]:
    """Keep longitudes continuous so a band crossing 180 deg draws as one ring."""
    out = [((lons[0] + 180) % 360) - 180]
    for x in lons[1:]:
        prev = out[-1]
        d = ((x - prev + 180) % 360) - 180
        out.append(prev + d)
    return out


def _band(el: dict, t_mid: float, half_s: float, half_width_km: float, n: int = 80) -> list[list[float]]:
    ts = [t_mid - half_s + 2 * half_s * i / (n - 1) for i in range(n)]
    pts = [_ground_point(el, t) for t in ts]
    lats = [p[0] for p in pts]
    lons = _unwrap([p[1] for p in pts])
    left, right = [], []
    for i in range(n):
        j0, j1 = max(i - 1, 0), min(i + 1, n - 1)
        dlat = lats[j1] - lats[j0]
        dlon = (lons[j1] - lons[j0]) * math.cos(math.radians(lats[i]))
        norm = math.hypot(dlat, dlon) or 1.0
        # unit normal in (lat, lon-scaled) space
        nlat, nlon = -dlon / norm, dlat / norm
        off_deg = math.degrees(half_width_km / EARTH_R_KM)
        coslat = max(math.cos(math.radians(lats[i])), 0.05)
        left.append([lons[i] + nlon * off_deg / coslat, lats[i] + nlat * off_deg])
        right.append([lons[i] - nlon * off_deg / coslat, lats[i] - nlat * off_deg])
    ring = left + right[::-1]
    ring.append(ring[0])
    return ring


@app.get("/health")
def health() -> dict:
    gpu, free_gb = _gpu_info()
    out = {"ok": True, "gpu": gpu, "free_mem_gb": free_gb, "use_gpu": USE_GPU, "phase": 2, "model": "sim-v1", "debris_model": "debris-v1"}
    cuda_ok = free_gb is not None
    out["debris_mode"] = "gpu" if cuda_ok else ("unavailable" if USE_GPU else "cpu_degraded")
    out["debris_available"] = cuda_ok or not USE_GPU
    if _engine is not None:
        out.update(n_per_object=_engine.n, horizon_days=_engine.horizon_s / 86400, particle_steps_total=_engine.particle_steps_total)
    return out


@app.post("/classify")
def classify(_body: ClassifyIn) -> dict:
    return {"label": "reentry", "confidence": 0.5, "reason": "stub classifier (phase 1): accepts everything"}


def _is_gp(el: dict) -> bool:
    return "MEAN_MOTION" in el and "EPOCH" in el


def _as_of(s: str | None):
    if not s:
        return None
    from sim import parse_time

    return parse_time(s)


@app.post("/forecast")
def forecast(body: ForecastIn) -> dict:
    t0 = time.perf_counter()
    eng = engine()
    before = eng.particle_steps_total
    with _engine_lock:
        results = eng.forecast([o.model_dump() for o in body.objects], body.space_weather, _as_of(body.as_of))
    return {
        "results": results,
        "ms": int((time.perf_counter() - t0) * 1000),
        "device": str(eng.device),
        "n_per_object": eng.n,
        "horizon_days": eng.horizon_s / 86400,
        "particle_steps": eng.particle_steps_total - before,
    }


@app.post("/debris")
def debris_route(body: DebrisIn) -> dict:
    import numpy as np

    import debris as dm

    t0 = time.perf_counter()
    eng = engine()
    cuda = eng.device.type == "cuda"
    if USE_GPU and not cuda:
        # a GPU-tier worker must not publish CPU results; USE_GPU=0 opts into degraded mode
        raise HTTPException(503, "debris needs CUDA; set USE_GPU=0 for the explicit CPU-degraded mode")
    degraded = (not cuda) if body.degraded is None else body.degraded
    n = body.n_particles or int(os.environ.get("DEBRIS_N") or (2000 if cuda and not degraded else 100))
    n = max(10, min(n, 20000))
    rng = np.random.default_rng(body.seed)
    materials = dm.normalize_materials(body.materials or dm.repo_materials())
    try:
        with _engine_lock:
            comps, _ = dm.prepare_components(body.archetype, body.profile, materials, False)  # validate; full body for drag
            if body.entry:
                entry = dm.entry_from_nominal(body.entry, n, rng)
                bc = np.full(n, dm.default_bc(comps, body.profile)) * np.exp(rng.normal(0, 0.2, n))
                info = {"source": "entry"}
            else:
                if not body.object.elements or not _is_gp(body.object.elements):
                    raise dm.DebrisInputError("object.elements (GP/OMM) or entry is required")
                entry, bc, info = dm.entry_from_forecast(
                    eng, body.object.model_dump(), body.space_weather, _as_of(body.as_of), n, rng
                )
            out = dm.run_debris(
                body.object.id, body.archetype, body.profile, materials, entry, bc, body.space_weather,
                eng.device, degraded=degraded, seed=body.seed,
            )
    except dm.DebrisInputError as e:
        raise HTTPException(422, str(e))
    out["entry"] = info
    out["tier"] = "gpu" if cuda else "cpu"
    out["ms"] = int((time.perf_counter() - t0) * 1000)
    return out


@app.post("/update")
def update(body: UpdateIn) -> dict:
    t0 = time.perf_counter()
    el = body.object.elements
    if _is_gp(el):
        if not body.object.id:
            raise HTTPException(400, "object.id required for GP elements")
        eng = engine()
        before = eng.particle_steps_total
        sightings = [s.model_dump() for s in body.sightings]
        with _engine_lock:
            out = eng.update(
                {"id": body.object.id, "elements": el}, sightings, body.space_weather, _as_of(body.as_of)
            )
        out["ms"] = int((time.perf_counter() - t0) * 1000)
        out["particle_steps"] = eng.particle_steps_total - before
        out["device"] = str(eng.device)
        return out
    if not body.object.window_start or not body.object.window_end:
        raise HTTPException(400, "stub objects need window_start/window_end")
    ws, we = _ts(body.object.window_start), _ts(body.object.window_end)
    k = len(body.sightings)

    # Centre: window midpoint with no sightings, else mean sighting time.
    t_mid = (ws + we) / 2 if k == 0 else sum(_ts(s.observed_at) for s in body.sightings) / k
    # Fixed shrink rule (stub): along-track and cross-track both narrow with k.
    half_s = 12 * 60 / (1 + 0.6 * k)  # +-12 min of track to start
    half_w90 = 400.0 / (1 + 0.35 * k)
    track_km_s = 7.8
    bands = [
        {"level": 90, "polygon": _band(el, t_mid, half_s, half_w90)},
        {"level": 50, "polygon": _band(el, t_mid, half_s * 0.5, half_w90 * 0.5)},
    ]
    area = (2 * half_s * track_km_s) * (2 * half_w90)
    ms = int((time.perf_counter() - t0) * 1000)
    # Stub inlier score: constant. Phase 2 returns each sighting's posterior
    # probability of being an inlier under the outlier mixture.
    scores = [{"id": s.id, "p_inlier": 0.9} for s in body.sightings if s.id is not None]
    return {"bands": bands, "area_km2_90": area, "n_samples": 0, "ess": 0.0, "ms": ms, "scores": scores, "stub": True}
