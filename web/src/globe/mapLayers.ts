// Detailed map: Esri World Imagery (about 1 m per pixel in most cities) with
// place-name labels, and Esri World Elevation terrain. Keyless; nothing here
// sends a token. The Natural Earth II texture that ships with Cesium stays as
// the bottom layer, so the globe still draws offline or if Esri is unreachable.
import {
  ArcGISTiledElevationTerrainProvider,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  UrlTemplateImageryProvider,
  type Viewer,
} from 'cesium';
import { useEffect } from 'react';
import { store } from './debrisPick.ts';

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
const IMAGERY_URL = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const LABELS_URL = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
const TERRAIN_URL = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
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
      viewer.terrainProvider = new EllipsoidTerrainProvider();
    };
  }, [viewer, on]);

  useEffect(() => {
    if (viewer && !viewer.isDestroyed()) viewer.scene.verticalExaggeration = relief;
  }, [viewer, relief]);
}

function removeLayer(viewer: Viewer, layer: ImageryLayer): void {
  if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
}
