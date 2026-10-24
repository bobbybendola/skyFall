// The /debris result shape (docs/DEBRIS_MODEL.md §5). G2/G3/G4 render this;
// it comes from the mock (src/mock/debris.ts) until the debris_* tables exist.
export type Band = { level: 50 | 90; polygon: [number, number][] }; // [lon, lat] ring

export type DebrisComponent = {
  name: string;
  material: string; // Al6061 | Ti6Al4V | SS304 | CFRP | Glass | Copper | ...
  shape: string; // sphere | cylinder | box | plate
  count: number;
  p_survive: number; // 0..1
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
  p_any_survives: number;
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
};
export const OTHER_MATERIAL_COLOR = '#b07cff';
