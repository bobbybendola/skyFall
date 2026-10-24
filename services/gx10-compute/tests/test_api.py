"""HTTP contract for /debris (docs/DEBRIS_MODEL.md section 5). Runs on CPU."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ['USE_GPU'] = '0'

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402

client = TestClient(app_module.app)
ARCHE = json.loads((HERE / 'fixtures' / 'test-flatpanel.json').read_text())
ENTRY = {'t': '2026-10-25T12:00:00Z', 'lat': 35.0, 'lon': -120.0, 'heading_deg': 120}


def test_debris_contract():
    r = client.post('/debris', json={'object': {'id': 'TEST-1'}, 'archetype': ARCHE, 'entry': ENTRY, 'n_particles': 40, 'degraded': False, 'seed': 3})
    assert r.status_code == 200, r.text
    out = r.json()
    for k in ('id', 'archetype', 'n_particles', 'ms', 'device', 'p_any_survives', 'surviving_mass_kg', 'casualty_area_m2', 'components', 'footprint', 'sample_tracks', 'label', 'particle_steps'):
        assert k in out, k
    assert out['label'] == 'modeled estimate' and out['entry']['source'] == 'entry'
    c = out['components'][0]
    for k in ('name', 'material', 'count', 'p_survive', 'mass_kg', 'impact_speed_ms', 'impact_energy_j', 'demise_alt_km', 'footprint'):
        assert k in c, k
    for k in ('bands', 'area_km2_90', 'center', 'samples'):
        assert k in c['footprint'], k
    for t in out['sample_tracks']:
        assert len(t['points']) <= 60 and len(t['points'][0]) == 4


def test_debris_cpu_defaults_to_degraded():
    r = client.post('/debris', json={'object': {'id': 'TEST-2'}, 'archetype': ARCHE, 'entry': ENTRY, 'n_particles': 20})
    assert r.status_code == 200, r.text
    assert r.json()['degraded'] is True and len(r.json()['components']) == 3


def test_debris_bad_input_is_422():
    bad = {**ARCHE, 'components': [{'name': 'x', 'material': 'Al6061', 'shape': 'torus', 'mass_kg': 1, 'dims_m': [1]}]}
    r = client.post('/debris', json={'object': {'id': 'TEST-3'}, 'archetype': bad, 'entry': ENTRY})
    assert r.status_code == 422 and 'shape' in r.text
    r = client.post('/debris', json={'object': {'id': 'TEST-4'}, 'archetype': ARCHE})
    assert r.status_code == 422 and 'entry' in r.text
    r = client.post('/debris', json={'object': {'id': 'TEST-5'}, 'archetype': ARCHE, 'entry': {'lat': 1}})
    assert r.status_code == 422 and 'entry needs' in r.text
    dup = {**ARCHE, 'components': ARCHE['components'] + ARCHE['components'][:1]}
    r = client.post('/debris', json={'object': {'id': 'TEST-6'}, 'archetype': dup, 'entry': ENTRY})
    assert r.status_code == 422 and 'duplicate' in r.text
