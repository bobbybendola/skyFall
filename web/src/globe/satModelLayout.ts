// Satellite model viewer: turns an archetype's parts list (data/archetypes/*.json)
// into simple 3D pieces. Sizes, shapes and counts come from the archetype; where
// each part sits is ASSUMED (archetypes do not record positions), so the viewer
// labels the result a schematic. Units: metres, z up.

export type ArchetypePart = {
  name: string;
  material: string;
  shape: string; // box | plate | cylinder | sphere
  mass_kg: number;
  dims_m: number[]; // box/plate [x, y, z]; cylinder [length, diameter]; sphere [diameter]
  count: number;
  parent: string | null;
};

export type Vec3 = [number, number, number];

/** One drawn copy of a part. Cylinders run along z. */
export type Piece = { part: string; copy: number; material: string; shape: 'box' | 'cylinder' | 'sphere'; size: Vec3; pos: Vec3; translucent: boolean };

const GAP = 0.03;
const MIN_THICK = 0.02; // thin plates still get a visible edge
const BOOM = 0.35; // gap between the bus and a solar wing

function sizeOf(p: ArchetypePart): { shape: Piece['shape']; size: Vec3 } {
  const d = (p.dims_m ?? []).map(x => (Number.isFinite(x) && x > 0 ? x : 0));
  const or = (x: number | undefined, f: number) => (x && x > 0 ? x : f);
  if (p.shape === 'sphere') {
    const D = or(d[0], 0.3);
    return { shape: 'sphere', size: [D, D, D] };
  }
  if (p.shape === 'cylinder') {
    const L = or(d[0], 0.3);
    const D = or(d[1], 0.3);
    return { shape: 'cylinder', size: [D, D, L] };
  }
  return { shape: 'box', size: [or(d[0], 0.3), or(d[1], 0.3), Math.max(MIN_THICK, or(d[2], 0.3))] };
}

const isWing = (p: ArchetypePart) => p.shape === 'plate' && /solar/i.test(p.name);
const totalMass = (p: ArchetypePart) => (p.mass_kg || 0) * Math.max(1, p.count || 1);

/** Shelf-pack rectangles (w x d) into rows no wider than `maxW`; returns centre offsets around (0, 0). */
export function shelfPack(items: [number, number][], maxW: number, gap = GAP): [number, number][] {
  const out: [number, number][] = [];
  const rows: { idx: number[]; w: number; d: number }[] = [];
  let row = { idx: [] as number[], w: 0, d: 0 };
  items.forEach(([w, d], i) => {
    if (row.idx.length && row.w + gap + w > maxW) {
      rows.push(row);
      row = { idx: [], w: 0, d: 0 };
    }
    row.w += (row.idx.length ? gap : 0) + w;
    row.d = Math.max(row.d, d);
    row.idx.push(i);
  });
  if (row.idx.length) rows.push(row);
  const depth = rows.reduce((s, r) => s + r.d, 0) + gap * Math.max(0, rows.length - 1);
  let y = -depth / 2;
  for (const r of rows) {
    let x = -r.w / 2;
    for (const i of r.idx) {
      const [w] = items[i];
      out[i] = [x + w / 2, y + r.d / 2];
      x += w + gap;
    }
    y += r.d + gap;
  }
  return out;
}

type Box = { min: Vec3; max: Vec3 };
const boxOf = (p: Piece): Box => ({
  min: [p.pos[0] - p.size[0] / 2, p.pos[1] - p.size[1] / 2, p.pos[2] - p.size[2] / 2],
  max: [p.pos[0] + p.size[0] / 2, p.pos[1] + p.size[1] / 2, p.pos[2] + p.size[2] / 2],
});
function union(boxes: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], b.min[k]);
    max[k] = Math.max(max[k], b.max[k]);
  }
  return { min, max };
}

/** Lay out every copy of every part. Deterministic for a given parts list. */
export function layoutParts(parts: ArchetypePart[]): { pieces: Piece[]; bounds: Box } {
  const pieces: Piece[] = [];
  if (!parts.length) return { pieces, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  const names = new Set(parts.map(p => p.name));
  const rootsFound = parts.filter(p => !p.parent || !names.has(p.parent) || p.parent === p.name);
  const roots = rootsFound.length ? rootsFound : [parts[0]]; // a parent loop: start anywhere
  const copies = (p: ArchetypePart) => Math.max(1, Math.min(64, Math.round(p.count || 1)));
  const add = (p: ArchetypePart, copy: number, pos: Vec3, size?: Vec3) => {
    const s = sizeOf(p);
    const piece: Piece = { part: p.name, copy, material: p.material, shape: s.shape, size: size ?? s.size, pos, translucent: false };
    pieces.push(piece);
    return piece;
  };
  const groupBox = (name: string) => union(pieces.filter(q => q.part === name).map(boxOf));

  // 1. Core: the heaviest root that is not a solar wing. Several plate copies stack into a flat bus.
  const nonWing = roots.filter(p => !isWing(p));
  const core = [...(nonWing.length ? nonWing : roots)].sort((a, b) => totalMass(b) - totalMass(a))[0];
  {
    const s = sizeOf(core).size;
    const n = copies(core);
    const stack = core.shape === 'plate' || s[2] < Math.min(s[0], s[1]) / 2;
    for (let i = 0; i < n; i++) {
      const off = i - (n - 1) / 2;
      add(core, i, stack ? [0, 0, off * (s[2] + GAP)] : [off * (s[0] + GAP), 0, 0]);
    }
  }
  let coreBox = groupBox(core.name);

  // 2. Other roots: big flat ones (an interstage ring) on top; the rest hang below in a packed grid.
  const others = roots.filter(p => p !== core && !isWing(p));
  const below: { p: ArchetypePart; copy: number; size: Vec3 }[] = [];
  const coreW = coreBox.max[0] - coreBox.min[0];
  const coreD = coreBox.max[1] - coreBox.min[1];
  let topZ = coreBox.max[2];
  for (const p of others) {
    const s = sizeOf(p).size;
    const wide = s[0] * s[1] >= 0.5 * coreW * coreD && s[2] < Math.max(s[0], s[1]);
    for (let i = 0; i < copies(p); i++) {
      if (wide) {
        add(p, i, [0, 0, topZ + GAP + s[2] / 2]);
        topZ += GAP + s[2];
      } else below.push({ p, copy: i, size: s });
    }
  }
  if (below.length) {
    const offs = shelfPack(below.map(b => [b.size[0], b.size[1]]), Math.max(coreW, ...below.map(b => b.size[0])));
    below.forEach((b, i) => add(b.p, b.copy, [offs[i][0], offs[i][1], coreBox.min[2] - GAP - b.size[2] / 2]));
  }

  // 3. Solar wings: long side along x, out from the bus on a short boom, alternating +x / -x.
  coreBox = groupBox(core.name);
  const zMid = (coreBox.min[2] + coreBox.max[2]) / 2;
  let reach = { '1': coreBox.max[0], '-1': coreBox.min[0] };
  let k = 0;
  for (const p of roots.filter(isWing)) {
    const s = sizeOf(p).size;
    const size: Vec3 = [Math.max(s[0], s[1]), Math.min(s[0], s[1]), s[2]];
    for (let i = 0; i < copies(p); i++, k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const edge = reach[side === 1 ? '1' : '-1'];
      const x = edge + side * (BOOM + size[0] / 2);
      add(p, i, [x, 0, zMid], size);
      reach = { ...reach, [side === 1 ? '1' : '-1']: x + (side * size[0]) / 2 };
    }
  }

  // 4. Children, parents first: inside the parent when they fit (the parent is drawn see-through),
  //    otherwise packed on its top face.
  const placed = new Set(roots.map(p => p.name));
  for (let pass = 0; pass < parts.length; pass++) {
    const ready = parts.filter(p => !placed.has(p.name) && p.parent && placed.has(p.parent));
    if (!ready.length) break;
    const byParent = new Map<string, ArchetypePart[]>();
    for (const p of ready) byParent.set(p.parent!, [...(byParent.get(p.parent!) ?? []), p]);
    for (const [parentName, kids] of byParent) {
      const pb = groupBox(parentName);
      const items = kids.flatMap(p => Array.from({ length: copies(p) }, (_, i) => ({ p, copy: i, size: sizeOf(p).size })));
      const w = pb.max[0] - pb.min[0];
      const d = pb.max[1] - pb.min[1];
      const h = pb.max[2] - pb.min[2];
      const offs = shelfPack(items.map(it => [it.size[0], it.size[1]]), Math.max(w * 0.92, ...items.map(it => it.size[0])));
      const tall = Math.max(...items.map(it => it.size[2]));
      const packedD = Math.max(...offs.map((o, i) => Math.abs(o[1]) + items[i].size[1] / 2)) * 2;
      const inside = tall < h * 0.9 && packedD <= d;
      const cx = (pb.min[0] + pb.max[0]) / 2;
      const cy = (pb.min[1] + pb.max[1]) / 2;
      items.forEach((it, i) => {
        const z = inside ? (pb.min[2] + pb.max[2]) / 2 : pb.max[2] + GAP + it.size[2] / 2;
        add(it.p, it.copy, [cx + offs[i][0], cy + offs[i][1], z]);
      });
      if (inside) for (const q of pieces) if (q.part === parentName) q.translucent = true;
      for (const p of kids) placed.add(p.name);
    }
  }
  return { pieces, bounds: union(pieces.map(boxOf)) };
}
