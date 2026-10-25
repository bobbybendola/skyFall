// Satellite model viewer: opens when an object is selected and shows its archetype
// (the parts list the debris model breaks up) as a 3D schematic. Hover a part to
// show only that part's lines and zones on the globe; click to pin it.
// Objects with no matched archetype use the generic small-satellite assumption.
import './satModelPanel.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings/index.ts';
import { focusedPart, hovered } from './debrisPick.ts';
import { MATERIAL_COLOR, OTHER_MATERIAL_COLOR, type DebrisResult } from './debrisTypes.ts';
import { NARROW } from './panel.tsx';
import { layoutParts, type ArchetypePart } from './satModelLayout.ts';
import type { SceneHandle } from './satModelScene.ts';
import type { TrackedObject } from './satellites.ts';
import { useSelected } from './selection.ts';

// Bundled copy of data/archetypes/generic.json, for when the archetype table is empty
// (keep in sync). ASSUMED layout: a typical 100-300 kg smallsat.
const GENERIC_PARTS: ArchetypePart[] = [
  { name: 'bus structure', material: 'Al6061', shape: 'box', mass_kg: 60, dims_m: [1.0, 0.8, 0.8], count: 1, parent: null },
  { name: 'solar array', material: 'CFRP', shape: 'plate', mass_kg: 20, dims_m: [3.0, 1.0, 0.03], count: 2, parent: null },
  { name: 'reaction wheel', material: 'SS304', shape: 'cylinder', mass_kg: 2.5, dims_m: [0.08, 0.2], count: 4, parent: 'bus structure' },
  { name: 'propellant tank', material: 'Ti6Al4V', shape: 'sphere', mass_kg: 5, dims_m: [0.4], count: 1, parent: 'bus structure' },
  { name: 'battery pack', material: 'Copper', shape: 'box', mass_kg: 8, dims_m: [0.3, 0.2, 0.15], count: 1, parent: 'bus structure' },
  { name: 'avionics box', material: 'Al6061', shape: 'box', mass_kg: 4, dims_m: [0.3, 0.25, 0.1], count: 3, parent: 'bus structure' },
];

type Model = { id: string; name: string; parts: ArchetypePart[]; confidence: string; fallback: boolean; why: string };

function parseParts(json: string): ArchetypePart[] | null {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) && v.length ? (v as ArchetypePart[]) : null;
  } catch {
    return null;
  }
}

/** Archetype for the selected object: the one its forecast used, else its profile's match, else generic. */
function useModel(obj: TrackedObject | undefined, debris: DebrisResult | null): Model | null {
  const [archetypes] = useTable(tables.archetype);
  const [profiles] = useTable(tables.satelliteProfile);
  return useMemo(() => {
    if (!obj) return null;
    const profile = profiles.find(p => p.noradId === obj.noradId);
    const wanted = debris?.source === 'live' ? debris.archetype : profile?.archetypeId;
    const row = wanted ? archetypes.find(a => a.id === wanted) : undefined;
    const parts = row ? parseParts(row.components) : null;
    if (row && parts && row.id !== 'generic') {
      const why = debris?.source === 'live' ? 'model used by this forecast' : profile?.matchReason || 'matched profile';
      return { id: row.id, name: row.name, parts, confidence: row.confidence, fallback: false, why };
    }
    const generic = archetypes.find(a => a.id === 'generic');
    // The forecast ran with the generic model, but the object has since been matched to a better one.
    const better = debris?.source === 'live' && profile?.archetypeId && profile.archetypeId !== 'generic'
      ? archetypes.find(a => a.id === profile.archetypeId)
      : undefined;
    return {
      id: 'generic',
      name: generic?.name ?? 'Generic small LEO satellite (fallback)',
      parts: (generic && parseParts(generic.components)) || GENERIC_PARTS,
      confidence: generic?.confidence ?? 'low',
      fallback: true,
      why: better
        ? `this forecast ran with the generic model; the next one will use "${better.name}"`
        : 'no specific model for this object: generic small-satellite assumption',
    };
  }, [obj?.noradId, debris?.source, debris?.archetype, archetypes, profiles]);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function SatModelPanel({ objects, debris }: { objects: TrackedObject[]; debris: DebrisResult | null }) {
  const selected = useSelected();
  const obj = objects.find(o => o.id === selected);
  const model = useModel(obj, debris);
  const focus = focusedPart.use();
  const globeTip = hovered.use();
  const wide = () => !window.matchMedia?.(NARROW).matches; // phones: start collapsed, the globe comes first
  const [open, setOpen] = useState(wide);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<SceneHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const layout = useMemo(() => (model ? layoutParts(model.parts) : null), [model]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // New object: clear the focus and reopen the panel (wide screens).
  useEffect(() => {
    focusedPart.set(null);
    setOpen(wide());
  }, [selected]);
  useEffect(() => () => focusedPart.set(null), []);

  // three.js loads on first open (its own chunk).
  const show = open && !!model;
  useEffect(() => {
    if (!show || !canvas.current) return;
    let handle: SceneHandle | null = null;
    let dead = false;
    import('./satModelScene.ts')
      .then(({ createScene }) => {
        if (dead || !canvas.current) return;
        handle = createScene(canvas.current, {
          onHover: part => {
            const f = focusedPart.get();
            if (!f?.pinned) focusedPart.set(part ? { name: part, pinned: false } : null);
          },
          onClick: part => {
            const f = focusedPart.get();
            focusedPart.set(part && !(f?.pinned && f.name === part) ? { name: part, pinned: true } : null);
          },
        });
        scene.current = handle;
        if (layoutRef.current) handle.setPieces(layoutRef.current.pieces);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    return () => {
      dead = true;
      handle?.dispose();
      scene.current = null;
    };
  }, [show]);

  useEffect(() => {
    if (layout) scene.current?.setPieces(layout.pieces);
  }, [layout]);

  // A pinned globe line/zone lights its part here too.
  const lit = focus?.name ?? globeTip?.info.component?.name ?? null;
  useEffect(() => {
    scene.current?.setFocus(lit);
  });

  if (!obj || !model) return null;
  const byName = new Map((debris?.components ?? []).map(c => [c.name, c]));
  const tag = debris?.source === 'live' ? <span className="muted">modeled estimate</span> : <span className="mock">MOCK</span>;
  const setHover = (name: string | null) => {
    if (!focusedPart.get()?.pinned) focusedPart.set(name ? { name, pinned: false } : null);
  };

  return (
    <div className={`sat-model${open ? '' : ' closed'}`}>
      <div className="sat-model-head">
        <b>Model</b> <span className="muted">{model.name}</span>
        <button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse model viewer' : 'Open model viewer'}>
          {open ? '–' : '+'}
        </button>
      </div>
      {open && (
        <>
          <div className={model.fallback ? 'sat-model-note warn' : 'sat-model-note muted'}>
            {model.why} · confidence {model.confidence}
          </div>
          <canvas ref={canvas} className="sat-model-canvas" onPointerLeave={() => setHover(null)} />
          {failed && <div className="muted">3D view failed to load; the parts list still works.</div>}
          <div className="muted small">schematic: part sizes from the archetype, positions assumed · drag to rotate, scroll to zoom</div>
          <ul className="sat-model-parts" onMouseLeave={() => setHover(null)}>
            {model.parts.map(p => {
              const c = byName.get(p.name);
              const active = lit === p.name;
              return (
                <li
                  key={p.name}
                  className={`${active ? 'active' : ''}${focus?.pinned && focus.name === p.name ? ' pinned' : ''}`}
                  onMouseEnter={() => setHover(p.name)}
                  onClick={() => focusedPart.set(focus?.pinned && focus.name === p.name ? null : { name: p.name, pinned: true })}
                >
                  <span className="swatch" style={{ background: MATERIAL_COLOR[p.material] ?? OTHER_MATERIAL_COLOR }} />
                  <span className="name">
                    {p.name}
                    {p.count > 1 ? ` ×${p.count}` : ''}
                  </span>
                  <span className="muted">{p.material}</span>
                  <span className="stat">
                    {!c ? <span className="muted">not in this forecast</span> : c.p_survive <= 0 ? <span className="muted">burns up</span> : <>lands {pct(c.p_survive)}{c.p_hazard != null && <> · <span className="danger">dangerous {pct(c.p_hazard)}</span></>}</>}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="muted small">
            Hover a part to show only its debris on the globe; click to pin. {debris && tag}
            {focus?.pinned && (
              <button type="button" className="link" onClick={() => focusedPart.set(null)}>
                show all parts
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
