"""gx10-compute: plain HTTP in, JSON out. Never talks to SpacetimeDB.

PHASE 1 STUB. /update does not run the Monte Carlo yet (see docs/SIM_SPEC.md).
It draws a corridor along a simple circular-orbit ground track and shrinks it
by a fixed rule as sightings arrive, so the end-to-end pipeline can be tested.
/classify is a stub that accepts everything.
"""

from __future__ import annotations

import math
import os
import time
from datetime import datetime

from fastapi import FastAPI
from pydantic import BaseModel

USE_GPU = os.environ.get("USE_GPU", "1") == "1"
EARTH_R_KM = 6371.0
EARTH_ROT_DEG_S = 360.0 / 86164.0

app = FastAPI(title="gx10-compute (phase 1 stub)")


class ObjectIn(BaseModel):
    elements: dict
    window_start: str  # ISO 8601
    window_end: str


class SightingIn(BaseModel):
    lat: float
    lon: float
    observed_at: str
    bearing_deg: float | None = None


class UpdateIn(BaseModel):
    object: ObjectIn
    sightings: list[SightingIn] = []


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
    return {"ok": True, "gpu": gpu, "free_mem_gb": free_gb, "model": "stub", "use_gpu": USE_GPU, "phase": 1}


@app.post("/classify")
def classify(_body: ClassifyIn) -> dict:
    return {"label": "reentry", "confidence": 0.5, "reason": "stub classifier (phase 1): accepts everything"}


@app.post("/update")
def update(body: UpdateIn) -> dict:
    t0 = time.perf_counter()
    el = body.object.elements
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
    return {"bands": bands, "area_km2_90": area, "n_samples": 0, "ess": 0.0, "ms": ms, "stub": True}
