// Grounded view of the public tables. Counts and the "next 24h / 72h" lists
// are computed here so the model does not invent a tally. Null means the cell
// is empty. A negative p_hazard (the module's "not computed" sentinel) is null.

import type { TableRow } from './sats.ts';

const HOUR_MS = 3_600_000;

export type Tables = {
  objects: TableRow[];
  forecasts: TableRow[];
  debris: TableRow[];
  components: TableRow[];
  profiles: TableRow[];
  weather: TableRow[];
};

export type Snapshot = {
  legend: string;
  as_of: string;
  summary: {
    counts: Record<string, number>;
    empty_tables: string[];
    next_24h: Slim[];
    next_72h: Slim[];
    soonest: Slim[];
  };
  space_weather: Record<string, unknown> | null;
  objects: ObjectView[];
  objects_omitted: number;
};

type Slim = {
  id: string;
  name: string;
  norad_id: number | null;
  source: string | null;
  status: string | null;
  median_reentry_utc: string | null;
  window_q05_utc: string | null;
  window_q95_utc: string | null;
  hours_from_as_of: number | null;
  decayed_frac: number | null;
  forecast_area_km2_90: number | null;
  debris: DebrisBrief | null;
};

type DebrisBrief = {
  archetype_id: string | null;
  p_any_survives: number | null;
  surviving_mass_kg_mean: number | null;
  area_km2_90: number | null;
  note: string | null;
};

type ObjectView = {
  id: string;
  name: string;
  norad_id: number | null;
  source: string | null;
  status: string | null;
  window_start: string | null;
  window_end: string | null;
  profile: Record<string, unknown> | null;
  forecast: Record<string, unknown> | null;
  debris: Record<string, unknown> | null;
};

const LEGEND = [
  'Read from SpacetimeDB just now: reentry_object, forecast, debris_forecast, debris_component, satellite_profile, space_weather.',
  'summary.next_24h is every object whose forecast median (t_q50) is between 1 hour ago and 24 hours ahead. next_72h is the same out to 72 hours. soonest is the eight nearest medians, including later ones. hours_from_as_of is (median - as_of) in hours, rounded to 0.1. These lists are complete; do not recount them.',
  'Debris masses, survival chances, energies, and areas are modeled estimates from an archetype, not a surveyed impact and not the operator\'s design. Say "modeled estimate" and name archetype_id.',
  'impact_lat and impact_lon are one modeled sample point, not a landing claim. forecast_area_km2_90 and debris.area_km2_90 are the 90% footprint area in km^2.',
  'p_hazard below 0 is the module sentinel for "not computed" and is returned as null. Do not quote it.',
  'source or status REPLAY is a historical replay, not a live prediction.',
  'null means that table cell is empty.',
].join(' ');

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hazard(v: unknown): number | null {
  const n = num(v);
  return n === null || n < 0 ? null : n;
}

function hoursFrom(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round(((t - nowMs) / HOUR_MS) * 10) / 10;
}

function byId(rows: TableRow[], key: string): Map<string, TableRow> {
  const map = new Map<string, TableRow>();
  for (const row of rows) {
    const id = str(row[key]);
    if (id) map.set(id, row);
  }
  return map;
}

function componentsByObject(rows: TableRow[]): Map<string, TableRow[]> {
  const map = new Map<string, TableRow[]>();
  for (const row of rows) {
    const id = str(row.object_id);
    if (!id) continue;
    const list = map.get(id);
    if (list) list.push(row);
    else map.set(id, [row]);
  }
  return map;
}

function profileByNorad(rows: TableRow[]): Map<number, TableRow> {
  const map = new Map<number, TableRow>();
  for (const row of rows) {
    const id = num(row.norad_id);
    if (id !== null) map.set(id, row);
  }
  return map;
}

function componentView(row: TableRow): Record<string, unknown> {
  return {
    name: str(row.name),
    material: str(row.material),
    shape: str(row.shape),
    count: num(row.count),
    mass_kg_start: num(row.mass_kg_start),
    p_survive: num(row.p_survive),
    mass_kg_mean: num(row.mass_kg_mean),
    impact_speed_ms_mean: num(row.impact_speed_ms_mean),
    impact_energy_j_mean: num(row.impact_energy_j_mean),
    demise_alt_km_mean: num(row.demise_alt_km_mean),
    impact_lat: num(row.impact_lat),
    impact_lon: num(row.impact_lon),
    p_hazard: hazard(row.p_hazard),
  };
}

function debrisBrief(row: TableRow | undefined): DebrisBrief | null {
  if (!row) return null;
  return {
    archetype_id: str(row.archetype_id),
    p_any_survives: num(row.p_any_survives),
    surviving_mass_kg_mean: num(row.surviving_mass_kg_mean),
    area_km2_90: num(row.area_km_2_90),
    note: str(row.note),
  };
}

const COMPONENT_CAP = 24;
const OBJECT_CAP = 80;

export function buildSnapshot(tables: Tables, now: Date): Snapshot {
  const nowMs = now.getTime();
  const forecasts = byId(tables.forecasts, 'object_id');
  const debris = byId(tables.debris, 'object_id');
  const components = componentsByObject(tables.components);
  const profiles = profileByNorad(tables.profiles);

  const views: ObjectView[] = tables.objects.map(obj => {
    const id = str(obj.id) ?? '';
    const norad = num(obj.norad_id);
    const forecast = forecasts.get(id);
    const debrisRow = debris.get(id);
    const profile = norad === null ? undefined : profiles.get(norad);
    const parts = (components.get(id) ?? [])
      .slice()
      .sort((a, b) => (num(b.p_survive) ?? -1) - (num(a.p_survive) ?? -1));
    const shown = parts.slice(0, COMPONENT_CAP).map(componentView);
    return {
      id,
      name: str(obj.name) ?? id,
      norad_id: norad,
      source: str(obj.source),
      status: str(obj.status),
      window_start: str(obj.window_start),
      window_end: str(obj.window_end),
      profile: profile
        ? {
            name: str(profile.name),
            object_type: str(profile.object_type),
            mass_kg: num(profile.mass_kg),
            archetype_id: str(profile.archetype_id),
            match_reason: str(profile.match_reason),
            confidence: str(profile.confidence),
            sources: str(profile.sources),
          }
        : null,
      forecast: forecast
        ? {
            status: str(forecast.status),
            t_q05: str(forecast.t_q_05),
            t_q25: str(forecast.t_q_25),
            t_q50: str(forecast.t_q_50),
            t_q75: str(forecast.t_q_75),
            t_q95: str(forecast.t_q_95),
            decayed_frac: num(forecast.decayed_frac),
            horizon_days: num(forecast.horizon_days),
            n_samples: num(forecast.n_samples),
            area_km2_90: num(forecast.area_km_2_90),
            tier: str(forecast.tier),
            device: str(forecast.device),
            computed_at: str(forecast.computed_at),
            calibrated: forecast.calibrated === true,
            note: str(forecast.note),
          }
        : null,
      debris: debrisRow
        ? {
            archetype_id: str(debrisRow.archetype_id),
            p_any_survives: num(debrisRow.p_any_survives),
            surviving_mass_kg_mean: num(debrisRow.surviving_mass_kg_mean),
            surviving_mass_kg_p95: num(debrisRow.surviving_mass_kg_p_95),
            area_km2_90: num(debrisRow.area_km_2_90),
            p_hazard: hazard(debrisRow.p_hazard),
            hazard_pieces_mean: hazard(debrisRow.hazard_pieces_mean),
            tier: str(debrisRow.tier),
            device: str(debrisRow.device),
            computed_at: str(debrisRow.computed_at),
            note: str(debrisRow.note),
            components: shown,
            components_omitted: Math.max(0, parts.length - shown.length),
          }
        : null,
    };
  });

  const slim = (view: ObjectView): Slim => {
    const forecast = view.forecast;
    const median = forecast ? str(forecast.t_q50) : null;
    const debrisRow = debris.get(view.id);
    return {
      id: view.id,
      name: view.name,
      norad_id: view.norad_id,
      source: view.source,
      status: view.status,
      median_reentry_utc: median,
      window_q05_utc: forecast ? str(forecast.t_q05) : null,
      window_q95_utc: forecast ? str(forecast.t_q95) : null,
      hours_from_as_of: hoursFrom(median, nowMs),
      decayed_frac: forecast ? num(forecast.decayed_frac) : null,
      forecast_area_km2_90: forecast ? num(forecast.area_km2_90) : null,
      debris: debrisBrief(debrisRow),
    };
  };

  const withMedian = views
    .map(slim)
    .filter(row => row.median_reentry_utc !== null)
    .sort((a, b) => (a.hours_from_as_of ?? 0) - (b.hours_from_as_of ?? 0));
  const inWindow = (maxHours: number) =>
    withMedian.filter(row => {
      const h = row.hours_from_as_of;
      return h !== null && h >= -1 && h <= maxHours;
    });

  const ranked = [...views].sort((a, b) => {
    const score = (view: ObjectView) => {
      if (view.debris) return 0;
      const h = hoursFrom(view.forecast ? str(view.forecast.t_q50) : null, nowMs);
      if (h !== null && h >= -1 && h <= 72) return 1;
      if (h !== null) return 2;
      return 3;
    };
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });

  const empty: string[] = [];
  if (tables.objects.length === 0) empty.push('reentry_object');
  if (tables.forecasts.length === 0) empty.push('forecast');
  if (tables.debris.length === 0) empty.push('debris_forecast');
  if (tables.components.length === 0) empty.push('debris_component');
  if (tables.profiles.length === 0) empty.push('satellite_profile');
  if (tables.weather.length === 0) empty.push('space_weather');

  const weather = tables.weather[0];
  return {
    legend: LEGEND,
    as_of: now.toISOString(),
    summary: {
      counts: {
        objects: tables.objects.length,
        forecasts: tables.forecasts.length,
        debris_forecasts: tables.debris.length,
        debris_components: tables.components.length,
        profiles: tables.profiles.length,
        next_24h: inWindow(24).length,
        next_72h: inWindow(72).length,
      },
      empty_tables: empty,
      next_24h: inWindow(24),
      next_72h: inWindow(72),
      soonest: withMedian.slice(0, 8),
    },
    space_weather: weather
      ? {
          kp: num(weather.kp),
          kp_time: str(weather.kp_time),
          f107: num(weather.f_107),
          f107_time: str(weather.f_107_time),
          updated_at: str(weather.updated_at),
        }
      : null,
    objects: ranked.slice(0, OBJECT_CAP),
    objects_omitted: Math.max(0, ranked.length - OBJECT_CAP),
  };
}

export type DataMode = 'LIVE' | 'SIM' | 'MIXED' | 'NONE';

export function dataMode(snapshot: Snapshot): DataMode {
  if (snapshot.objects.length === 0) return 'NONE';
  let sim = 0;
  let live = 0;
  for (const obj of snapshot.objects) {
    const label = `${obj.source ?? ''} ${obj.status ?? ''}`.toUpperCase();
    if (label.includes('REPLAY') || label.includes('SIM')) sim += 1;
    else live += 1;
  }
  if (sim > 0 && live > 0) return 'MIXED';
  if (sim > 0) return 'SIM';
  return 'LIVE';
}
