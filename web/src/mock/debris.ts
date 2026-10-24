// MOCK debris results, in the exact /debris shape (docs/DEBRIS_MODEL.md §5),
// so G2-G4 can build before the GX10 debris model and the debris_* tables
// exist. Geometry is anchored to the real object's orbit at its forecast
// re-entry time, but every number below is made up: the UI must label it MOCK.
import { sgp4Point } from '../orbit.ts';
import type { Band, DebrisComponent, DebrisResult, SampleTrack } from '../globe/debrisTypes.ts';

const RE_KM = 6371;

// A generic small LEO satellite (made-up masses; real archetypes come from data/archetypes/).
const MOCK_PARTS: Array<Omit<DebrisComponent, 'impact' | 'footprint' | 'mass_kg' | 'impact_speed_ms' | 'impact_energy_j' | 'demise_alt_km'> & {
  mass: number;
  survMassFrac: number;
  speed: number;
  demiseKm: number | null;
  downrangeKm: number;
}> = [
  { name: 'bus structure', material: 'Al6061', shape: 'box', count: 1, p_survive: 0.02, mass: 120, survMassFrac: 0.05, speed: 60, demiseKm: 62, downrangeKm: 250 },
  { name: 'solar array', material: 'CFRP', shape: 'plate', count: 1, p_survive: 0.0, mass: 40, survMassFrac: 0, speed: 0, demiseKm: 74, downrangeKm: 120 },
  { name: 'reaction wheel', material: 'SS304', shape: 'cylinder', count: 4, p_survive: 0.71, mass: 3, survMassFrac: 0.62, speed: 85, demiseKm: null, downrangeKm: 820 },
  { name: 'propellant tank', material: 'Ti6Al4V', shape: 'sphere', count: 1, p_survive: 0.8, mass: 4, survMassFrac: 0.85, speed: 70, demiseKm: null, downrangeKm: 980 },
  { name: 'battery pack', material: 'Copper', shape: 'box', count: 1, p_survive: 0.18, mass: 8, survMassFrac: 0.3, speed: 95, demiseKm: 41, downrangeKm: 640 },
  { name: 'avionics box', material: 'Al6061', shape: 'box', count: 2, p_survive: 0.05, mass: 5, survMassFrac: 0.1, speed: 55, demiseKm: 58, downrangeKm: 420 },
];

/** Great-circle destination from (lat, lon) along bearing (deg) for distance (km). */
export function destination(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const d = km / RE_KM;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, ((((l2 * 180) / Math.PI + 540) % 360) - 180)];
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Ellipse elongated along the ground track (along km × across km), as a [lon, lat] ring. */
function ellipse(lat: number, lon: number, headingDeg: number, alongKm: number, acrossKm: number, n = 36): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const x = alongKm * Math.cos(a);
    const y = acrossKm * Math.sin(a);
    const dist = Math.hypot(x, y);
    const brg = headingDeg + (Math.atan2(y, x) * 180) / Math.PI;
    const [la, lo] = destination(lat, lon, brg, dist);
    ring.push([lo, la]);
  }
  return ring;
}

function bands(lat: number, lon: number, heading: number, along: number, across: number): Band[] {
  return [
    { level: 90, polygon: ellipse(lat, lon, heading, along, across) },
    { level: 50, polygon: ellipse(lat, lon, heading, along * 0.45, across * 0.45) },
  ];
}

/**
 * Mock debris for one object. `elements` is the object's GP JSON string;
 * `reentryMs` its forecast median (falls back to one hour from `nowMs`).
 */
export function mockDebris(objectId: string, elements: string, reentryMs: number | undefined, nowMs: number): DebrisResult | null {
  // SGP4 often "decays" an object before our forecast time; anchor the mock at
  // the last time it still gives a position (stepping back 10 min at a time).
  let tBreak = reentryMs !== undefined && Number.isFinite(reentryMs) ? reentryMs : nowMs + 3.6e6;
  let p0 = sgp4Point(`${objectId}#mock`, elements, new Date(tBreak));
  let p1 = sgp4Point(`${objectId}#mock`, elements, new Date(tBreak + 60_000));
  while ((!p0 || !p1) && tBreak > nowMs) {
    tBreak -= 600_000;
    p0 = sgp4Point(`${objectId}#mock`, elements, new Date(tBreak));
    p1 = sgp4Point(`${objectId}#mock`, elements, new Date(tBreak + 60_000));
  }
  if (!p0 || !p1) return null;
  const heading = bearing(p0.lat, p0.lon, p1.lat, p1.lon);
  const breakup = { t_unix_s: tBreak / 1000, lat: p0.lat, lon: p0.lon, alt_km: 78 };

  const components: DebrisComponent[] = [];
  const tracks: SampleTrack[] = [];
  for (const part of MOCK_PARTS) {
    const survives = part.demiseKm === null || part.p_survive > 0.1;
    const [ilat, ilon] = destination(p0.lat, p0.lon, heading, part.downrangeKm);
    const massMean = part.mass * part.survMassFrac * part.p_survive;
    components.push({
      name: part.name,
      material: part.material,
      shape: part.shape,
      count: part.count,
      p_survive: part.p_survive,
      mass_kg: { start: part.mass, mean: Math.round(massMean * 100) / 100 },
      impact_speed_ms: { mean: survives ? part.speed : null },
      impact_energy_j: { mean: survives ? Math.round(0.5 * part.mass * part.survMassFrac * part.speed ** 2) : null },
      demise_alt_km: { mean: part.demiseKm },
      impact: survives ? { lat: ilat, lon: ilon } : null,
      footprint: { bands: survives ? bands(ilat, ilon, heading, 160, 28) : [] },
    });
    // One falling path per component: from break-up, downrange, to the ground or its demise altitude.
    const endAlt = survives ? 0 : (part.demiseKm ?? 0);
    const endKm = survives ? part.downrangeKm : part.downrangeKm * 0.4;
    const durS = survives ? 420 : 120;
    const pts: SampleTrack['points'] = [];
    for (let i = 0; i <= 30; i++) {
      const f = i / 30;
      const [la, lo] = destination(p0.lat, p0.lon, heading, endKm * Math.sqrt(f));
      pts.push([breakup.t_unix_s + durS * f, la, lo, 78 + (endAlt - 78) * f]);
    }
    tracks.push({ component: part.name, survived: survives, points: pts });
  }

  const pAny = 1 - components.reduce((q, c) => q * (1 - c.p_survive) ** c.count, 1);
  const surviving = components.reduce((s, c) => s + c.mass_kg.mean * c.count, 0);
  const [clat, clon] = destination(p0.lat, p0.lon, heading, 700);
  return {
    id: objectId,
    archetype: 'MOCK generic small LEO satellite',
    source: 'mock',
    n_particles: 0,
    breakup,
    p_any_survives: Math.round(pAny * 100) / 100,
    surviving_mass_kg: { mean: Math.round(surviving * 10) / 10, p95: Math.round(surviving * 2.5 * 10) / 10 },
    casualty_area_m2: { mean: 1.2 },
    components,
    footprint: { bands: bands(clat, clon, heading, 700, 45), area_km2_90: Math.round(Math.PI * 700 * 45) },
    sample_tracks: tracks,
  };
}
