import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Plain prototype basemap (OpenStreetMap raster tiles, attribution required).
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export type FC = GeoJSON.FeatureCollection;
export const emptyFC: FC = { type: 'FeatureCollection', features: [] };

export type MapData = {
  corridor?: FC; // polygons with property level (50 | 90)
  track?: FC; // lines
  marker?: FC; // the object's current point
  sightings?: FC; // points with property color, sim (bool)
  candidates?: FC; // points
  pick?: FC; // the phone's chosen point
};

const SOURCES: (keyof MapData)[] = ['corridor', 'track', 'marker', 'candidates', 'sightings', 'pick'];

function addLayers(map: maplibregl.Map): void {
  for (const s of SOURCES) map.addSource(s, { type: 'geojson', data: emptyFC });
  map.addLayer({
    id: 'corridor-90',
    type: 'fill',
    source: 'corridor',
    filter: ['==', ['get', 'level'], 90],
    paint: { 'fill-color': '#e4572e', 'fill-opacity': 0.18 },
  });
  map.addLayer({
    id: 'corridor-50',
    type: 'fill',
    source: 'corridor',
    filter: ['==', ['get', 'level'], 50],
    paint: { 'fill-color': '#e4572e', 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'corridor-line',
    type: 'line',
    source: 'corridor',
    paint: { 'line-color': '#b8361b', 'line-width': 1 },
  });
  map.addLayer({
    id: 'track',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#1f4e9c', 'line-width': 2, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'candidates',
    type: 'circle',
    source: 'candidates',
    paint: { 'circle-radius': 3, 'circle-color': '#7a3fb0', 'circle-opacity': 0.8 },
  });
  map.addLayer({
    id: 'sightings',
    type: 'circle',
    source: 'sightings',
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': ['case', ['get', 'sim'], 3, 1],
      'circle-stroke-color': ['case', ['get', 'sim'], '#ffffff', '#222222'],
    },
  });
  map.addLayer({
    id: 'marker',
    type: 'circle',
    source: 'marker',
    paint: { 'circle-radius': 8, 'circle-color': '#1f4e9c', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
  });
  map.addLayer({
    id: 'pick',
    type: 'circle',
    source: 'pick',
    paint: { 'circle-radius': 10, 'circle-color': '#ffcc00', 'circle-stroke-width': 2, 'circle-stroke-color': '#000' },
  });
}

export function MapView(props: {
  data: MapData;
  onClick?: (lon: number, lat: number) => void;
  onFeatureClick?: (layer: string, props: Record<string, unknown>) => void;
  center?: [number, number];
  zoom?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      center: props.center ?? [-100, 25],
      zoom: props.zoom ?? 1.6,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.on('load', () => {
      addLayers(map);
      ready.current = true;
      push(map, latest.current.data);
    });
    map.on('click', e => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['sightings', 'candidates'] });
      if (hits.length && latest.current.onFeatureClick) {
        latest.current.onFeatureClick(hits[0].layer.id, hits[0].properties ?? {});
        return;
      }
      latest.current.onClick?.(e.lngLat.lng, e.lngLat.lat);
    });
    return () => {
      ready.current = false;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mapRef.current && ready.current) push(mapRef.current, props.data);
  }, [props.data]);

  return <div ref={el} className="map" />;
}

function push(map: maplibregl.Map, data: MapData): void {
  for (const s of SOURCES) {
    const src = map.getSource(s) as maplibregl.GeoJSONSource | undefined;
    src?.setData(data[s] ?? emptyFC);
  }
}
