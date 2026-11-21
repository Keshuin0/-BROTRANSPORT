import * as THREE from 'three';
import { feature } from 'topojson-client';
import worldAtlasCountries from 'world-atlas/countries-110m.json';
import { VECTOR_EARTH_RADIUS, latLonToVector3 } from './globeData';

type FeatureTopology = Parameters<typeof feature>[0];
type FeatureGeometryObject = Parameters<typeof feature>[1];

interface GeoJsonPolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}

interface GeoJsonMultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

type SupportedGeoGeometry = GeoJsonPolygonGeometry | GeoJsonMultiPolygonGeometry;

interface CountryFeature {
  id?: string | number;
  geometry: SupportedGeoGeometry | null;
}

interface CountryFeatureCollection {
  type: 'FeatureCollection';
  features: CountryFeature[];
}

export interface VectorEarthResult {
  borders: THREE.LineSegments;
  graticule: THREE.LineSegments;
  bordersGeometry: THREE.BufferGeometry;
  graticuleGeometry: THREE.BufferGeometry;
  vertexCount: number;
  estimatedVramBytes: number;
}

// ISO 3166-1 numeric codes for North American USMCA operating territory
const NORTH_AMERICA_ISO_CODES = new Set(['124', '840', '484']); // Canada, United States, Mexico

// Crisp luminous cyan for North America, subtle aerospace slate-cyan for rest of world
const NA_BORDER_RGB: readonly [number, number, number] = [0.0, 0.94, 1.0];
const WORLD_BORDER_RGB: readonly [number, number, number] = [0.16, 0.45, 0.6];
const GRATICULE_STD_RGB: readonly [number, number, number] = [0.08, 0.34, 0.48];
const GRATICULE_EQUATOR_RGB: readonly [number, number, number] = [0.15, 0.58, 0.72];

// Subdivide border segments wider than 2.5° so long straight parallels (e.g., 49th parallel)
// never sag below the radius-50 Earth core sphere.
const MAX_ANGULAR_STEP_DEG = 2.5;
const MIN_SEGMENT_DIST_SQ = 1e-6;

const SCRATCH_PREV = new THREE.Vector3();
const SCRATCH_NEXT = new THREE.Vector3();

function pushSubdividedSegment(
  positions: number[],
  colors: number[],
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  radius: number,
  rgb: readonly [number, number, number],
): void {
  // Resolve shortest longitudinal arc across ±180° antimeridian
  let dLon = lon2 - lon1;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;

  const dLat = lat2 - lat1;
  const angularSpan = Math.hypot(dLon, dLat);
  const steps = Math.max(1, Math.ceil(angularSpan / MAX_ANGULAR_STEP_DEG));

  latLonToVector3(lat1, lon1, radius, SCRATCH_PREV);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    let curLon = lon1 + dLon * t;
    if (curLon > 180) curLon -= 360;
    else if (curLon < -180) curLon += 360;
    const curLat = lat1 + dLat * t;

    latLonToVector3(curLat, curLon, radius, SCRATCH_NEXT);
    if (SCRATCH_PREV.distanceToSquared(SCRATCH_NEXT) >= MIN_SEGMENT_DIST_SQ) {
      positions.push(
        SCRATCH_PREV.x,
        SCRATCH_PREV.y,
        SCRATCH_PREV.z,
        SCRATCH_NEXT.x,
        SCRATCH_NEXT.y,
        SCRATCH_NEXT.z,
      );
      colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
    SCRATCH_PREV.copy(SCRATCH_NEXT);
  }
}

function appendRing(
  ring: number[][],
  radius: number,
  rgb: readonly [number, number, number],
  positions: number[],
  colors: number[],
): void {
  if (ring.length < 2) return;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b || a.length < 2 || b.length < 2) continue;
    pushSubdividedSegment(positions, colors, a[0], a[1], b[0], b[1], radius, rgb);
  }
}

/**
 * Decodes `world-atlas/countries-110m.json` via `topojson-client` and projects every
 * coastline & sovereign border onto a GPU `BufferGeometry` for `THREE.LineSegments`.
 * Zero 2D Canvas texture — crisp at infinite zoom and < 1 MB VRAM.
 */
export function buildCountryBordersGeometry(radius = VECTOR_EARTH_RADIUS): THREE.BufferGeometry {
  const topology = worldAtlasCountries as unknown as FeatureTopology & {
    objects: { countries: FeatureGeometryObject };
  };
  const countriesGeo = feature(
    topology,
    topology.objects.countries,
  ) as unknown as CountryFeatureCollection;

  const positions: number[] = [];
  const colors: number[] = [];

  for (const feat of countriesGeo.features) {
    const geom = feat.geometry;
    if (!geom) continue;

    const isoId = feat.id !== undefined ? String(feat.id).padStart(3, '0') : '';
    const rgb = NORTH_AMERICA_ISO_CODES.has(isoId) ? NA_BORDER_RGB : WORLD_BORDER_RGB;

    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) {
        appendRing(ring, radius, rgb, positions, colors);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        for (const ring of polygon) {
          appendRing(ring, radius, rgb, positions, colors);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Constructs a clean 30° spherical graticule (`THREE.LineSegments` geometry)
 * wrapping parallels (-60°, -30°, 0°, 30°, 60°) and meridians every 30°.
 */
export function buildGraticuleGeometry(
  radius = VECTOR_EARTH_RADIUS - 0.03,
  stepDeg = 30,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const sampleDeg = 3;

  // Latitude parallels
  for (let lat = -90 + stepDeg; lat <= 90 - stepDeg; lat += stepDeg) {
    const rgb = lat === 0 ? GRATICULE_EQUATOR_RGB : GRATICULE_STD_RGB;
    for (let lon = -180; lon < 180; lon += sampleDeg) {
      latLonToVector3(lat, lon, radius, SCRATCH_PREV);
      latLonToVector3(lat, lon + sampleDeg, radius, SCRATCH_NEXT);
      positions.push(
        SCRATCH_PREV.x,
        SCRATCH_PREV.y,
        SCRATCH_PREV.z,
        SCRATCH_NEXT.x,
        SCRATCH_NEXT.y,
        SCRATCH_NEXT.z,
      );
      colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
  }

  // Longitude meridians
  for (let lon = -180; lon < 180; lon += stepDeg) {
    const rgb = lon === 0 ? GRATICULE_EQUATOR_RGB : GRATICULE_STD_RGB;
    for (let lat = -84; lat < 84; lat += sampleDeg) {
      latLonToVector3(lat, lon, radius, SCRATCH_PREV);
      latLonToVector3(lat + sampleDeg, lon, radius, SCRATCH_NEXT);
      positions.push(
        SCRATCH_PREV.x,
        SCRATCH_PREV.y,
        SCRATCH_PREV.z,
        SCRATCH_NEXT.x,
        SCRATCH_NEXT.y,
        SCRATCH_NEXT.z,
      );
      colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Builds the complete GPU Vector Earth assembly (coastal + country borders + 30° graticule)
 * ready to attach directly to the Three.js scene in 2 lightweight draw calls (< 1 MB VRAM).
 */
export function buildVectorEarth(radius = VECTOR_EARTH_RADIUS): VectorEarthResult {
  const bordersGeometry = buildCountryBordersGeometry(radius);
  const graticuleGeometry = buildGraticuleGeometry(radius - 0.03, 30);

  const bordersMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });

  const graticuleMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });

  const borders = new THREE.LineSegments(bordersGeometry, bordersMaterial);
  borders.name = 'vector-earth-borders';

  const graticule = new THREE.LineSegments(graticuleGeometry, graticuleMaterial);
  graticule.name = 'vector-earth-graticule';

  const borderPos = bordersGeometry.getAttribute('position');
  const borderCol = bordersGeometry.getAttribute('color');
  const gratPos = graticuleGeometry.getAttribute('position');
  const gratCol = graticuleGeometry.getAttribute('color');

  const vertexCount = borderPos.count + gratPos.count;
  const estimatedVramBytes =
    borderPos.array.byteLength +
    borderCol.array.byteLength +
    gratPos.array.byteLength +
    gratCol.array.byteLength;

  return {
    borders,
    graticule,
    bordersGeometry,
    graticuleGeometry,
    vertexCount,
    estimatedVramBytes,
  };
}
