import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NORTH_AMERICAN_PORTS } from '@bro/contracts';
import {
  BORDER_PORTS,
  CAMERA_PRESETS,
  COLOR_BRO_CRIMSON,
  COLOR_BRO_CYAN,
  COLOR_BRO_GOLD,
  CORRIDOR_ROUTES,
  GLOBE_RADIUS,
  HUB_BY_ID,
  HUB_LOCATIONS,
  VECTOR_EARTH_RADIUS,
  buildQuoteUrlForNode,
  getWaitTimeSeverity,
  latLonToVector3,
} from '../globeData';
import {
  createAtmosphereMaterial,
  createEarthCoreMaterial,
  createPulseRingMaterial,
  getSubsolarDirection,
} from '../earthShaders';
import { buildVectorEarth } from '../buildVectorEarth';

describe('globeData — spherical projection & logistics topology', () => {
  it('projects Equator / Prime Meridian (0°, 0°) to (+R, 0, 0)', () => {
    const v = latLonToVector3(0, 0, GLOBE_RADIUS);
    expect(v.x).toBeCloseTo(GLOBE_RADIUS, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(0, 6);
    expect(v.length()).toBeCloseTo(GLOBE_RADIUS, 6);
  });

  it('projects Equator / 90°W Americas (0°, -90°) to (0, 0, +R) facing default camera', () => {
    const v = latLonToVector3(0, -90, GLOBE_RADIUS);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(GLOBE_RADIUS, 6);
    expect(v.length()).toBeCloseTo(GLOBE_RADIUS, 6);
  });

  it('projects North and South Poles accurately onto the Y axis', () => {
    const north = latLonToVector3(90, 0, GLOBE_RADIUS);
    const south = latLonToVector3(-90, 45, GLOBE_RADIUS);

    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(GLOBE_RADIUS, 6);
    expect(north.z).toBeCloseTo(0, 6);

    expect(south.x).toBeCloseTo(0, 6);
    expect(south.y).toBeCloseTo(-GLOBE_RADIUS, 6);
    expect(south.z).toBeCloseTo(0, 6);
  });

  it('projects PEI HQ accurately onto sphere radius 50 in the North American hemisphere', () => {
    const pei = HUB_BY_ID.PEI;
    const vPei = latLonToVector3(pei.lat, pei.lon, GLOBE_RADIUS);
    const vVan = latLonToVector3(HUB_BY_ID.VANCOUVER.lat, HUB_BY_ID.VANCOUVER.lon, GLOBE_RADIUS);

    expect(vPei.length()).toBeCloseTo(GLOBE_RADIUS, 6);
    // Expected analytical spherical coordinates for (46.2507°N, -63.1375°W)
    const expectedY = GLOBE_RADIUS * Math.sin((pei.lat * Math.PI) / 180);
    expect(vPei.y).toBeCloseTo(expectedY, 6);
    expect(vPei.y).toBeGreaterThan(0);
    expect(vPei.z).toBeGreaterThan(0);
    // PEI is east of Vancouver -> higher X coordinate when viewing Americas from +Z
    expect(vPei.x).toBeGreaterThan(vVan.x);
  });

  it('preserves exact radius magnitude across all hubs, border ports, and arbitrary global coordinates', () => {
    const sampleCoords: Array<[number, number, number]> = [
      [0, 0, 1],
      [46.2507, -63.1375, 50],
      [49.2827, -123.1207, 50.08],
      [19.4326, -99.1332, 52.4],
      [-33.8688, 151.2093, 50],
      [35.6762, 139.6503, 50],
      [51.5072, -0.1276, 50],
      [-54.8019, -68.303, 50],
    ];

    for (const [lat, lon, r] of sampleCoords) {
      const vec = latLonToVector3(lat, lon, r);
      expect(Number.isFinite(vec.x)).toBe(true);
      expect(Number.isFinite(vec.y)).toBe(true);
      expect(Number.isFinite(vec.z)).toBe(true);
      expect(vec.length()).toBeCloseTo(r, 6);
    }
  });

  it('exports 21 unique hubs, 28 trade corridors, 13 contract-backed border ports, and 3 camera presets', () => {
    expect(HUB_LOCATIONS).toHaveLength(21);
    expect(new Set(HUB_LOCATIONS.map((h) => h.id)).size).toBe(21);
    expect(HUB_LOCATIONS.filter((h) => h.isHQ)).toHaveLength(1);
    expect(HUB_BY_ID.PEI.isHQ).toBe(true);

    expect(CORRIDOR_ROUTES).toHaveLength(28);
    for (const route of CORRIDOR_ROUTES) {
      expect(HUB_BY_ID[route.fromId]).toBe(route.from);
      expect(HUB_BY_ID[route.toId]).toBe(route.to);
    }

    expect(BORDER_PORTS).toHaveLength(NORTH_AMERICAN_PORTS.length);
    expect(BORDER_PORTS).toHaveLength(13);
    for (const port of BORDER_PORTS) {
      const contractPort = NORTH_AMERICAN_PORTS.find((p) => p.cbpCode === port.cbpCode);
      expect(contractPort).toBeDefined();
      expect(port.lat).toBe(contractPort?.lat);
      expect(port.lon).toBe(contractPort?.lon);
    }

    expect(CAMERA_PRESETS).toHaveLength(3);
  });

  it('maps border wait times to cyan (<15m), gold (15-45m), and crimson (>45m)', () => {
    expect(getWaitTimeSeverity(0)).toEqual({ colorHex: COLOR_BRO_CYAN, status: 'clear' });
    expect(getWaitTimeSeverity(14)).toEqual({ colorHex: COLOR_BRO_CYAN, status: 'clear' });
    expect(getWaitTimeSeverity(15)).toEqual({ colorHex: COLOR_BRO_GOLD, status: 'moderate' });
    expect(getWaitTimeSeverity(45)).toEqual({ colorHex: COLOR_BRO_GOLD, status: 'moderate' });
    expect(getWaitTimeSeverity(46)).toEqual({ colorHex: COLOR_BRO_CRIMSON, status: 'congested' });
    expect(getWaitTimeSeverity(null)).toEqual({ colorHex: COLOR_BRO_CYAN, status: 'unknown' });
  });

  it('builds valid /quote lane links for hubs and border ports', () => {
    const portUrl = buildQuoteUrlForNode(BORDER_PORTS[0]);
    expect(portUrl.startsWith('/quote?')).toBe(true);
    expect(portUrl).toContain(`port=${BORDER_PORTS[0].cbpCode}`);

    const hubUrl = buildQuoteUrlForNode(HUB_BY_ID.CHICAGO);
    expect(hubUrl.startsWith('/quote?')).toBe(true);
    expect(hubUrl).toContain('hub=CHICAGO');
  });
});

describe('earthShaders — UTC subsolar vector & custom shader factories', () => {
  it('returns unit-length subsolar vectors across all seasons and UTC hours', () => {
    const dates = [
      new Date('2026-03-21T12:00:00Z'),
      new Date('2026-06-21T18:00:00Z'),
      new Date('2026-09-22T00:00:00Z'),
      new Date('2026-12-21T06:00:00Z'),
      new Date(),
    ];

    for (const d of dates) {
      const sun = getSubsolarDirection(d);
      expect(Number.isFinite(sun.x)).toBe(true);
      expect(Number.isFinite(sun.y)).toBe(true);
      expect(Number.isFinite(sun.z)).toBe(true);
      expect(sun.length()).toBeCloseTo(1, 6);
    }
  });

  it('tracks real astronomical declination and solar noon longitude accurately', () => {
    // March equinox 12:00 UTC -> sun near (lat ~0°, lon ~0°) -> (+1, 0, 0)
    const equinoxNoon = getSubsolarDirection(new Date('2026-03-21T12:00:00Z'));
    expect(equinoxNoon.x).toBeGreaterThan(0.95);
    expect(Math.abs(equinoxNoon.y)).toBeLessThan(0.08);

    // March equinox 18:00 UTC -> sun near (lat ~0°, lon ~-90°) -> (0, 0, +1)
    const equinoxAmericas = getSubsolarDirection(new Date('2026-03-21T18:00:00Z'));
    expect(equinoxAmericas.z).toBeGreaterThan(0.95);

    // June solstice -> northern hemisphere declination (~+23.44° -> sin ≈ +0.398)
    const juneSolstice = getSubsolarDirection(new Date('2026-06-21T12:00:00Z'));
    expect(juneSolstice.y).toBeGreaterThan(0.35);

    // December solstice -> southern hemisphere declination (~-23.44° -> sin ≈ -0.398)
    const decSolstice = getSubsolarDirection(new Date('2026-12-21T12:00:00Z'));
    expect(decSolstice.y).toBeLessThan(-0.35);
  });

  it('creates earth core, BackSide additive atmosphere, and instanced pulse ring ShaderMaterials', () => {
    const coreMat = createEarthCoreMaterial();
    const atmoMat = createAtmosphereMaterial();
    const ringMat = createPulseRingMaterial();

    expect(coreMat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(coreMat.uniforms.uSunDir.value).toBeInstanceOf(THREE.Vector3);

    expect(atmoMat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(atmoMat.side).toBe(THREE.BackSide);
    expect(atmoMat.blending).toBe(THREE.AdditiveBlending);
    expect(atmoMat.transparent).toBe(true);
    expect(atmoMat.depthWrite).toBe(false);

    expect(ringMat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(ringMat.transparent).toBe(true);

    coreMat.dispose();
    atmoMat.dispose();
    ringMat.dispose();
  });
});

describe('buildVectorEarth — GPU LineSegments geometry integrity', () => {
  it('constructs non-empty, finite BufferGeometry arrays on radius 50.08 under 1 MB VRAM', () => {
    const earth = buildVectorEarth(VECTOR_EARTH_RADIUS);

    expect(earth.borders).toBeInstanceOf(THREE.LineSegments);
    expect(earth.graticule).toBeInstanceOf(THREE.LineSegments);

    const borderPos = earth.bordersGeometry.getAttribute('position');
    const borderCol = earth.bordersGeometry.getAttribute('color');
    const gratPos = earth.graticuleGeometry.getAttribute('position');
    const gratCol = earth.graticuleGeometry.getAttribute('color');

    expect(borderPos.count).toBeGreaterThan(10_000);
    expect(borderPos.count % 2).toBe(0);
    expect(borderCol.count).toBe(borderPos.count);

    expect(gratPos.count).toBeGreaterThan(1_000);
    expect(gratPos.count % 2).toBe(0);
    expect(gratCol.count).toBe(gratPos.count);

    // Every single border vertex must be finite and lie strictly on radius 50.08
    const bArr = borderPos.array;
    for (let i = 0; i < bArr.length; i += 3) {
      const x = bArr[i];
      const y = bArr[i + 1];
      const z = bArr[i + 2];
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      const r = Math.hypot(x, y, z);
      expect(r).toBeCloseTo(VECTOR_EARTH_RADIUS, 3);
    }

    // Every single border color channel must be finite and normalized [0, 1]
    const cArr = borderCol.array;
    for (let i = 0; i < cArr.length; i++) {
      expect(Number.isFinite(cArr[i])).toBe(true);
      expect(cArr[i]).toBeGreaterThanOrEqual(0);
      expect(cArr[i]).toBeLessThanOrEqual(1);
    }

    // Every single graticule vertex must be finite and lie on its spherical shell
    const gArr = gratPos.array;
    const expectedGratRadius = VECTOR_EARTH_RADIUS - 0.03;
    for (let i = 0; i < gArr.length; i += 3) {
      const x = gArr[i];
      const y = gArr[i + 1];
      const z = gArr[i + 2];
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, y, z)).toBeCloseTo(expectedGratRadius, 3);
    }

    // Strict < 1 MB VRAM budget (zero 8K CanvasTexture bloat)
    expect(earth.estimatedVramBytes).toBeGreaterThan(0);
    expect(earth.estimatedVramBytes).toBeLessThan(1_048_576);

    earth.bordersGeometry.dispose();
    earth.graticuleGeometry.dispose();
    (earth.borders.material as THREE.Material).dispose();
    (earth.graticule.material as THREE.Material).dispose();
  });
});
