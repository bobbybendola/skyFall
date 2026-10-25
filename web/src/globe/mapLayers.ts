// Detailed map: Esri World Imagery (about 1 m per pixel in most cities) with
// place-name labels, and Esri World Elevation terrain. Keyless; nothing here
// sends a token. The Natural Earth II texture that ships with Cesium stays as
// the bottom layer, so the globe still draws offline or if Esri is unreachable.
import {
  ArcGISTiledElevationTerrainProvider,
  Cartesian2,
  Math as CesiumMath,
  Color,
  Credit,
  EllipsoidSurfaceAppearance,
  EllipsoidTerrainProvider,
  GeometryInstance,
  ImageryLayer,
  Material,
  Primitive,
  Rectangle,
  RectangleGeometry,
  UrlTemplateImageryProvider,
  type Viewer,
} from 'cesium';
import { useEffect } from 'react';
import { store } from './debrisPick.ts';

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
const IMAGERY_URL = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const LABELS_URL = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
const TERRAIN_URL = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
// Esri terrain uses Web Mercator tiles, which stop at about 85.05° N/S, so the
// globe has a hole at each pole. Sea-level caps fill them with Esri's own colors
// along that edge, smoothly interpolated toward the pole. Plain ice colors show
// until those load, or if they fail to.
const MERCATOR_MAX_LAT = 85.0511;
const ARCTIC_CAP_COLOR = Color.fromCssColorString('#a9b9c6');
const ANTARCTIC_CAP_COLOR = Color.fromCssColorString('#dfe7ee');
const ESRI_TILES_X = 8; // at zoom 3
const ESRI_TILE_PX = 256;
const EDGE_ROWS = 3; // Esri rows averaged along the seam
const FILL_ROWS = 64; // pole-to-seam resolution of the fill
const CREDIT = 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Elevation: Esri';

/** Toggle: detailed imagery + terrain (online) or the basic offline globe. Default on. */
export const detailedMap = store(true);
/** Terrain relief multiplier (1 = true scale). */
export const reliefScale = store(1);

/** Adds or removes the Esri imagery, labels and terrain as the toggles change. */
export function useDetailedMap(viewer: Viewer | null): void {
  const on = detailedMap.use();
  const relief = reliefScale.use();

  useEffect(() => {
    if (!viewer || !on) return;
    const credit = new Credit(CREDIT);
    const imagery = viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: IMAGERY_URL, maximumLevel: 19, credit }),
      1 // right above the Natural Earth base, under any overlay (warning grid)
    );
    const labels = viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: LABELS_URL, maximumLevel: 19 }),
      2
    );
    let cancelled = false;
    let caps = [
      viewer.scene.primitives.add(polarCap(MERCATOR_MAX_LAT, 90, colorMaterial(ARCTIC_CAP_COLOR))) as Primitive,
      viewer.scene.primitives.add(polarCap(-90, -MERCATOR_MAX_LAT, colorMaterial(ANTARCTIC_CAP_COLOR))) as Primitive,
    ];
    Promise.all([polarFill('north'), polarFill('south')])
      .then(([north, south]) => {
        if (cancelled || viewer.isDestroyed()) return;
        for (const c of caps) viewer.scene.primitives.remove(c);
        caps = [
          viewer.scene.primitives.add(polarCap(MERCATOR_MAX_LAT, 90, globeShadedMaterial(viewer, north))) as Primitive,
          viewer.scene.primitives.add(polarCap(-90, -MERCATOR_MAX_LAT, globeShadedMaterial(viewer, south))) as Primitive,
        ];
      })
      .catch(err => console.warn('polar imagery unavailable, using plain caps:', err));
    ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL)
      .then(terrain => {
        if (!cancelled && !viewer.isDestroyed()) viewer.terrainProvider = terrain;
      })
      .catch(err => console.warn('terrain unavailable, staying on the smooth globe:', err));
    return () => {
      cancelled = true;
      if (viewer.isDestroyed()) return;
      removeLayer(viewer, imagery);
      removeLayer(viewer, labels);
      for (const c of caps) viewer.scene.primitives.remove(c);
      viewer.terrainProvider = new EllipsoidTerrainProvider();
    };
  }, [viewer, on]);

  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) viewer.scene.verticalExaggeration = relief;
  }, [viewer, relief]);
}

const colorMaterial = (color: Color) => Material.fromType('Color', { color });

/** The fill image, shaded the way Cesium shades the globe around it (GlobeFS.glsl,
 * non-HDR path): day/night lighting and the ground-atmosphere glow, both fading in
 * with camera distance. Without this the cap keeps one color while the surrounding
 * imagery brightens or darkens as the camera moves out. */
function globeShadedMaterial(viewer: Viewer, image: HTMLCanvasElement): Material {
  const globe = viewer.scene.globe;
  return new Material({
    fabric: {
      uniforms: {
        image,
        lightingFade: new Cartesian2(globe.lightingFadeOutDistance, globe.lightingFadeInDistance),
        nightFade: new Cartesian2(globe.nightFadeOutDistance, globe.nightFadeInDistance),
        lighting: globe.enableLighting ? 1 : 0,
        atmosphere: globe.showGroundAtmosphere ? 1 : 0,
      },
      source: CAP_SHADER,
    },
    translucent: false,
  });
}

const CAP_SHADER = /* glsl */ `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  vec3 color = texture(image, materialInput.st).rgb;
  vec3 positionWC = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
  vec3 normalWC = normalize(positionWC);
  vec3 normalEC = czm_viewRotation * normalWC;
  float cameraDist = length(czm_view[3]);
  float fade = clamp((cameraDist - lightingFade.x) / (lightingFade.y - lightingFade.x), 0.0, 1.0);
  vec3 lightDir = czm_lightDirectionWC;

  vec3 finalColor = color;
  if (lighting > 0.5) {
    float diffuse = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
    finalColor = color * czm_lightColor * mix(1.0, diffuse, fade);
  }
  if (atmosphere > 0.5) {
    vec3 rayleigh;
    vec3 mie;
    float opacity;
    czm_computeGroundAtmosphereScattering(positionWC, lightDir, rayleigh, mie, opacity);
    vec4 ground = czm_computeAtmosphereColor(positionWC, lightDir, rayleigh, mie, opacity);
    float transmittance = 0.5 + clamp(1.0 - ground.a, 0.0, 1.0);
    vec3 withAtmosphere = finalColor + ground.rgb * transmittance;
    if (lighting > 0.5) {
      float sunlit = clamp((cameraDist - nightFade.y) / (nightFade.x - nightFade.y), 0.05, 1.0);
      float darken = clamp(dot(normalWC, lightDir), 0.0, 1.0);
      withAtmosphere = mix(mix(ground.rgb, withAtmosphere, darken), withAtmosphere, sunlit);
    }
    withAtmosphere = vec3(1.0) - exp(-2.0 * withAtmosphere);
    finalColor = mix(finalColor, withAtmosphere, fade);
  }
  m.diffuse = finalColor;
  return m;
}
`;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Esri sends CORS headers; needed to read its pixels
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** Fill for one polar hole, pole at the top for north and at the bottom for south:
 * Esri's own colors along the 85° seam, blurred more and more toward the pole until
 * they meet in the seam's average color. Nothing but Esri's edge pixels is used, so
 * the seam matches whatever the imagery looks like there. */
async function polarFill(pole: 'north' | 'south'): Promise<HTMLCanvasElement> {
  const edge = await esriEdge(pole);
  const width = edge.length / 3;
  const mean = [0, 1, 2].map(c => edge.reduce((sum, v, i) => (i % 3 === c ? sum + v : sum), 0) / width);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = FILL_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  const img = ctx.createImageData(width, FILL_ROWS);
  for (let y = 0; y < FILL_ROWS; y++) {
    const f = (pole === 'north' ? FILL_ROWS - 1 - y : y) / (FILL_ROWS - 1); // 0 at the seam, 1 at the pole
    const blurred = boxBlurColumns(edge, width, Math.round(f * (width / 4)));
    const toMean = f * f;
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * width + x) * 4;
        img.data[i + c] = blurred[x * 3 + c] * (1 - toMean) + mean[c] * toMean;
        img.data[i + 3] = 255;
      }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Esri's average color per column along the 85° seam: the outermost rows of its
 * zoom-3 tiles (8 x 256 px across, 2048 columns from 180° W). */
async function esriEdge(pole: 'north' | 'south'): Promise<Float32Array> {
  const y = pole === 'north' ? 0 : 7;
  const tiles = await Promise.all(
    Array.from({ length: ESRI_TILES_X }, (_, x) => loadImage(IMAGERY_URL.replace('{z}', '3').replace('{y}', String(y)).replace('{x}', String(x))))
  );
  const canvas = document.createElement('canvas');
  canvas.width = ESRI_TILES_X * ESRI_TILE_PX;
  canvas.height = EDGE_ROWS;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D canvas');
  const srcY = pole === 'north' ? 0 : ESRI_TILE_PX - EDGE_ROWS;
  tiles.forEach((img, x) => ctx.drawImage(img, 0, srcY, ESRI_TILE_PX, EDGE_ROWS, x * ESRI_TILE_PX, 0, ESRI_TILE_PX, EDGE_ROWS));
  const px = ctx.getImageData(0, 0, canvas.width, EDGE_ROWS).data;
  const out = new Float32Array(canvas.width * 3);
  for (let x = 0; x < canvas.width; x++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let r = 0; r < EDGE_ROWS; r++) sum += px[(r * canvas.width + x) * 4 + c];
      out[x * 3 + c] = sum / EDGE_ROWS;
    }
  return out;
}

/** Box blur along columns (running sum), wrapping around the date line. */
function boxBlurColumns(cols: Float32Array, width: number, radius: number): Float32Array {
  if (radius < 1) return cols;
  const out = new Float32Array(cols.length);
  const n = 2 * radius + 1;
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += cols[(((k % width) + width) % width) * 3 + c];
    for (let x = 0; x < width; x++) {
      out[x * 3 + c] = sum / n;
      sum += cols[(((x + radius + 1) % width) + width) % width * 3 + c] - cols[(((x - radius) % width) + width) % width * 3 + c];
    }
  }
  return out;
}

/** Sea-level fill for one polar hole. */
function polarCap(south: number, north: number, material: Material): Primitive {
  return new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new RectangleGeometry({
        rectangle: Rectangle.fromDegrees(-180, south, 180, north),
        vertexFormat: EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        granularity: CesiumMath.toRadians(0.5),
      }),
    }),
    appearance: new EllipsoidSurfaceAppearance({ material, aboveGround: false, flat: true }), // the material does the lighting
    asynchronous: false,
  });
}

function removeLayer(viewer: Viewer, layer: ImageryLayer): void {
  if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
}
