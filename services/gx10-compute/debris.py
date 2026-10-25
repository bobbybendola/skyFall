"""GPU-batched, simplified component survival estimates for re-entering objects."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np
import torch

import sim


class AtmosphereModel(Protocol):
    def rho(self, altitude: torch.Tensor) -> torch.Tensor: ...


SIGMA_SB = 5.670374419e-8
SUTTON_GRAVES = 1.7415e-4
HEATING_AREA_FACTOR = 0.15
EARTH_OMEGA = 7.292115e-5
MAX_FLIGHT_S = 1800.0
GPU_DT_S = 0.5
TRACK_POINTS = 60


def resolve_device(use_gpu: bool) -> torch.device:
    if use_gpu and not torch.cuda.is_available():
        raise RuntimeError("debris prediction requires CUDA; set USE_GPU=0 only for explicit degraded mode")
    return torch.device("cuda" if use_gpu else "cpu")


MATERIALS = {
    "Al6061": {"density": 2700.0, "melt": 867.0, "cp": 896.0, "fusion": 3.9e5, "emissivity": 0.3},
    "Ti6Al4V": {"density": 4430.0, "melt": 1943.0, "cp": 560.0, "fusion": 3.6e5, "emissivity": 0.3},
    "SS304": {"density": 8000.0, "melt": 1700.0, "cp": 500.0, "fusion": 2.7e5, "emissivity": 0.35},
    "CFRP": {"density": 1600.0, "melt": 600.0, "cp": 1100.0, "fusion": 2.0e5, "emissivity": 0.85},
    "Glass": {"density": 2500.0, "melt": 1400.0, "cp": 800.0, "fusion": 1.4e5, "emissivity": 0.8},
    "Copper": {"density": 8960.0, "melt": 1356.0, "cp": 385.0, "fusion": 2.05e5, "emissivity": 0.3},
    # Inconel 718 (rocket engine parts): textbook values, CHECK before quoting
    "Inconel": {"density": 8190.0, "melt": 1609.0, "cp": 435.0, "fusion": 2.7e5, "emissivity": 0.3},
}
# Cd from docs/DEBRIS_MODEL.md §4 (check). Box and plate are the shapes in data/archetypes.
DRAG_COEFFICIENT = {"sphere": 0.92, "cylinder": 1.0, "box": 1.1, "plate": 1.2}


@dataclass(frozen=True)
class Component:
    name: str
    material: str
    shape: str
    mass_kg: float
    dims_m: tuple[float, ...]
    count: int


def parse_components(archetype: dict, profile: dict) -> list[Component]:
    raw_components = archetype.get("components")
    if not isinstance(raw_components, list) or not raw_components:
        raise ValueError("archetype.components must be a non-empty list")

    components = []
    for raw in raw_components:
        if not isinstance(raw, dict):
            raise ValueError("every archetype component must be an object")
        shape = str(raw.get("shape", "")).lower()
        material = str(raw.get("material", ""))
        try:
            dims = tuple(float(value) for value in raw.get("dims_m", []))
            mass = float(raw.get("mass_kg", 0))
            raw_count = float(raw.get("count", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("component dimensions, mass_kg and count must be numeric") from exc
        expected_dims = {"sphere": 1, "cylinder": 2, "box": 3, "plate": 3}.get(shape)
        if expected_dims is None:
            raise ValueError(f"unsupported v0 component shape: {shape}")
        if len(dims) != expected_dims or any(not math.isfinite(value) or value <= 0 for value in dims):
            raise ValueError(f"{shape} dims_m must contain {expected_dims} positive values")
        invalid_count = not math.isfinite(raw_count) or raw_count < 1 or not raw_count.is_integer()
        if not math.isfinite(mass) or mass <= 0 or invalid_count:
            raise ValueError("component mass_kg and count must be positive")
        count = int(raw_count)
        if material not in MATERIALS:
            raise ValueError(f"unsupported v0 material: {material}")
        components.append(Component(str(raw.get("name", shape)), material, shape, mass, dims, count))

    target_mass = profile.get("mass_kg")
    if target_mass is not None:
        try:
            target_mass = float(target_mass)
        except (TypeError, ValueError) as exc:
            raise ValueError("profile mass_kg must be numeric") from exc
        total_mass = sum(c.mass_kg * c.count for c in components)
        structure_index = max(range(len(components)), key=lambda i: components[i].mass_kg)
        structure = components[structure_index]
        adjusted = structure.mass_kg + (target_mass - total_mass) / structure.count
        # A catalog mass below the other parts cannot be absorbed by the structure.
        # Keep the documented archetype masses so the debris job still publishes.
        if not math.isfinite(target_mass) or target_mass <= 0 or adjusted <= 0:
            return components
        scale = (adjusted / structure.mass_kg) ** (1.0 / 3.0)
        components[structure_index] = Component(
            structure.name,
            structure.material,
            structure.shape,
            adjusted,
            tuple(dim * scale for dim in structure.dims_m),
            structure.count,
        )
    return components


def _geometry(component: Component) -> tuple[float, float, float]:
    if component.shape == "sphere":
        radius = component.dims_m[0] / 2
        return math.pi * radius**2, 4 * math.pi * radius**2, radius
    if component.shape == "cylinder":
        length, diameter = component.dims_m
        radius = diameter / 2
        projected_area = 0.5 * math.pi * radius * (radius + length)
        surface_area = math.pi * diameter * length + 2 * math.pi * radius**2
        return projected_area, surface_area, radius
    # Box [l, w, h] and plate [l, w, t]. Mean projected area of a convex body is
    # surface/4. Nose radius is half the smallest edge (thinner plates heat faster).
    a, b, c = component.dims_m
    surface_area = 2.0 * (a * b + a * c + b * c)
    return surface_area / 4.0, surface_area, max(0.5 * min(a, b, c), 0.001)


def _relative_velocity(r: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    return torch.stack(
        (
            v[:, 0] * 1000 + EARTH_OMEGA * r[:, 1] * 1000,
            v[:, 1] * 1000 - EARTH_OMEGA * r[:, 0] * 1000,
            v[:, 2] * 1000,
        ),
        dim=1,
    )


def _bands(lat: np.ndarray, lon: np.ndarray, weights: np.ndarray) -> tuple[list[dict], float]:
    if not len(lat):
        return [], 0.0
    return sim.corridor_bands(lat, lon, weights)


def _mean_or_none(values: np.ndarray) -> float | None:
    if len(values) == 0:
        return None
    return float(values.mean())


def _impact_point(lat: np.ndarray, lon: np.ndarray) -> dict | None:
    """Centre the globe draws a line to. publish_debris stores impact.lat / impact.lon."""
    if len(lat) == 0:
        return None
    return {"lat": float(np.median(lat)), "lon": float(np.median(lon))}


def _breakup_point(r_km: np.ndarray, t_unix: np.ndarray, index: int) -> dict:
    """80 km state of one forecast particle. The globe refuses to draw lines without this."""
    r = torch.as_tensor(r_km[index : index + 1], dtype=torch.float64)
    t = torch.as_tensor(t_unix[index : index + 1], dtype=torch.float64)
    lat, lon = sim.eci_to_latlon(r, t)
    alt = float(np.linalg.norm(r_km[index]) - sim.RE)
    return {
        "t_unix_s": float(t_unix[index]),
        "lat": float(lat[0].item()),
        "lon": float(lon[0].item()),
        "alt_km": round(alt, 2),
    }


def simulate_component(
    component: Component,
    r0_np: np.ndarray,
    v0_np: np.ndarray,
    t0_np: np.ndarray,
    atmosphere: AtmosphereModel,
    device: torch.device,
    track_index: int,
    dt: float = GPU_DT_S,
    max_flight_s: float = MAX_FLIGHT_S,
) -> dict:
    dtype = torch.float32
    r = torch.as_tensor(r0_np, device=device, dtype=dtype).clone()
    v = torch.as_tensor(v0_np, device=device, dtype=dtype).clone()
    t0 = torch.as_tensor(t0_np, device=device, dtype=torch.float64)
    n = r.shape[0]
    material = MATERIALS[component.material]
    projected_area, surface_area, nose_radius = _geometry(component)
    cd = DRAG_COEFFICIENT[component.shape]
    mass0 = torch.full((n,), component.mass_kg, device=device, dtype=dtype)
    mass = mass0.clone()
    temp = torch.full_like(mass, 300.0)
    max_temp = temp.clone()
    max_heat_flux = torch.zeros_like(mass)
    demise_alt = torch.full_like(mass, float("nan"))
    impact_r = torch.full((n, 3), float("nan"), device=device, dtype=dtype)
    impact_v = torch.full_like(impact_r, float("nan"))
    impact_t = torch.full((n,), float("nan"), device=device, dtype=torch.float64)
    active = torch.ones((n,), device=device, dtype=torch.bool)
    last_alt = sim.altitude(r)
    sample_index = min(max(track_index, 0), n - 1)
    track: list[list[float]] = []
    sample_time = t0[sample_index : sample_index + 1]
    sample_lat, sample_lon = sim.eci_to_latlon(r[sample_index : sample_index + 1], sample_time)
    track.append(
        [
            float(sample_time[0].item()),
            float(sample_lat[0].item()),
            float(sample_lon[0].item()),
            float(last_alt[sample_index].item()),
        ]
    )
    track_active = True
    stride = max(1, int(math.ceil(max_flight_s / dt / (TRACK_POINTS - 1))))
    steps = int(math.ceil(max_flight_s / dt))

    for step in range(steps):
        alt = sim.altitude(r)
        area_scale = (mass / mass0).clamp_min(0).pow(2.0 / 3.0)
        bc = cd * projected_area * area_scale / mass.clamp_min(0.01)
        bc = torch.where(active, bc, torch.zeros_like(bc))
        k1v = sim.accel(r, v, bc, atmosphere)
        k1r = v
        k2v = sim.accel(r + 0.5 * dt * k1r, v + 0.5 * dt * k1v, bc, atmosphere)
        k2r = v + 0.5 * dt * k1v
        k3v = sim.accel(r + 0.5 * dt * k2r, v + 0.5 * dt * k2v, bc, atmosphere)
        k3r = v + 0.5 * dt * k2v
        k4v = sim.accel(r + dt * k3r, v + dt * k3v, bc, atmosphere)
        k4r = v + dt * k3v
        r_next = r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r)
        v_next = v + (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
        r_next = torch.where(active[:, None], r_next, r)
        v_next = torch.where(active[:, None], v_next, v)

        rho = atmosphere.rho(alt)
        rel_v = _relative_velocity(r, v)
        speed_ms = torch.linalg.vector_norm(rel_v, dim=1)
        scaled_nose = max(nose_radius, 0.005) * area_scale.sqrt()
        q = SUTTON_GRAVES * torch.sqrt(rho.clamp_min(0) / scaled_nose.clamp_min(0.005)) * speed_ms**3
        max_heat_flux = torch.maximum(max_heat_flux, q)
        heat_area = surface_area * area_scale * HEATING_AREA_FACTOR
        radiating_area = surface_area * area_scale
        net_power = q * heat_area - material["emissivity"] * SIGMA_SB * temp**4 * radiating_area
        energy = net_power * dt
        sensible_to_melt = mass * material["cp"] * (material["melt"] - temp).clamp_min(0)
        latent_energy = torch.where(
            temp < material["melt"],
            (energy - sensible_to_melt).clamp_min(0),
            energy.clamp_min(0),
        )
        temp_next = torch.where(
            temp < material["melt"],
            (temp + energy / (mass.clamp_min(0.01) * material["cp"])).clamp(min=100.0, max=material["melt"]),
            torch.full_like(temp, material["melt"]),
        )
        mass_next = (mass - latent_energy / material["fusion"]).clamp_min(0)
        mass_next = torch.where(active, mass_next, mass)
        max_temp = torch.maximum(max_temp, temp_next)

        alt_next = sim.altitude(r_next)
        demise_now = active & (mass_next < torch.maximum(mass0 * 0.01, torch.full_like(mass0, 0.01)))
        demise_alt = torch.where(demise_now, alt_next, demise_alt)
        impact_now = active & (alt_next <= 0) & (mass_next >= torch.maximum(mass0 * 0.01, torch.full_like(mass0, 0.01)))
        fraction = (last_alt[impact_now] / (last_alt[impact_now] - alt_next[impact_now]).clamp_min(1e-6)).clamp(0, 1)
        impact_r[impact_now] = r[impact_now] + fraction[:, None] * (r_next[impact_now] - r[impact_now])
        impact_v[impact_now] = v[impact_now] + fraction[:, None] * (v_next[impact_now] - v[impact_now])
        impact_t[impact_now] = t0[impact_now] + (step + fraction.double()) * dt
        active = active & (alt_next > 0) & ~demise_now
        r, v, mass, temp, last_alt = r_next, v_next, mass_next, temp_next, alt_next

        sample_terminal = bool((demise_now | impact_now)[sample_index])
        if track_active and (step % stride == 0 or sample_terminal or step == steps - 1):
            point_r = r[sample_index : sample_index + 1]
            point_t = t0[sample_index : sample_index + 1] + (step + 1) * dt
            track_lat, track_lon = sim.eci_to_latlon(point_r, point_t)
            track.append(
                [
                    float(point_t[0].item()),
                    float(track_lat[0].item()),
                    float(track_lon[0].item()),
                    float(alt_next[sample_index].item()),
                ]
            )
        if sample_terminal:
            track_active = False
        if step % 25 == 0 and not bool(active.any()):
            break

    survived = torch.isfinite(impact_t)
    ground_rotation = torch.stack(
        (-EARTH_OMEGA * impact_r[:, 1] * 1000, EARTH_OMEGA * impact_r[:, 0] * 1000, torch.zeros_like(impact_t)),
        dim=1,
    )
    impact_speed = torch.linalg.vector_norm(impact_v * 1000 - ground_rotation, dim=1)
    impact_energy = 0.5 * mass * impact_speed**2
    impact_lat = torch.full_like(impact_t, float("nan"), dtype=dtype)
    impact_lon = torch.full_like(impact_t, float("nan"), dtype=dtype)
    if bool(survived.any()):
        impact_lat[survived], impact_lon[survived] = sim.eci_to_latlon(impact_r[survived], impact_t[survived])

    return {
        "survived": survived.cpu().numpy(),
        "unresolved": active.cpu().numpy(),
        "mass": mass.cpu().numpy(),
        "impact_time": impact_t.cpu().numpy(),
        "max_temp": max_temp.cpu().numpy(),
        "max_heat_flux": max_heat_flux.cpu().numpy(),
        "speed": impact_speed.cpu().numpy(),
        "energy": impact_energy.cpu().numpy(),
        "demise_alt": demise_alt.cpu().numpy(),
        "lat": impact_lat.cpu().numpy(),
        "lon": impact_lon.cpu().numpy(),
        "track": track,
        "steps": min(steps, step + 1),
    }


def predict_debris(
    object_id: str,
    profile: dict,
    archetype: dict,
    r_reentry: np.ndarray,
    v_reentry: np.ndarray,
    t_reentry: np.ndarray,
    atmosphere: AtmosphereModel,
    device: torch.device,
    n_particles: int,
    seed: int | None = None,
    dt: float = GPU_DT_S,
    max_components: int | None = None,
) -> dict:
    components = parse_components(archetype, profile)
    if max_components is not None and len(components) > max_components:
        keep = set(
            sorted(range(len(components)), key=lambda i: components[i].mass_kg * components[i].count, reverse=True)[
                :max_components
            ]
        )
        components = [component for i, component in enumerate(components) if i in keep]
    n_available = len(t_reentry)
    if n_available == 0:
        raise ValueError("forecast has no particles crossing the 80 km re-entry boundary")
    n = min(n_particles, n_available)
    if n < n_particles:
        indices = np.arange(n_available)
    else:
        indices = np.random.default_rng(seed).choice(n_available, size=n, replace=False)
    r_samples, v_samples, t_samples = r_reentry[indices], v_reentry[indices], t_reentry[indices]
    track_index = n // 2
    outputs = []
    particle_steps = 0

    for component in components:
        output = simulate_component(
            component, r_samples, v_samples, t_samples, atmosphere, device, track_index, dt=dt
        )
        particle_steps += output["steps"] * n
        output["spec"] = component
        outputs.append(output)

    any_survives = np.zeros(n, dtype=bool)
    any_unresolved = np.zeros(n, dtype=bool)
    total_surviving_mass = np.zeros(n, dtype=np.float64)
    all_lat, all_lon, all_weights = [], [], []
    component_results = []
    sample_tracks = []
    for output in outputs:
        component = output["spec"]
        survived = output["survived"]
        any_survives |= survived
        any_unresolved |= output["unresolved"]
        total_surviving_mass += np.where(survived, output["mass"] * component.count, 0)
        mass_values = output["mass"][survived]
        speed_values = output["speed"][survived]
        energy_values = output["energy"][survived]
        impact_times = output["impact_time"][survived]
        lat_values = output["lat"][survived]
        lon_values = output["lon"][survived]
        bands, area = _bands(lat_values, lon_values, np.ones(len(lat_values), dtype=np.float64))
        projected_area, _, _ = _geometry(component)
        piece_areas = projected_area * (mass_values / component.mass_kg) ** (2.0 / 3.0)
        casualty_area = (0.6 + np.sqrt(piece_areas)) ** 2
        p_survive = float(survived.mean())
        demise_values = output["demise_alt"][np.isfinite(output["demise_alt"])]
        impact = _impact_point(lat_values, lon_values)
        demise_mean = float(demise_values.mean()) if len(demise_values) else None
        component_results.append(
            {
                "name": component.name,
                "material": component.material,
                "shape": component.shape,
                "count": component.count,
                "mass_kg_start": component.mass_kg,
                "p_survive": p_survive,
                "p_unresolved": float(output["unresolved"].mean()),
                # mass_kg.start / demise_alt_km.mean / impact are what publish_debris stores.
                "mass_kg": {
                    "start": component.mass_kg,
                    "mean": float(mass_values.mean()) if len(mass_values) else 0.0,
                },
                "max_temperature_k_mean": float(output["max_temp"].mean()),
                "max_heat_flux_w_m2_max": float(output["max_heat_flux"].max()),
                "impact_speed_ms": {"mean": _mean_or_none(speed_values)},
                "impact_energy_j": {"mean": _mean_or_none(energy_values)},
                "impact_time_unix": {
                    "q05": float(np.percentile(impact_times, 5)) if len(impact_times) else None,
                    "q50": float(np.percentile(impact_times, 50)) if len(impact_times) else None,
                    "q95": float(np.percentile(impact_times, 95)) if len(impact_times) else None,
                },
                "demise_alt_km": {"mean": demise_mean},
                "demise_alt_km_mean": demise_mean,
                "impact": impact,
                "casualty_area_m2_mean": float(casualty_area.sum()) * component.count / n,
                "footprint": {
                    "bands": bands,
                    "area_km2_90": area,
                    "center": None if impact is None else [impact["lon"], impact["lat"]],
                },
            }
        )
        if len(lat_values):
            all_lat.extend(lat_values.tolist())
            all_lon.extend(lon_values.tolist())
            all_weights.extend([component.count] * len(lat_values))
        if output["track"]:
            sample_tracks.append(
                {
                    "component": component.name,
                    "survived": bool(survived[track_index]),
                    "points": output["track"],
                }
            )

    all_lat_np = np.asarray(all_lat, dtype=np.float64)
    all_lon_np = np.asarray(all_lon, dtype=np.float64)
    weights_np = np.asarray(all_weights, dtype=np.float64)
    footprint_bands, area90 = _bands(all_lat_np, all_lon_np, weights_np)
    surviving = total_surviving_mass[total_surviving_mass > 0]
    return {
        "id": object_id,
        "archetype": archetype.get("id", ""),
        "archetype_name": archetype.get("name", ""),
        "archetype_confidence": archetype.get("confidence", "low"),
        "archetype_sources": archetype.get("sources", []),
        "n_particles": n,
        "breakup": _breakup_point(r_samples, t_samples, track_index),
        "device": (
            str(torch.device(f"cuda:{torch.cuda.current_device()}"))
            if device.type == "cuda"
            else str(device)
        ),
        "gpu_name": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "p_any_survives": float(any_survives.mean()),
        "p_any_unresolved": float(any_unresolved.mean()),
        "surviving_mass_kg": {
            "mean": float(surviving.mean()) if len(surviving) else 0.0,
            "p95": float(np.percentile(surviving, 95)) if len(surviving) else 0.0,
        },
        "casualty_area_m2": {"mean": sum(result["casualty_area_m2_mean"] for result in component_results)},
        "components": component_results,
        "footprint": {"bands": footprint_bands, "area_km2_90": area90},
        "sample_tracks": sample_tracks[:TRACK_POINTS],
        "particle_steps": particle_steps,
        "max_flight_s": MAX_FLIGHT_S,
        "model": "simplified lumped-mass estimate",
        "note": (
            "Modeled estimate; generic archetype, 80 km breakup, simplified heating and tumbling assumptions. "
            "Repeated copies share the same sampled trajectory in v0."
        ),
    }
