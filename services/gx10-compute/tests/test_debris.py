"""Unit checks for the debris model (docs/DEBRIS_MODEL.md section 8).

Run from services/gx10-compute:  python -m pytest -q tests
All results here are modeled estimates from test fixtures, not real satellites.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import debris as dm  # noqa: E402
import sim  # noqa: E402

DEV = torch.device('cpu')
MATS = dm.normalize_materials(None)
ENTRY = {'t': '2026-10-25T12:00:00Z', 'lat': 10.0, 'lon': -40.0, 'alt_km': 80.0, 'speed_kms': 7.3, 'flight_path_deg': -0.9, 'heading_deg': 60.0}


def one(name, material, shape, mass, dims, count=1, parent=None):
    c = {'name': name, 'material': material, 'shape': shape, 'mass_kg': mass, 'dims_m': dims, 'count': count}
    if parent:
        c['parent'] = parent
    return c


def run(components, n=60, entry=ENTRY, profile=None, seed=1, degraded=False):
    arche = {'id': 'unit', 'components': components}
    comps, _ = dm.prepare_components(arche, profile, MATS, degraded)
    rng = np.random.default_rng(seed)
    e = dm.entry_from_nominal(entry, n, rng)
    bc = np.full(n, dm.default_bc(comps, profile))
    return dm.run_debris('UNIT', arche, profile, MATS, e, bc, None, DEV, degraded=degraded, seed=seed)


def comp(out, name):
    return next(c for c in out['components'] if c['name'] == name)


def test_aluminium_sphere_demises():
    out = run([one('al ball', 'Al6061', 'sphere', 1.0, [((6 * 1.0) / (math.pi * 2700)) ** (1 / 3)])])
    c = comp(out, 'al ball')
    assert c['p_survive'] < 0.05, c
    assert 40 < c['demise_alt_km']['mean'] < 80, c


def test_titanium_tank_survives():
    out = run([one('ti tank', 'Ti6Al4V', 'sphere', 4.0, [0.30])])
    assert comp(out, 'ti tank')['p_survive'] > 0.8


WHEEL = ('wheel', 'SS304', 'cylinder', 3.0, [0.10, 0.25])  # disc: 0.10 m long, 0.25 m diameter


def test_steel_wheel_survives_at_terminal_speed():
    out = run([one(*WHEEL)])
    c = comp(out, 'wheel')
    assert c['p_survive'] > 0.8
    # dense small parts hit at terminal velocity: tens of m/s, not km/s
    assert 20 < c['impact_speed_ms']['mean'] < 200, c
    assert c['mass_kg']['mean'] > 0.5


def test_nominal_entry_starts_at_requested_altitude():
    rng = np.random.default_rng(0)
    for lat in (0.0, 28.0, -60.0, 85.0):
        r, v, t = dm.entry_from_nominal({**ENTRY, 'lat': lat}, 5, rng)
        h = sim.altitude(torch.tensor(r)).numpy()
        la, _ = sim.eci_to_latlon(torch.tensor(r), torch.tensor(t))
        assert np.all(np.abs(h - 80.0) < 0.05), (lat, h)
        assert np.all(np.abs(la.numpy() - lat) < 0.05), (lat, la)


def test_flight_ends_on_ground_downrange():
    out = run([one(*WHEEL)], n=20)
    tr = [t for t in out['sample_tracks'] if t['survived']]
    assert tr, out['sample_tracks']
    pts = tr[0]['points']
    assert len(pts) <= 60
    assert abs(pts[0][3] - 80) < 1.0 and pts[-1][3] == 0.0
    assert all(b[0] >= a[0] for a, b in zip(pts, pts[1:]))  # time increases
    # lands hundreds to ~2,000 km downrange of the 80 km point
    d = sim._great_circle_km(np.array([pts[0][1]]), np.array([pts[0][2]]), pts[-1][1], pts[-1][2])[0]
    assert 200 < d < 2500, d


def test_children_released_after_parent_and_shielded():
    # A big aluminium bus carrying a small aluminium part: the part would demise on
    # its own, but it rides inside until the bus breaks up or melts.
    alone = run([one('part', 'Al6061', 'sphere', 0.5, [0.07])])
    inside = run([one('bus structure', 'Al6061', 'box', 300, [2, 1.5, 1.5]), one('part', 'Al6061', 'sphere', 0.5, [0.07], parent='bus structure')])
    assert comp(inside, 'part')['demise_alt_km']['mean'] < comp(alone, 'part')['demise_alt_km']['mean']


def test_fixture_archetype_and_profile_scaling():
    arche = json.loads((HERE / 'fixtures' / 'test-flatpanel.json').read_text())
    out = run(arche['components'], n=50, profile={'mass_kg': 300})
    assert out['label'] == 'modeled estimate'
    names = {c['name'] for c in out['components']}
    assert names == {'bus structure', 'solar array', 'reaction wheel', 'propellant tank'}
    bus = comp(out, 'bus structure')
    assert bus['mass_kg_start'] > 120  # absorbed the 300 kg catalog mass
    assert any('catalog mass' in w for w in out['warnings'])
    assert 0 <= out['p_any_survives'] <= 1
    assert comp(out, 'propellant tank')['p_survive'] > 0.5  # titanium tank inside the bus
    if out['p_any_survives'] > 0.2:
        assert out['footprint']['bands'] and out['footprint']['area_km2_90'] > 0
        assert out['casualty_area_m2']['mean'] > 0


def test_degraded_keeps_structure_and_two_heaviest():
    arche = json.loads((HERE / 'fixtures' / 'test-flatpanel.json').read_text())
    out = run(arche['components'], n=20, degraded=True)
    assert out['degraded'] is True
    assert [c['name'] for c in out['components']] == ['bus structure', 'solar array', 'reaction wheel']


def test_bad_archetype_rejected():
    with pytest.raises(dm.DebrisInputError):
        run([one('x', 'Unobtainium', 'sphere', 1, [0.1])])
    with pytest.raises(dm.DebrisInputError):
        run([one('x', 'Al6061', 'cylinder', 1, [0.1])])


def test_footprint_bands_cross_antimeridian():
    rng = np.random.default_rng(0)
    lat = rng.normal(-20, 0.3, 500)
    lon = rng.normal(179.8, 0.5, 500)
    lon = (lon + 180) % 360 - 180
    bands, area = dm.footprint_bands(lat, lon)
    assert bands and area > 0
    ring = bands[0]['polygon']
    lons = [p[0] for p in ring]
    assert max(lons) - min(lons) < 20  # one continuous ring, not split across the globe


# ------------------------------------------------------------------ forecast -> 80 km state


def _decaying_gp(epoch: datetime) -> dict:
    return {
        'OBJECT_NAME': 'TEST DECAYER', 'OBJECT_ID': '2026-999A', 'NORAD_CAT_ID': 99999,
        'EPOCH': epoch.strftime('%Y-%m-%dT%H:%M:%S.%f'), 'MEAN_MOTION': 16.30, 'ECCENTRICITY': 0.0005,
        'INCLINATION': 51.6, 'RA_OF_ASC_NODE': 100.0, 'ARG_OF_PERICENTER': 90.0, 'MEAN_ANOMALY': 10.0,
        'BSTAR': 0.0008, 'MEAN_MOTION_DOT': 0.02, 'MEAN_MOTION_DDOT': 0,
    }


def test_forecast_keeps_state_at_80km_and_feeds_debris():
    now = datetime(2026, 10, 25, 0, 0, tzinfo=timezone.utc)
    eng = sim.Engine(DEV, n_per_object=40, horizon_days=3)
    obj = {'id': 'TEST-99999', 'elements': _decaying_gp(now - timedelta(hours=6))}
    res = eng.forecast([obj], {'kp': 2, 'f107': 150}, now)
    assert res[0]['status'] == 'ok' and res[0]['decayed_frac'] > 0.5, res[0]
    st = eng.cache['TEST-99999']
    ok = np.isfinite(st.t_re)
    r = torch.tensor(st.r_re[ok])
    h = sim.altitude(r).numpy()
    assert np.all(np.abs(h - 80.0) < 0.5), h
    spd = np.linalg.norm(st.v_re[ok], axis=1)
    assert np.all((spd > 7.0) & (spd < 8.2)), spd

    rng = np.random.default_rng(0)
    entry, bc, info = dm.entry_from_forecast(eng, obj, {'kp': 2, 'f107': 150}, now, 30, rng)
    assert info['reused_cache'] is True
    arche = {'id': 'unit', 'components': [one(*WHEEL)]}
    out = dm.run_debris('TEST-99999', arche, None, MATS, entry, bc, None, DEV, seed=0)
    assert out['p_any_survives'] > 0.5
    # impact happens minutes after the 80 km crossing
    assert 180 < out['components'][0]['flight_s']['mean'] < 2400, out['components'][0]['flight_s']
