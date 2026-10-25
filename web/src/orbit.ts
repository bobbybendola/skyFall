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

export type AltitudeInfo = {
  altKm: number; // geodetic altitude now
  perigeeKm: number | null; // from the element set (mean elements, spherical Earth)
  apogeeKm: number | null;
  dropKmPerDay: number | null; // orbit-average altitude now vs 1 day later, from SGP4
};

const R_EARTH_KM = 6378.137;
const MU_KM3_S2 = 398600.4418;

function orbitMeanAlt(key: string, elementsJson: string, tMs: number, periodS: number): number | null {
  let sum = 0;
  const n = 12;
  for (let i = 0; i < n; i++) {
    const p = sgp4Point(key, elementsJson, new Date(tMs + (periodS * 1000 * i) / n));
    if (!p) return null;
    sum += p.altKm;
  }
  return sum / n;
}

// Altitude of a real object at a time, plus perigee/apogee and how fast it is coming down.
export function altitudeInfo(key: string, elementsJson: string, tMs: number): AltitudeInfo | null {
  const now = sgp4Point(key, elementsJson, new Date(tMs));
  if (!now) return null;
  let perigeeKm: number | null = null;
  let apogeeKm: number | null = null;
  let periodS = 5400;
  try {
    const el = JSON.parse(elementsJson);
    const nRad = (Number(el.MEAN_MOTION) * 2 * Math.PI) / 86400; // rev/day -> rad/s
    const e = Number(el.ECCENTRICITY);
    if (nRad > 0 && Number.isFinite(e)) {
      const a = Math.cbrt(MU_KM3_S2 / (nRad * nRad));
      perigeeKm = a * (1 - e) - R_EARTH_KM;
      apogeeKm = a * (1 + e) - R_EARTH_KM;
      periodS = (2 * Math.PI) / nRad;
    }
  } catch {
    /* no elements: altitude only */
  }
  const m0 = orbitMeanAlt(key, elementsJson, tMs, periodS);
  const m1 = orbitMeanAlt(key, elementsJson, tMs + 86_400_000, periodS);
  const dropKmPerDay = m0 !== null && m1 !== null ? m0 - m1 : null;
  return { altKm: now.altKm, perigeeKm, apogeeKm, dropKmPerDay };
}

// "312 km" style label; under 1 km/day shows one decimal.
export function altitudeText(a: AltitudeInfo): string {
  const drop = a.dropKmPerDay;
  const rate = drop === null ? '' : drop > 0.05 ? ` · dropping ~${drop >= 1 ? Math.round(drop) : drop.toFixed(1)} km/day` : ' · holding altitude';
  return `${Math.round(a.altKm)} km${rate}`;
}
