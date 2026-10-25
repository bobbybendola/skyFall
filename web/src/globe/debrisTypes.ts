// The /debris result shape (docs/DEBRIS_MODEL.md §5). G2/G3/G4 render this;
// it comes from the mock (src/mock/debris.ts) until the debris_* tables exist.
export type Band = { level: 50 | 90; polygon: [number, number][] }; // [lon, lat] ring

export type DebrisComponent = {
  name: string;
  material: string; // Al6061 | Ti6Al4V | SS304 | CFRP | Glass | Copper | ...
  shape: string; // sphere | cylinder | box | plate
  count: number;
  p_survive: number; // 0..1
  p_hazard?: number | null; // 0..1, lands with >= 15 J; null if not computed
  mass_kg: { start: number; mean: number }; // mean surviving mass (0 if it burns up)
  impact_speed_ms: { mean: number | null };
  impact_energy_j: { mean: number | null };
  demise_alt_km: { mean: number | null }; // null if it usually survives
  impact: { lat: number; lon: number } | null; // centre of the impact zone (null if it never survives)
  footprint: { bands: Band[] };
};

export type SampleTrack = {
  component: string;
  survived: boolean;
  points: [number, number, number, number][]; // [t_unix_s, lat, lon, alt_km]
};

export type DebrisResult = {
  id: string; // object id
  archetype: string;
  source: 'mock' | 'live';
  n_particles: number;
  breakup: { t_unix_s: number; lat: number; lon: number; alt_km: number };
  p_any_survives: number; // any piece at all, even a harmless flake: not a danger measure
  // pieces landing with >= 15 J (what NASA/ESA casualty tools count); null on older runs and the mock
  hazard?: { p_any: number; pieces_mean: number; pieces_p95: number } | null;
  surviving_mass_frac?: number | null;
  // per ~110 km cell: runs (of n_runs) in which a dangerous piece lands there (#18)
  hazard_grid?: { cell_deg: number; n_runs: number; cells: [number, number, number][]; truncated: boolean } | null;
  surviving_mass_kg: { mean: number; p95: number };
  casualty_area_m2: { mean: number };
  components: DebrisComponent[];
  footprint: { bands: Band[]; area_km2_90: number };
  sample_tracks: SampleTrack[];
};

/** Display colors per material, shared by G2 (lines/zones) and G4 (legend). */
export const MATERIAL_COLOR: Record<string, string> = {
  SS304: '#8fa3b8', // steel: blue-grey
  Ti6Al4V: '#ffffff', // titanium: white
  Al6061: '#ff9b3d', // aluminium: orange
  CFRP: '#222222', // carbon fibre: black
  Glass: '#7fd3ff',
  Copper: '#d67a3c',
  Inconel: '#c9b48a', // nickel alloy (engine parts): tan
};
export const OTHER_MATERIAL_COLOR = '#b07cff';

/** Headline danger line, e.g. "~15 dangerous pieces (>15 J)". Falls back to the old
 * any-piece number for runs made before the hazard fields existed. */
export function dangerText(d: DebrisResult): string {
  const h = d.hazard;
  if (!h) return `${Math.round(d.p_any_survives * 100)}% chance any piece survives`;
  if (h.pieces_mean < 0.05) return 'no dangerous pieces expected (>15 J)';
  const n = h.pieces_mean >= 2 ? `~${Math.round(h.pieces_mean)}` : `~${h.pieces_mean.toFixed(1)}`;
  return `${n} dangerous piece${h.pieces_mean >= 1.5 ? 's' : ''} (>15 J)`;
}
