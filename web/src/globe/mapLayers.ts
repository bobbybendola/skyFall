// Detailed map: Esri World Imagery (about 1 m per pixel in most cities) with
// place-name labels, and Esri World Elevation terrain. Keyless; nothing here
// sends a token. The Natural Earth II texture that ships with Cesium stays as
// the bottom layer, so the globe still draws offline or if Esri is unreachable.
import {
  ArcGISTiledElevationTerrainProvider,
  buildModuleUrl,
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
// globe has a hole at each pole. Sea-level caps fill them with a low-resolution
// polar strip cut from the Natural Earth II tiles that ship with Cesium (level 2:
// 8 x 4 tiles of 256 px, about 0.18° per pixel). Plain ice colors show until
// those load, or if they fail to.
const MERCATOR_MAX_LAT = 85.0511;
const ARCTIC_CAP_COLOR = Color.fromCssColorString('#a9b9c6');
const ANTARCTIC_CAP_COLOR = Color.fromCssColorString('#dfe7ee');
const NE_LEVEL = 2;
const NE_TILES_X = 8; // at NE_LEVEL; rows: y = 0 is the south row, y = 3 the north row
const NE_TILE_PX = 256;
const NE_DEG_PER_PX = 180 / (4 * NE_TILE_PX);
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
    Promise.all([polarStrip('north'), polarStrip('south')])
      .then(([north, south]) => {
        if (cancelled || viewer.isDestroyed()) return;
        for (const c of caps) viewer.scene.primitives.remove(c);
        caps = [
          viewer.scene.primitives.add(polarCap(MERCATOR_MAX_LAT, 90, imageMaterial(north))) as Primitive,
          viewer.scene.primitives.add(polarCap(-90, -MERCATOR_MAX_LAT, imageMaterial(south))) as Primitive,
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
const imageMaterial = (image: HTMLCanvasElement) => Material.fromType('Image', { image });

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** Equirectangular strip from the pole to MERCATOR_MAX_LAT, all longitudes, pole at the top for north and at the bottom for south. */
async function polarStrip(pole: 'north' | 'south'): Promise<HTMLCanvasElement> {
  const rows = Math.ceil((90 - MERCATOR_MAX_LAT) / NE_DEG_PER_PX);
  const y = pole === 'north' ? 3 : 0;
  const tiles = await Promise.all(
    Array.from({ length: NE_TILES_X }, (_, x) => loadImage(buildModuleUrl(`Assets/Textures/NaturalEarthII/${NE_LEVEL}/${x}/${y}.jpg`)))
  );
  const canvas = document.createElement('canvas');
  canvas.width = NE_TILES_X * NE_TILE_PX;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  const srcY = pole === 'north' ? 0 : NE_TILE_PX - rows;
  tiles.forEach((img, x) => ctx.drawImage(img, 0, srcY, NE_TILE_PX, rows, x * NE_TILE_PX, 0, NE_TILE_PX, rows));
  return canvas;
}

/** Sea-level fill for one polar hole, lit by the sun like the globe. */
function polarCap(south: number, north: number, material: Material): Primitive {
  return new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new RectangleGeometry({
        rectangle: Rectangle.fromDegrees(-180, south, 180, north),
        vertexFormat: EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        granularity: CesiumMath.toRadians(0.5),
      }),
    }),
    appearance: new EllipsoidSurfaceAppearance({ material, aboveGround: false }),
    asynchronous: false,
  });
}

function removeLayer(viewer: Viewer, layer: ImageryLayer): void {
  if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
}
