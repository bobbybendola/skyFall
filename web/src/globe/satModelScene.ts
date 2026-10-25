// Satellite model viewer: the three.js side. Loaded on demand (dynamic import from
// SatModelPanel) so three.js stays out of the main bundle. Draws the pieces from
// satModelLayout, colored by material, with hover/click picking per part.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MATERIAL_COLOR, OTHER_MATERIAL_COLOR } from './debrisTypes.ts';
import type { Piece } from './satModelLayout.ts';

export type SceneHandle = {
  setPieces: (pieces: Piece[]) => void;
  setFocus: (part: string | null) => void;
  dispose: () => void;
};

type Callbacks = { onHover: (part: string | null) => void; onClick: (part: string | null) => void };

const DIM_OPACITY = 0.12;
const SHELL_OPACITY = 0.28; // a parent drawn see-through so the parts inside show

function baseColor(material: string): THREE.Color {
  // CFRP is black in the globe legend; lighter slate here so large CFRP parts (solar
  // arrays, instrument tubes) read against the dark panel instead of showing as outlines.
  return new THREE.Color(material === 'CFRP' ? '#7a8494' : (MATERIAL_COLOR[material] ?? OTHER_MATERIAL_COLOR));
}

function geometryFor(p: Piece): THREE.BufferGeometry {
  const [x, y, z] = p.size;
  if (p.shape === 'sphere') return new THREE.SphereGeometry(x / 2, 24, 16);
  if (p.shape === 'cylinder') return new THREE.CylinderGeometry(x / 2, x / 2, z, 24).rotateX(Math.PI / 2); // along z
  return new THREE.BoxGeometry(x, y, z);
}

export function createScene(canvas: HTMLCanvasElement, cb: Callbacks): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xdde8ff, 0x20242c, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, -6, 8);
  scene.add(sun);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.8;
  controls.addEventListener('start', () => (controls.autoRotate = false));

  const group = new THREE.Group();
  scene.add(group);
  let meshes: THREE.Mesh[] = [];
  let focus: string | null = null;
  let hoverPart: string | null = null;

  const style = () => {
    for (const m of meshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const part = m.userData.part as string;
      const lit = (focus ?? hoverPart) === part;
      const dim = focus !== null && focus !== part;
      mat.emissive.set(lit ? 0x4fa3ff : 0x000000);
      mat.emissiveIntensity = lit ? 0.6 : 0;
      mat.opacity = dim ? DIM_OPACITY : m.userData.translucent && !lit ? SHELL_OPACITY : 1;
      mat.transparent = mat.opacity < 1;
      mat.depthWrite = !mat.transparent;
      const edges = m.children[0] as THREE.LineSegments | undefined;
      if (edges) (edges.material as THREE.LineBasicMaterial).opacity = dim ? 0.08 : 0.5;
    }
  };

  const clear = () => {
    for (const m of meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      for (const c of m.children as THREE.LineSegments[]) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    group.clear();
    meshes = [];
  };

  const setPieces = (pieces: Piece[]) => {
    clear();
    for (const p of pieces) {
      const geo = geometryFor(p);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: baseColor(p.material), ...(p.material === 'CFRP' ? { metalness: 0.05, roughness: 0.8 } : { metalness: 0.35, roughness: 0.55 }) }));
      mesh.position.set(...p.pos);
      mesh.userData = { part: p.part, translucent: p.translucent };
      if (p.translucent) mesh.renderOrder = 1; // after the opaque parts inside it
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: p.material === 'CFRP' ? 0xc8ced8 : 0x0b0d10, transparent: true, opacity: 0.5 }));
      mesh.add(edges);
      group.add(mesh);
      meshes.push(mesh);
    }
    style();
    // Frame the whole model.
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.05, size.length() / 2); // small floor: CubeSats are ~0.3 m
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.1;
    camera.position.copy(centre).add(new THREE.Vector3(0.55, -0.75, 0.45).normalize().multiplyScalar(dist));
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls.target.copy(centre);
    controls.update();
  };

  // Picking: hover and click report the part name (null for empty space).
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const partAt = (e: PointerEvent): string | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // When a part is focused, the dimmed ones should not block picking it.
    const hit = ray.intersectObjects(meshes, false).find(h => !focus || h.object.userData.part === focus || ((h.object as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity > DIM_OPACITY);
    return (hit?.object.userData.part as string | undefined) ?? null;
  };
  let downAt: { x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return; // dragging the view
    const part = partAt(e);
    if (part === hoverPart) return;
    hoverPart = part;
    canvas.style.cursor = part ? 'pointer' : 'grab';
    style();
    cb.onHover(part);
  };
  const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
  const onUp = (e: PointerEvent) => {
    const click = downAt !== null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) <= 4; // not a drag
    downAt = null;
    if (click) cb.onClick(partAt(e));
  };
  const onLeave = () => {
    if (hoverPart === null) return;
    hoverPart = null;
    style();
    cb.onHover(null);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setPieces,
    setFocus: part => {
      focus = part;
      style();
    },
    dispose: () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      clear();
      renderer.dispose();
    },
  };
}
