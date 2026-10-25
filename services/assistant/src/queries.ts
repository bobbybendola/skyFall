// Fixed SELECTs. No user text is interpolated. Footprints and element sets stay
// out: they are large polygons / GP JSON and are not needed to answer.

import { decodeRows, type SqlStatement, type TableRow } from './sats.ts';
import type { Tables } from './snapshot.ts';

export const QUERIES = {
  objects:
    'SELECT id, name, norad_id, source, status, window_start, window_end FROM reentry_object',
  forecasts:
    'SELECT object_id, status, t_q_05, t_q_25, t_q_50, t_q_75, t_q_95, decayed_frac, horizon_days, n_samples, area_km_2_90, tier, device, computed_at, calibrated, note FROM forecast',
  debris:
    'SELECT object_id, archetype_id, p_any_survives, surviving_mass_kg_mean, surviving_mass_kg_p_95, area_km_2_90, p_hazard, hazard_pieces_mean, tier, device, computed_at, note FROM debris_forecast',
  components:
    'SELECT object_id, name, material, shape, count, mass_kg_start, p_survive, mass_kg_mean, impact_speed_ms_mean, impact_energy_j_mean, demise_alt_km_mean, impact_lat, impact_lon, p_hazard FROM debris_component',
  profiles:
    'SELECT norad_id, name, object_type, mass_kg, archetype_id, match_reason, confidence, sources FROM satellite_profile',
  weather: 'SELECT key, kp, kp_time, f_107, f_107_time, updated_at FROM space_weather',
} as const;

export type SqlRunner = (query: string) => Promise<SqlStatement>;

function rows(statement: SqlStatement): TableRow[] {
  return decodeRows(statement);
}

export async function loadTables(sql: SqlRunner): Promise<Tables> {
  const [objects, forecasts, debris, components, profiles, weather] = await Promise.all([
    sql(QUERIES.objects),
    sql(QUERIES.forecasts),
    sql(QUERIES.debris),
    sql(QUERIES.components),
    sql(QUERIES.profiles),
    sql(QUERIES.weather),
  ]);
  return {
    objects: rows(objects),
    forecasts: rows(forecasts),
    debris: rows(debris),
    components: rows(components),
    profiles: rows(profiles),
    weather: rows(weather),
  };
}

export function httpBase(uri: string): string {
  const trimmed = uri.replace(/\/$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}

export async function runSql(base: string, database: string, query: string, token: string | undefined): Promise<SqlStatement> {
  const headers: Record<string, string> = { 'content-type': 'text/plain' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/v1/database/${encodeURIComponent(database)}/sql`, {
    method: 'POST',
    headers,
    body: query,
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`spacetime sql HTTP ${res.status}: ${text.slice(0, 180)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('spacetime sql returned invalid JSON');
  }
  if (!Array.isArray(body) || body.length === 0) throw new Error('spacetime sql returned no statement');
  const first = body[0] as SqlStatement;
  if (!first?.schema?.elements || !Array.isArray(first.rows)) throw new Error('spacetime sql returned an unexpected shape');
  return first;
}
