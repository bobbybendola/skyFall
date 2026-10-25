import assert from 'node:assert/strict';
import test from 'node:test';
import { messagesFor, grokBody } from './ask.ts';
import { decodeRows, type SqlStatement } from './sats.ts';
import { buildSnapshot, dataMode, type Tables } from './snapshot.ts';

const timestamp = {
  Product: {
    elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' }, algebraic_type: { I64: [] } }],
  },
};
const optionTimestamp = {
  Sum: {
    variants: [
      { name: { some: 'some' }, algebraic_type: timestamp },
      { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } },
    ],
  },
};
const optionF64 = {
  Sum: {
    variants: [
      { name: { some: 'some' }, algebraic_type: { F64: [] } },
      { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } },
    ],
  },
};

function statement(names: string[], types: SqlStatement['schema']['elements'][number]['algebraic_type'][], rows: unknown[][]): SqlStatement {
  return {
    schema: {
      elements: names.map((name, i) => ({ name: { some: name }, algebraic_type: types[i]! })),
    },
    rows,
  };
}

test('decodes a live space_weather row and an optional timestamp', () => {
  const weather = decodeRows(
    statement(
      ['key', 'kp', 'f_107', 'updated_at'],
      [{ String: [] }, optionF64, optionF64, timestamp],
      [['current', [0, 0.33], [1, []], [1792921671784729]]]
    )
  );
  assert.equal(weather[0]?.key, 'current');
  assert.equal(weather[0]?.kp, 0.33);
  assert.equal(weather[0]?.f_107, null);
  assert.equal(weather[0]?.updated_at, '2026-10-25T09:47:51.784Z');

  const forecast = decodeRows(
    statement(
      ['object_id', 't_q_50'],
      [{ String: [] }, optionTimestamp],
      [
        ['CT-1', [0, [1793129775613000]]],
        ['CT-2', [1, []]],
      ]
    )
  );
  assert.equal(forecast[0]?.t_q_50, '2026-10-27T19:36:15.613Z');
  assert.equal(forecast[1]?.t_q_50, null);
});

function tables(extra: Partial<Tables> = {}): Tables {
  return {
    objects: [],
    forecasts: [],
    debris: [],
    components: [],
    profiles: [],
    weather: [],
    ...extra,
  };
}

const NOW = new Date('2026-10-25T10:00:00.000Z');

test('next 24h uses the median and leaves later objects out', () => {
  const snapshot = buildSnapshot(
    tables({
      objects: [
        { id: 'CT-1', name: 'SOON', norad_id: 1, source: 'CANDIDATE', status: 'CANDIDATE' },
        { id: 'CT-2', name: 'LATER', norad_id: 2, source: 'CANDIDATE', status: 'CANDIDATE' },
        { id: 'REPLAY-old', name: 'OLD', norad_id: 3, source: 'REPLAY', status: 'REPLAY' },
      ],
      forecasts: [
        { object_id: 'CT-1', status: 'ok', t_q_05: '2026-10-25T08:00:00.000Z', t_q_50: '2026-10-25T16:00:00.000Z', t_q_95: '2026-10-26T00:00:00.000Z', decayed_frac: 1, area_km_2_90: 1000 },
        { object_id: 'CT-2', status: 'ok', t_q_50: '2026-10-29T10:00:00.000Z', decayed_frac: 0.4, area_km_2_90: 50 },
        { object_id: 'REPLAY-old', status: 'ok', t_q_50: '2026-10-25T12:00:00.000Z', decayed_frac: 1 },
      ],
      debris: [
        {
          object_id: 'CT-1',
          archetype_id: 'starlink',
          p_any_survives: 0.18,
          surviving_mass_kg_mean: 3.2,
          area_km_2_90: 400,
          p_hazard: -1,
          hazard_pieces_mean: -1,
          note: 'Modeled estimate',
        },
      ],
      components: [
        { object_id: 'CT-1', name: 'tank', material: 'Titanium', p_survive: 0.4, mass_kg_mean: 2.5, impact_lat: 37.8, impact_lon: -122.2, p_hazard: -1 },
      ],
    }),
    NOW
  );
  assert.deepEqual(
    snapshot.summary.next_24h.map(row => row.name),
    ['OLD', 'SOON']
  );
  assert.equal(snapshot.summary.next_24h[1]?.hours_from_as_of, 6);
  assert.equal(snapshot.summary.counts.next_72h, 2);
  assert.equal(snapshot.summary.soonest[1]?.name, 'SOON');
  const soon = snapshot.objects.find(obj => obj.id === 'CT-1');
  assert.equal(soon?.debris && (soon.debris as { p_hazard: unknown }).p_hazard, null);
  const parts = (soon?.debris as { components: { p_hazard: unknown; impact_lat: unknown }[] }).components;
  assert.equal(parts[0]?.p_hazard, null);
  assert.equal(parts[0]?.impact_lat, 37.8);
  assert.equal(snapshot.summary.empty_tables.includes('satellite_profile'), true);
  assert.equal(dataMode(snapshot), 'MIXED');
});

test('empty tables stay empty and the prompt forbids invented numbers', () => {
  const snapshot = buildSnapshot(tables(), NOW);
  assert.deepEqual(snapshot.summary.empty_tables, [
    'reentry_object',
    'forecast',
    'debris_forecast',
    'debris_component',
    'satellite_profile',
    'space_weather',
  ]);
  assert.equal(snapshot.summary.next_24h.length, 0);
  assert.equal(dataMode(snapshot), 'NONE');
  const messages = messagesFor(snapshot, "What's coming down in the next 24 hours?", []);
  assert.match(messages[0]!.content, /Do not invent numbers/);
  assert.match(messages[0]!.content, /next_24h/);
  const body = grokBody('grok-4.7', messages);
  assert.equal('search_parameters' in body, false);
  assert.equal('tools' in body, false);
  assert.equal(body.model, 'grok-4.7');
});
