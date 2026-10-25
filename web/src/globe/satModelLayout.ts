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

/** Face-sized plates on a single box parent (CubeSat body panels) are mounted flush on its
 * four side faces instead of packed on top. Match tolerance on the panel's two big dims. */
const FACE_FIT = 0.15;

/** Mount plate children flush on the side faces of a lone box parent; returns the parts
 * (and copies) that did not fit a face. */
function mountOnFaces(
  parent: Piece,
  items: Item[],
  add: (p: ArchetypePart, copy: number, pos: Vec3, size?: Vec3) => Piece
): Item[] {
  const [px, py, pz] = parent.size;
  // +x, -x, +y, -y; in-plane dims of each face are (other horizontal axis, z).
  const faces = [
    { axis: 0, sign: 1, w: py },
    { axis: 0, sign: -1, w: py },
    { axis: 1, sign: 1, w: px },
    { axis: 1, sign: -1, w: px },
  ];
  const fits = (a: number, b: number) => Math.abs(a - b) <= FACE_FIT * Math.max(a, b);
  const rest: typeof items = [];
  let next = 0;
  for (const it of items) {
    const raw = it.p.dims_m ?? [];
    const flat = it.p.shape === 'plate' && raw.length >= 2;
    const big = Math.max(raw[0] ?? 0, raw[1] ?? 0);
    const small = Math.min(raw[0] ?? 0, raw[1] ?? 0);
    const face = faces[next];
    if (!flat || !face || !fits(big, pz) || !fits(small, face.w)) {
      rest.push(it);
      continue;
    }
    next++;
    const t = Math.max(MIN_THICK / 2, raw[2] ?? MIN_THICK);
    const size: Vec3 = face.axis === 0 ? [t, small, big] : [small, t, big];
    const pos: Vec3 = [...parent.pos];
    pos[face.axis] += face.sign * (parent.size[face.axis] / 2 + t / 2);
    add(it.p, it.copy, pos, size);
  }
  return rest;
}

/** Axial layouts: a docking port goes on the parent's top end and an engine on its bottom
 * end, when that end is the end of the whole stack. Returns the items left over. */
function mountOnEnds(
  parent: Piece,
  items: Item[],
  pieces: Piece[],
  add: (p: ArchetypePart, copy: number, pos: Vec3, size?: Vec3) => Piece
): Item[] {
  const top = Math.max(...pieces.map(q => q.pos[2] + q.size[2] / 2));
  const bottom = Math.min(...pieces.map(q => q.pos[2] - q.size[2] / 2));
  const eps = 1e-6;
  let up = parent.pos[2] + parent.size[2] / 2;
  let down = parent.pos[2] - parent.size[2] / 2;
  const atTop = up >= top - eps;
  const atBottom = down <= bottom + eps;
  const rest: Item[] = [];
  for (const it of items) {
    const cyl = it.p.shape === 'cylinder';
    if (cyl && atTop && FORE.test(it.p.name) && it.copy === 0) {
      add(it.p, it.copy, [parent.pos[0], parent.pos[1], up + GAP + it.size[2] / 2]);
      up += GAP + it.size[2];
    } else if (cyl && atBottom && AFT.test(it.p.name) && it.copy === 0) {
      add(it.p, it.copy, [parent.pos[0], parent.pos[1], down - GAP - it.size[2] / 2]);
      down -= GAP + it.size[2];
    } else rest.push(it);
  }
  return rest;
}

const STACK_GAP = 0.003;
const STACK_MIN_THICK = 0.004;
type Item = { p: ArchetypePart; copy: number; size: Vec3 };

/** Fallback for a tall, narrow parent (a CubeSat frame): stack the children in layers
 * inside it, like a board stack. Thin plates use their own thickness here. Returns
 * null when they do not fit. */
function stackLayers(items: Item[], w: number, d: number, h: number) {
  const maxW = w * 0.92;
  const maxD = d * 0.92;
  const sized = items.map(it => {
    const raw = it.p.dims_m?.[2];
    const thin = it.p.shape === 'plate' && raw && raw > 0 ? Math.max(STACK_MIN_THICK, raw) : it.size[2];
    return { ...it, size: [it.size[0], it.size[1], thin] as Vec3 };
  });
  if (sized.some(it => it.size[0] > maxW || it.size[1] > maxD)) return null;
  const list: { items: Item[]; offs: [number, number][]; height: number }[] = [];
  for (const it of sized) {
    const cur = list[list.length - 1];
    if (cur) {
      const trial = [...cur.items, it];
      const offs = shelfPack(trial.map(t => [t.size[0], t.size[1]]), maxW, STACK_GAP);
      const depth = Math.max(...offs.map((o, i) => Math.abs(o[1]) + trial[i].size[1] / 2)) * 2;
      if (depth <= maxD) {
        cur.items = trial;
        cur.offs = offs;
        cur.height = Math.max(cur.height, it.size[2]);
        continue;
      }
    }
    list.push({ items: [it], offs: [[0, 0]], height: it.size[2] });
  }
  const total = list.reduce((a, l) => a + l.height, 0) + STACK_GAP * (list.length - 1);
  return total <= h * 0.95 ? { list, total } : null;
}

const isWing = (p: ArchetypePart) => p.shape === 'plate' && /solar/i.test(p.name);
// Axial (stage / cargo vehicle) layout: parts that sit at the ends of the stack.
const AFT = /engine|nozzle|thruster/i;
const FORE = /dock|hatch|probe/i;
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
  const others = roots.filter(p => p !== core && !isWing(p));
  // A cylinder core with cylinder / ring neighbours (a rocket stage, a cargo vehicle) is
  // stacked end to end along z: rings on top, then modules in list order, engines last.
  const isRing = (p: ArchetypePart) => {
    const s = sizeOf(p).size;
    return p.shape !== 'cylinder' && p.shape !== 'sphere' && s[2] < Math.min(s[0], s[1]) / 2;
  };
  const axial = core.shape === 'cylinder' && others.length > 0 && others.every(p => p.shape === 'cylinder' || isRing(p));
  if (axial) {
    const rank = (p: ArchetypePart) => (isRing(p) ? 0 : AFT.test(p.name) ? 2 : 1);
    const order = [core, ...others].sort((a, b) => rank(a) - rank(b) || parts.indexOf(a) - parts.indexOf(b));
    let z = 0;
    for (const p of order) {
      const s = sizeOf(p).size;
      for (let i = 0; i < copies(p); i++) {
        const piece = add(p, i, [0, 0, z - s[2] / 2]);
        // A flat box on a round stack is an interstage ring: draw it round (drawing only).
        if (isRing(p)) {
          const D = Math.max(s[0], s[1]);
          piece.shape = 'cylinder';
          piece.size = [D, D, s[2]];
        }
        z -= s[2] + GAP;
      }
    }
  } else {
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
  const below: { p: ArchetypePart; copy: number; size: Vec3 }[] = [];
  const coreW = coreBox.max[0] - coreBox.min[0];
  const coreD = coreBox.max[1] - coreBox.min[1];
  let topZ = coreBox.max[2];
  for (const p of axial ? [] : others) {
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
  //    On an axial stack they go on the aft-most module that is not an engine (the service module).
  const wingHost = axial ? [core, ...others].filter(p => p.shape === 'cylinder' && !AFT.test(p.name)).sort((a, b) => groupBox(a.name).min[2] - groupBox(b.name).min[2])[0] ?? core : core;
  coreBox = groupBox(wingHost.name);
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
      let items = kids.flatMap(p => Array.from({ length: copies(p) }, (_, i) => ({ p, copy: i, size: sizeOf(p).size })));
      const parentPieces = pieces.filter(q => q.part === parentName);
      if (parentPieces.length === 1 && parentPieces[0].shape === 'box') items = mountOnFaces(parentPieces[0], items, add);
      if (axial && parentPieces.length === 1) items = mountOnEnds(parentPieces[0], items, pieces, add);
      for (const p of kids) placed.add(p.name);
      if (!items.length) continue;
      const pb = groupBox(parentName);
      const w = pb.max[0] - pb.min[0];
      const d = pb.max[1] - pb.min[1];
      const h = pb.max[2] - pb.min[2];
      const offs = shelfPack(items.map(it => [it.size[0], it.size[1]]), Math.max(w * 0.92, ...items.map(it => it.size[0])));
      const tall = Math.max(...items.map(it => it.size[2]));
      const packedD = Math.max(...offs.map((o, i) => Math.abs(o[1]) + items[i].size[1] / 2)) * 2;
      const inside = tall < h * 0.9 && packedD <= d;
      const cx = (pb.min[0] + pb.max[0]) / 2;
      const cy = (pb.min[1] + pb.max[1]) / 2;
      if (!inside) {
        const layers = stackLayers(items, w, d, h);
        if (layers) {
          let z = pb.min[2] + (h - layers.total) / 2;
          for (const layer of layers.list) {
            layer.items.forEach((it, i) => add(it.p, it.copy, [cx + layer.offs[i][0], cy + layer.offs[i][1], z + layer.height / 2], it.size));
            z += layer.height + STACK_GAP;
          }
          for (const q of pieces) if (q.part === parentName) q.translucent = true;
          continue;
        }
      }
      if (!inside && axial) {
        // Neighbouring modules sit above and below, so put what does not fit around the parent.
        const R = Math.max(w, d) / 2;
        const zc = (pb.min[2] + pb.max[2]) / 2;
        items.forEach((it, i) => {
          const a = (2 * Math.PI * i) / items.length;
          const r = R + GAP + Math.max(it.size[0], it.size[1]) / 2;
          add(it.p, it.copy, [cx + r * Math.cos(a), cy + r * Math.sin(a), zc]);
        });
        continue;
      }
      items.forEach((it, i) => {
        const z = inside ? (pb.min[2] + pb.max[2]) / 2 : pb.max[2] + GAP + it.size[2] / 2;
        add(it.p, it.copy, [cx + offs[i][0], cy + offs[i][1], z]);
      });
      if (inside) for (const q of pieces) if (q.part === parentName) q.translucent = true;
    }
  }
  return { pieces, bounds: union(pieces.map(boxOf)) };
}
