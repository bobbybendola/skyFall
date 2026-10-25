"""Time one batched forecast from the current engine.

The clock starts at Engine.forecast and includes drag calibration, the RK4
batch, and corridor extraction. It does not include process startup.
Atmosphere falls back to the static exponential table when pymsis is absent;
that table is built once per call, then every step is a lookup.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone

import torch

from sim import Engine


def load_objects(path: str, limit: int) -> list[dict]:
    raw = json.load(open(path))
    if isinstance(raw, dict):
        raw = [raw]
    objects = []
    for gp in raw[:limit]:
        norad = gp.get("NORAD_CAT_ID")
        objects.append({"id": f"CT-{norad}", "elements": gp})
    return objects


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--elements", required=True)
    parser.add_argument("--objects", type=int, default=8)
    parser.add_argument("--particles", type=int, default=300)
    parser.add_argument("--horizon-days", type=float, default=3.0)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    objects = load_objects(args.elements, args.objects)
    engine = Engine(torch.device("cpu"), args.particles, args.horizon_days)
    weather = {"kp": 0.67, "f107": 93.0}
    runs = []
    for _ in range(args.repeat):
        engine.particle_steps_total = 0
        started = time.perf_counter()
        results = engine.forecast(objects, weather, datetime.now(timezone.utc))
        wall_s = time.perf_counter() - started
        steps = engine.particle_steps_total
        ok = sum(1 for row in results if row.get("status") == "ok")
        runs.append(
            {
                "wall_s": round(wall_s, 3),
                "batch_ms": results[0].get("batch_ms") if results else None,
                "particle_steps": steps,
                "steps_per_s": round(steps / wall_s) if wall_s else None,
                "ok": ok,
                "other": len(results) - ok,
            }
        )
    print(
        json.dumps(
            {
                "engine": "sim.Engine current customization",
                "device": "cpu",
                "dtype": "float32",
                "dt_s": engine.dt,
                "objects": len(objects),
                "particles_per_object": args.particles,
                "horizon_days": args.horizon_days,
                "runs": runs,
            }
        )
    )


if __name__ == "__main__":
    main()
