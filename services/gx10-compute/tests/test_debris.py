import json
import math
import unittest
from pathlib import Path

import numpy as np
import torch

import debris
import sim


class ConstantAtmosphere:
    def rho(self, altitude: torch.Tensor) -> torch.Tensor:
        return torch.full_like(altitude, 1e-12)


class DebrisModelTests(unittest.TestCase):
    def test_cuda_is_required_unless_degraded_mode_is_explicit(self) -> None:
        if torch.cuda.is_available():
            self.assertEqual(debris.resolve_device(True).type, "cuda")
        else:
            with self.assertRaisesRegex(RuntimeError, "requires CUDA"):
                debris.resolve_device(True)
        self.assertEqual(debris.resolve_device(False).type, "cpu")

    def test_profile_mass_adjusts_largest_archetype_component(self) -> None:
        archetype = {
            "components": [
                {"name": "bus", "material": "Al6061", "shape": "sphere", "mass_kg": 8, "dims_m": [1], "count": 1},
                {"name": "wheel", "material": "SS304", "shape": "sphere", "mass_kg": 1, "dims_m": [0.2], "count": 2},
            ]
        }

        components = debris.parse_components(archetype, {"mass_kg": 12})

        self.assertEqual(components[0].mass_kg, 10)
        self.assertAlmostEqual(components[0].dims_m[0], 1.0 * (10 / 8) ** (1 / 3))
        self.assertEqual(components[1].mass_kg, 1)

    def test_v0_rejects_unimplemented_shapes(self) -> None:
        archetype = {
            "components": [
                {"name": "panel", "material": "CFRP", "shape": "cone", "mass_kg": 2, "dims_m": [1, 1, 0.1]}
            ]
        }

        with self.assertRaisesRegex(ValueError, "unsupported v0 component shape"):
            debris.parse_components(archetype, {})

    def test_profile_mass_below_other_parts_keeps_archetype_masses(self) -> None:
        archetype = {
            "components": [
                {"name": "bus", "material": "Al6061", "shape": "sphere", "mass_kg": 8, "dims_m": [1], "count": 1},
                {"name": "wheel", "material": "SS304", "shape": "sphere", "mass_kg": 4, "dims_m": [0.2], "count": 1},
            ]
        }

        components = debris.parse_components(archetype, {"mass_kg": 3})

        self.assertEqual(components[0].mass_kg, 8)
        self.assertEqual(components[1].mass_kg, 4)

    def test_shipped_archetypes_parse(self) -> None:
        root = Path(__file__).resolve().parents[3] / "data" / "archetypes"
        files = sorted(root.glob("*.json"))
        self.assertGreaterEqual(len(files), 4)
        for path in files:
            arch = json.loads(path.read_text())
            components = debris.parse_components(arch, {})
            self.assertGreater(len(components), 0, path.name)

    def test_box_and_plate_take_a_step(self) -> None:
        radius_km = sim.RE + 80
        speed_km_s = math.sqrt(sim.MU / radius_km)
        for shape, dims in (("box", (0.4, 0.3, 0.2)), ("plate", (1.0, 0.5, 0.02))):
            result = debris.simulate_component(
                debris.Component("part", "Al6061", shape, 1.0, dims, 1),
                np.array([[radius_km, 0.0, 0.0]]),
                np.array([[0.0, speed_km_s, 0.0]]),
                np.array([1_800_000_000.0]),
                ConstantAtmosphere(),
                torch.device("cpu"),
                track_index=0,
                dt=0.5,
                max_flight_s=1.0,
            )
            self.assertEqual(result["steps"], 2, shape)

    def test_component_simulation_returns_bounded_track(self) -> None:
        component = debris.Component("test sphere", "Ti6Al4V", "sphere", 2, (0.2,), 1)
        radius_km = sim.RE + 80
        speed_km_s = math.sqrt(sim.MU / radius_km)

        result = debris.simulate_component(
            component,
            np.array([[radius_km, 0.0, 0.0]]),
            np.array([[0.0, speed_km_s, 0.0]]),
            np.array([1_800_000_000.0]),
            ConstantAtmosphere(),
            torch.device("cpu"),
            track_index=0,
            dt=0.5,
            max_flight_s=1.0,
        )

        self.assertEqual(result["steps"], 2)
        self.assertLessEqual(len(result["track"]), debris.TRACK_POINTS)
        self.assertTrue(all(len(point) == 4 for point in result["track"]))
        self.assertLess(result["track"][0][0], result["track"][-1][0])
        self.assertEqual(result["survived"].shape, (1,))

    def test_documented_sphere_demise_and_titanium_survival_cases(self) -> None:
        altitudes = np.arange(0.0, 1201.0, 1.0)
        atmosphere = sim.Atmosphere(
            sim._exponential_fallback(altitudes), torch.device("cpu"), torch.float32
        )
        radius_km = sim.RE + 80.0
        r = np.array([[radius_km, 0.0, 0.0]])
        v = np.array([[-0.1, 7.8, 0.0]])
        epoch = np.array([1_800_000_000.0])

        aluminum = debris.simulate_component(
            debris.Component("aluminum sphere", "Al6061", "sphere", 1.0, (0.089,), 1),
            r,
            v,
            epoch,
            atmosphere,
            torch.device("cpu"),
            track_index=0,
        )
        titanium = debris.simulate_component(
            debris.Component("titanium tank", "Ti6Al4V", "sphere", 4.0, (0.30,), 1),
            r,
            v,
            epoch,
            atmosphere,
            torch.device("cpu"),
            track_index=0,
        )

        self.assertFalse(aluminum["survived"][0])
        self.assertLess(aluminum["mass"][0], 0.01)
        self.assertTrue(titanium["survived"][0])
        self.assertGreater(titanium["speed"][0], 0)

    def test_prediction_returns_modeled_estimate_shape(self) -> None:
        altitudes = np.arange(0.0, 1201.0, 1.0)
        atmosphere = sim.Atmosphere(
            sim._exponential_fallback(altitudes), torch.device("cpu"), torch.float32
        )
        radius_km = sim.RE + 80.0
        speed_km_s = math.sqrt(sim.MU / radius_km)
        result = debris.predict_debris(
            object_id="test-object",
            profile={},
            archetype={
                "id": "test",
                "name": "Test archetype",
                "confidence": "low",
                "sources": ["assumed"],
                "components": [
                    {
                        "name": "aluminum sphere",
                        "material": "Al6061",
                        "shape": "sphere",
                        "mass_kg": 1,
                        "dims_m": [0.089],
                    }
                ],
            },
            r_reentry=np.array([[radius_km, 0.0, 0.0]]),
            v_reentry=np.array([[-0.1, speed_km_s, 0.0]]),
            t_reentry=np.array([1_800_000_000.0]),
            atmosphere=atmosphere,
            device=torch.device("cpu"),
            n_particles=1,
            seed=7,
        )

        self.assertEqual(result["id"], "test-object")
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["n_particles"], 1)
        self.assertIn("Modeled estimate", result["note"])
        component = result["components"][0]
        self.assertEqual(component["p_survive"], 0.0)
        self.assertEqual(component["mass_kg"]["start"], 1)
        self.assertIsNone(component["impact"])
        self.assertIsInstance(component["demise_alt_km"]["mean"], float)
        self.assertEqual(set(result["breakup"]), {"t_unix_s", "lat", "lon", "alt_km"})
        self.assertGreater(result["breakup"]["alt_km"], 70)


if __name__ == "__main__":
    unittest.main()
