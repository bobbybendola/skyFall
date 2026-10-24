// Ground-track helpers.
// - Replay objects use the same simplified circular-orbit model as the compute
//   stub (services/gx10-compute/app.py, _ground_point), so the drawn track
//   matches the corridor.
// - CelesTrak candidates are real GP/OMM elements, propagated with SGP4.
import { eciToGeodetic, degreesLat, degreesLong, gstime, json2satrec, propagate, type SatRec } from 'satellite.js';

const EARTH_ROT_DEG_S = 360 / 86164.0905;

export type StubElements = {
  model?: string;
  epoch?: string;
  inclination_deg?: number;
  raan_deg?: number;
  arg_lat_deg?: number;
  period_min?: number;
};

export function stubGroundPoint(el: StubElements, tMs: number): [number, number] {
  const inc = ((el.inclination_deg ?? 51.6) * Math.PI) / 180;
  const raan = el.raan_deg ?? 0;
  const periodS = (el.period_min ?? 88) * 60;
  const epochS = el.epoch ? Date.parse(el.epoch) / 1000 : 0;
  const dt = tMs / 1000 - epochS;
  const u = ((el.arg_lat_deg ?? 0) * Math.PI) / 180 + (2 * Math.PI * dt) / periodS;
  const lat = (Math.asin(Math.sin(inc) * Math.sin(u)) * 180) / Math.PI;
  let lon = raan + (Math.atan2(Math.cos(inc) * Math.sin(u), Math.cos(u)) * 180) / Math.PI;
  lon -= EARTH_ROT_DEG_S * dt;
  return [wrapLon(lon), lat];
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Split a track wherever it jumps across the antimeridian, so lines don't
// streak across the whole map.
export function splitAtAntimeridian(points: [number, number][]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 180) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function stubTrack(el: StubElements, fromMs: number, toMs: number, n = 240): [number, number][][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push(stubGroundPoint(el, fromMs + ((toMs - fromMs) * i) / (n - 1)));
  return splitAtAntimeridian(pts);
}

const satrecCache = new Map<string, SatRec | null>();

// Current sub-satellite point of a real object from its CelesTrak GP JSON.
export function sgp4Point(key: string, elementsJson: string, when: Date): { lon: number; lat: number; altKm: number } | null {
  let rec = satrecCache.get(key);
  if (rec === undefined) {
    try {
      rec = json2satrec(JSON.parse(elementsJson));
    } catch {
      rec = null;
    }
    satrecCache.set(key, rec);
  }
  if (!rec) return null;
  const pv = propagate(rec, when);
  if (!pv || typeof pv.position === 'boolean' || !pv.position) return null;
  const geo = eciToGeodetic(pv.position, gstime(when));
  const lat = degreesLat(geo.latitude);
  const lon = degreesLong(geo.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lon, lat, altKm: geo.height };
}
