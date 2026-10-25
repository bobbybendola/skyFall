// G2 overlay: the "only pieces with >= 10% survival" toggle, the MOCK /
// modeled-estimate label, and the tooltip for a hovered or clicked line/zone.
// (The full breakdown panel and legend are G4's.)
import './debrisOverlay.css';
import type { DebrisResult } from './debrisTypes.ts';
import { dangerText, MATERIAL_COLOR, OTHER_MATERIAL_COLOR } from './debrisTypes.ts';
import { hovered, MIN_SURVIVAL, onlySurvivors, showWarnings, type PickInfo } from './debrisPick.ts';
import { LEVELS, levelCounts } from './warningLevels.ts';

const pct = (p: number) => `${Math.round(p * 100)}%`;
const num = (x: number | null | undefined, unit: string, digits = 1) =>
  x === null || x === undefined ? '—' : `${x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(digits)} ${unit}`;

function Tip({ info, debris }: { info: PickInfo; debris: DebrisResult }) {
  const c = info.component;
  const tag = info.mock ? <span className="mock">MOCK</span> : <span className="muted">modeled estimate</span>;
  if (!c) {
    return (
      <>
        <b>All surviving pieces</b> {tag}
        <div>{info.level}% impact zone · {num(debris.footprint.area_km2_90, 'km² (90%)', 0)}</div>
        <div>{dangerText(debris)}{debris.hazard && <span className="muted"> · {pct(debris.hazard.p_any)} chance of at least one</span>}</div>
        <div>surviving mass: {num(debris.surviving_mass_kg.mean, 'kg')}{debris.surviving_mass_frac != null && ` (${pct(debris.surviving_mass_frac)} of the satellite)`} · p95 {num(debris.surviving_mass_kg.p95, 'kg')}</div>
        {debris.hazard && <div className="muted">any fragment at all reaches the ground: {pct(debris.p_any_survives)} (mostly harmless)</div>}
      </>
    );
  }
  return (
    <>
      <span className="swatch" style={{ background: MATERIAL_COLOR[c.material] ?? OTHER_MATERIAL_COLOR }} />
      <b>{c.name}</b>
      {c.count > 1 ? ` ×${c.count}` : ''} {tag}
      <div className="muted">
        {c.material} {c.shape}
        {info.kind === 'zone' ? ` · ${info.level}% impact zone` : ' · line to predicted landing point'}
      </div>
      <div>reaches the ground: {pct(c.p_survive)}{c.p_hazard != null && ` · dangerous (>15 J): ${pct(c.p_hazard)}`}</div>
      <div>
        mass left: {num(c.mass_kg.mean, 'kg', 2)} of {num(c.mass_kg.start, 'kg')}
      </div>
      <div>impact energy: {num(c.impact_energy_j.mean, 'J', 0)}</div>
      {c.demise_alt_km.mean !== null && <div className="muted">burns up near {num(c.demise_alt_km.mean, 'km')} when it doesn't survive</div>}
    </>
  );
}

function WarningLegend({ debris, warningAllowed }: { debris: DebrisResult; warningAllowed: boolean }) {
  const g = debris.hazard_grid;
  if (!g) return <div className="muted">no warning grid for this run yet</div>;
  const n = levelCounts(debris, warningAllowed);
  return (
    <div className="warn-legend">
      {LEVELS.map(l => (
        <div key={l.name}>
          <span className="swatch" style={{ background: l.css }} /> <b>{l.name}</b> <span className="muted">{l.blurb} · {n[l.name]} cells</span>
        </div>
      ))}
      {!warningAllowed && <div className="muted">Warning is shown only within 24 h of the predicted break-up; until then those cells show as Watch.</div>}
      <div className="muted">
        modeled estimate from {g.n_runs.toLocaleString()} simulated re-entries{g.truncated ? ' · only the highest 5,000 cells shown' : ''}
      </div>
    </div>
  );
}

export function DebrisOverlay({ debris, warningAllowed }: { debris: DebrisResult; warningAllowed: boolean }) {
  const only = onlySurvivors.use();
  const warn = showWarnings.use();
  const tip = hovered.use();
  return (
    <>
      <label className="debris-toggle">
        <input type="checkbox" checked={only} onChange={e => onlySurvivors.set(e.target.checked)} /> only pieces with ≥ {pct(MIN_SURVIVAL)} survival
        {debris.source === 'mock' ? <span className="mock">MOCK</span> : <span className="muted"> · modeled estimate ({debris.archetype})</span>}
      </label>
      <div className="debris-toggle warn-toggle">
        <label>
          <input type="checkbox" checked={warn} onChange={e => showWarnings.set(e.target.checked)} /> warning levels on the ground
        </label>
        {warn && <WarningLegend debris={debris} warningAllowed={warningAllowed} />}
      </div>
      {tip && (
        <div className={`debris-tip${tip.pinned ? ' pinned' : ''}`} style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <Tip info={tip.info} debris={debris} />
        </div>
      )}
    </>
  );
}
