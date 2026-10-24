// One place for Cesium-wide setup. No Cesium ion account: imagery is the
// Natural Earth II texture that ships with Cesium (works offline), and nothing
// requests ion assets (no terrain, no geocoder, no Bing imagery).
import {
  buildModuleUrl,
  ClockRange,
  ImageryLayer,
  JulianDate,
  TileMapServiceImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

export function createViewer(container: HTMLElement): Viewer {
  const viewer = new Viewer(container, {
    baseLayer: ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'))
    ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: true,
    sceneModePicker: true,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    animation: true,
    timeline: true,
    shouldAnimate: true,
  });

  // Real time by default; the timeline spans the next few days, where the
  // re-entries we forecast happen. Users can scrub or speed it up.
  const now = JulianDate.now();
  const clock = viewer.clock;
  clock.startTime = JulianDate.addHours(now, -1, new JulianDate());
  clock.stopTime = JulianDate.addDays(now, 4, new JulianDate());
  clock.currentTime = now.clone();
  clock.clockRange = ClockRange.UNBOUNDED;
  clock.multiplier = 1;
  viewer.timeline.zoomTo(clock.startTime, clock.stopTime);

  const scene = viewer.scene;
  scene.globe.enableLighting = true; // day/night shading follows the clock
  scene.globe.showGroundAtmosphere = true;
  return viewer;
}

/** Back to wall-clock time at normal speed. */
export function resetClock(viewer: Viewer): void {
  viewer.clock.currentTime = JulianDate.now();
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;
}
