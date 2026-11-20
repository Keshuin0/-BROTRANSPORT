import * as THREE from 'three';
import { NORTH_AMERICAN_PORTS, type BorderPortInfo, type CountryCode, type EquipmentType } from '@bro/contracts';

export const GLOBE_RADIUS = 50;
export const VECTOR_EARTH_RADIUS = 50.08;
export const ATMOSPHERE_RADIUS = 52.4;

export const COLOR_BRO_CYAN = 0x00f0ff;
export const COLOR_BRO_GOLD = 0xffaa00;
export const COLOR_BRO_CRIMSON = 0xff0055;
export const COLOR_BRO_ICE = 0xe2f1f8;

export type HubId =
  | 'PEI'
  | 'HALIFAX'
  | 'MONTREAL'
  | 'TORONTO'
  | 'WINNIPEG'
  | 'CALGARY'
  | 'EDMONTON'
  | 'VANCOUVER'
  | 'BOSTON'
  | 'NEW_YORK'
  | 'DETROIT'
  | 'CHICAGO'
  | 'MEMPHIS'
  | 'ATLANTA'
  | 'MIAMI'
  | 'DALLAS'
  | 'HOUSTON'
  | 'DENVER'
  | 'LOS_ANGELES'
  | 'SEATTLE'
  | 'MEXICO_CITY';

export interface HubLocation {
  readonly id: HubId;
  readonly kind: 'hub';
  readonly name: string;
  readonly city: string;
  readonly region: string;
  readonly country: CountryCode;
  readonly lat: number;
  readonly lon: number;
  readonly isHQ: boolean;
  readonly corridorTier: 'primary' | 'regional';
  readonly primaryCorridor: string;
  readonly divisions: readonly EquipmentType[];
}

export interface CorridorRoute {
  readonly id: string;
  readonly fromId: HubId;
  readonly toId: HubId;
  readonly from: HubLocation;
  readonly to: HubLocation;
  readonly color: number;
  readonly label: string;
  readonly crossBorder: boolean;
}

export type WaitSeverityStatus = 'clear' | 'moderate' | 'congested' | 'unknown';

export interface BorderPortNode extends BorderPortInfo {
  readonly id: string;
  readonly kind: 'border_port';
  readonly commercialWaitMinutes: number | null;
  readonly fastLaneWaitMinutes: number | null;
  readonly status: WaitSeverityStatus;
  readonly updatedAt: string | null;
}

export type GlobeNode = HubLocation | BorderPortNode;

export interface BorderWaitTimeDatum {
  cbpCode: string;
  commercialWaitMinutes: number | null;
  fastLaneWaitMinutes?: number | null;
  updatedAt?: string | null;
}

export interface CameraPreset {
  readonly id: 'atlantic' | 'great_lakes' | 'north_america';
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly distance: number;
}

export const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    id: 'atlantic',
    label: 'Atlantic Corridor',
    lat: 45.1,
    lon: -66.8,
    distance: 84,
  },
  {
    id: 'great_lakes',
    label: 'Great Lakes',
    lat: 43.0,
    lon: -81.8,
    distance: 82,
  },
  {
    id: 'north_america',
    label: 'North America',
    lat: 40.5,
    lon: -94.0,
    distance: 138,
  },
] as const;

const ALL_COMMERCIAL_DIVISIONS: readonly EquipmentType[] = ['dry_van', 'reefer', 'flatbed'];

export const HUB_LOCATIONS: readonly HubLocation[] = [
  // ── CANADA (8) ──────────────────────────────────────────────────────────
  {
    id: 'PEI',
    kind: 'hub',
    name: 'PEI HQ',
    city: 'Charlottetown',
    region: 'PE',
    country: 'CA',
    lat: 46.2507,
    lon: -63.1375,
    isHQ: true,
    corridorTier: 'primary',
    primaryCorridor: 'Atlantic Gateway HQ · TCH-1 / I-95',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'HALIFAX',
    kind: 'hub',
    name: 'HALIFAX PORT',
    city: 'Halifax',
    region: 'NS',
    country: 'CA',
    lat: 44.6488,
    lon: -63.5752,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'Atlantic Deep-Water Container Terminal',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'MONTREAL',
    kind: 'hub',
    name: 'MONTREAL HUB',
    city: 'Montreal',
    region: 'QC',
    country: 'CA',
    lat: 45.5017,
    lon: -73.5673,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'St. Lawrence Seaway · QC-15 / I-87',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'TORONTO',
    kind: 'hub',
    name: 'TORONTO CORR',
    city: 'Toronto',
    region: 'ON',
    country: 'CA',
    lat: 43.6532,
    lon: -79.3832,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Highway 401 Golden Horseshoe Spine',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'WINNIPEG',
    kind: 'hub',
    name: 'WINNIPEG GATE',
    city: 'Winnipeg',
    region: 'MB',
    country: 'CA',
    lat: 49.8951,
    lon: -97.1384,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Mid-Continent Trade Corridor · MB-75 / I-29',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'CALGARY',
    kind: 'hub',
    name: 'CALGARY TERM',
    city: 'Calgary',
    region: 'AB',
    country: 'CA',
    lat: 51.0447,
    lon: -114.0719,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Western Trans-Canada / CANAMEX Spine',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'EDMONTON',
    kind: 'hub',
    name: 'EDMONTON YARD',
    city: 'Edmonton',
    region: 'AB',
    country: 'CA',
    lat: 53.5461,
    lon: -113.4938,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'Alberta Industrial Distribution Hub',
    divisions: ['dry_van', 'flatbed'],
  },
  {
    id: 'VANCOUVER',
    kind: 'hub',
    name: 'VANCOUVER GATE',
    city: 'Vancouver',
    region: 'BC',
    country: 'CA',
    lat: 49.2827,
    lon: -123.1207,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'Pacific Gateway · BC-15 / I-5',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },

  // ── UNITED STATES (12) ──────────────────────────────────────────────────
  {
    id: 'BOSTON',
    kind: 'hub',
    name: 'BOSTON HUB',
    city: 'Boston',
    region: 'MA',
    country: 'US',
    lat: 42.3601,
    lon: -71.0589,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'New England Cold-Chain · I-95 / I-90',
    divisions: ['dry_van', 'reefer'],
  },
  {
    id: 'NEW_YORK',
    kind: 'hub',
    name: 'NEW YORK TERM',
    city: 'New York',
    region: 'NY',
    country: 'US',
    lat: 40.7128,
    lon: -74.006,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Northeast Megaregion · I-95 / I-87',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'DETROIT',
    kind: 'hub',
    name: 'DETROIT X-BORDER',
    city: 'Detroit',
    region: 'MI',
    country: 'US',
    lat: 42.3314,
    lon: -83.0458,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Detroit–Windsor Auto & Industrial Gateway',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'CHICAGO',
    kind: 'hub',
    name: 'CHICAGO TERM',
    city: 'Chicago',
    region: 'IL',
    country: 'US',
    lat: 41.8781,
    lon: -87.6298,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Midwest Intermodal Nexus · I-80 / I-94',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'MEMPHIS',
    kind: 'hub',
    name: 'MEMPHIS FREIGHT',
    city: 'Memphis',
    region: 'TN',
    country: 'US',
    lat: 35.1495,
    lon: -90.049,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Mid-South Distribution Hub · I-40 / I-55',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'ATLANTA',
    kind: 'hub',
    name: 'ATLANTA HUB',
    city: 'Atlanta',
    region: 'GA',
    country: 'US',
    lat: 33.749,
    lon: -84.388,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Southeast Freight Spine · I-75 / I-85',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'MIAMI',
    kind: 'hub',
    name: 'MIAMI DIVISION',
    city: 'Miami',
    region: 'FL',
    country: 'US',
    lat: 25.7617,
    lon: -80.1918,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'South Atlantic Perishable Gateway · I-95',
    divisions: ['dry_van', 'reefer'],
  },
  {
    id: 'DALLAS',
    kind: 'hub',
    name: 'DALLAS FW TERM',
    city: 'Dallas',
    region: 'TX',
    country: 'US',
    lat: 32.7767,
    lon: -96.797,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Texas Triangle · I-35 / I-20',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'HOUSTON',
    kind: 'hub',
    name: 'HOUSTON HUB',
    city: 'Houston',
    region: 'TX',
    country: 'US',
    lat: 29.7604,
    lon: -95.3698,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Gulf Coast Industrial & USMCA Corridor · I-10',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'DENVER',
    kind: 'hub',
    name: 'DENVER CORR',
    city: 'Denver',
    region: 'CO',
    country: 'US',
    lat: 39.7392,
    lon: -104.9903,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'Mountain West Logistics Spine · I-70 / I-25',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'LOS_ANGELES',
    kind: 'hub',
    name: 'LA TERM',
    city: 'Los Angeles',
    region: 'CA',
    country: 'US',
    lat: 34.0522,
    lon: -118.2437,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'San Pedro Bay Port Complex · I-5 / I-10',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
  {
    id: 'SEATTLE',
    kind: 'hub',
    name: 'SEATTLE TERM',
    city: 'Seattle',
    region: 'WA',
    country: 'US',
    lat: 47.6062,
    lon: -122.3321,
    isHQ: false,
    corridorTier: 'regional',
    primaryCorridor: 'Pacific Northwest Corridor · I-5 / I-90',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },

  // ── MEXICO (1) ──────────────────────────────────────────────────────────
  {
    id: 'MEXICO_CITY',
    kind: 'hub',
    name: 'MEXICO CITY',
    city: 'Mexico City',
    region: 'CMX',
    country: 'MX',
    lat: 19.4326,
    lon: -99.1332,
    isHQ: false,
    corridorTier: 'primary',
    primaryCorridor: 'USMCA Central Valley Gateway · MEX-85D',
    divisions: ALL_COMMERCIAL_DIVISIONS,
  },
] as const;

export const HUB_BY_ID: Readonly<Record<HubId, HubLocation>> = Object.fromEntries(
  HUB_LOCATIONS.map((hub) => [hub.id, hub]),
) as Record<HubId, HubLocation>;

const ROUTE_SPECS: ReadonlyArray<{
  from: HubId;
  to: HubId;
  color: number;
  label: string;
}> = [
  // Canadian Corridors (9)
  { from: 'PEI', to: 'HALIFAX', color: COLOR_BRO_CYAN, label: 'Maritime Feeder' },
  { from: 'PEI', to: 'MONTREAL', color: COLOR_BRO_CYAN, label: 'Atlantic–Quebec Link' },
  { from: 'PEI', to: 'BOSTON', color: COLOR_BRO_CYAN, label: 'Maritime Cross-Border' },
  { from: 'HALIFAX', to: 'MONTREAL', color: COLOR_BRO_CYAN, label: 'Port Halifax–Montreal' },
  { from: 'MONTREAL', to: 'TORONTO', color: COLOR_BRO_GOLD, label: 'QC–ON Highway 401 Spine' },
  { from: 'TORONTO', to: 'WINNIPEG', color: COLOR_BRO_GOLD, label: 'Trans-Canada Central' },
  { from: 'WINNIPEG', to: 'CALGARY', color: COLOR_BRO_GOLD, label: 'Prairie Trunk' },
  { from: 'CALGARY', to: 'EDMONTON', color: COLOR_BRO_CYAN, label: 'Alberta QEII Corridor' },
  { from: 'CALGARY', to: 'VANCOUVER', color: COLOR_BRO_CYAN, label: 'Trans-Canada West' },
  // Cross-Border Corridors (4)
  { from: 'TORONTO', to: 'DETROIT', color: COLOR_BRO_GOLD, label: 'Windsor–Detroit Gateway' },
  { from: 'TORONTO', to: 'CHICAGO', color: COLOR_BRO_GOLD, label: 'ON–IL Great Lakes Corridor' },
  { from: 'VANCOUVER', to: 'SEATTLE', color: COLOR_BRO_CYAN, label: 'Pacific Gateway' },
  { from: 'HOUSTON', to: 'MEXICO_CITY', color: COLOR_BRO_GOLD, label: 'USMCA Laredo Trunk' },
  // US Corridors (15)
  { from: 'BOSTON', to: 'NEW_YORK', color: COLOR_BRO_CYAN, label: 'I-95 Northeast' },
  { from: 'NEW_YORK', to: 'ATLANTA', color: COLOR_BRO_GOLD, label: 'I-95 / I-85 Atlantic' },
  { from: 'ATLANTA', to: 'MIAMI', color: COLOR_BRO_CYAN, label: 'Florida Cold-Chain' },
  { from: 'ATLANTA', to: 'DALLAS', color: COLOR_BRO_GOLD, label: 'I-20 Southern Cross' },
  { from: 'ATLANTA', to: 'MEMPHIS', color: COLOR_BRO_CYAN, label: 'I-22 Mid-South' },
  { from: 'DALLAS', to: 'HOUSTON', color: COLOR_BRO_GOLD, label: 'Texas Triangle' },
  { from: 'MEMPHIS', to: 'DALLAS', color: COLOR_BRO_GOLD, label: 'I-30 / I-40 Freight Line' },
  { from: 'CHICAGO', to: 'DETROIT', color: COLOR_BRO_CYAN, label: 'I-94 Great Lakes Auto' },
  { from: 'CHICAGO', to: 'MEMPHIS', color: COLOR_BRO_CYAN, label: 'I-57 Mississippi Valley' },
  { from: 'CHICAGO', to: 'DENVER', color: COLOR_BRO_GOLD, label: 'I-80 / I-76 Plains West' },
  { from: 'DENVER', to: 'LOS_ANGELES', color: COLOR_BRO_CYAN, label: 'I-70 / I-15 Mountain' },
  { from: 'SEATTLE', to: 'LOS_ANGELES', color: COLOR_BRO_CYAN, label: 'I-5 Pacific Spine' },
  { from: 'LOS_ANGELES', to: 'HOUSTON', color: COLOR_BRO_GOLD, label: 'I-10 Southern Transcon' },
  { from: 'LOS_ANGELES', to: 'DALLAS', color: COLOR_BRO_GOLD, label: 'I-10 / I-20 Southwest' },
  { from: 'HOUSTON', to: 'MIAMI', color: COLOR_BRO_CYAN, label: 'I-10 Gulf Coast' },
];

export const CORRIDOR_ROUTES: readonly CorridorRoute[] = ROUTE_SPECS.map((spec) => {
  const from = HUB_BY_ID[spec.from];
  const to = HUB_BY_ID[spec.to];
  return {
    id: `${spec.from}_${spec.to}`,
    fromId: spec.from,
    toId: spec.to,
    from,
    to,
    color: spec.color,
    label: spec.label,
    crossBorder: from.country !== to.country,
  };
});

export const BORDER_PORTS: readonly BorderPortNode[] = NORTH_AMERICAN_PORTS.map((port) => ({
  ...port,
  id: `port-${port.cbpCode}`,
  kind: 'border_port',
  commercialWaitMinutes: null,
  fastLaneWaitMinutes: null,
  status: 'unknown',
  updatedAt: null,
}));

/**
 * Pure right-handed spherical projection matching Three.js SphereGeometry coordinates.
 * Equator + Prime Meridian (lat=0, lon=0) -> (+radius, 0, 0)
 * Equator + 90°W Americas (lat=0, lon=-90) -> (0, 0, +radius)
 * North Pole (lat=90, lon=*) -> (0, +radius, 0)
 */
export function latLonToVector3(lat: number, lon: number, radius = GLOBE_RADIUS): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  const sinPhi = Math.sin(phi);

  const x = -(radius * sinPhi * Math.cos(theta));
  const y = radius * Math.cos(phi);
  const z = radius * sinPhi * Math.sin(theta);

  return new THREE.Vector3(x, y, z);
}

/**
 * Maps commercial border wait minutes to #BRO operational severity color:
 * - < 15 min: Cyan (clear flow)
 * - 15–45 min: Gold (moderate queue)
 * - > 45 min: Crimson (congested / alert)
 * - null/undefined: Cyan standby
 */
export function getWaitTimeSeverity(waitMinutes: number | null | undefined): {
  colorHex: number;
  status: WaitSeverityStatus;
} {
  if (waitMinutes === null || waitMinutes === undefined || !Number.isFinite(waitMinutes)) {
    return { colorHex: COLOR_BRO_CYAN, status: 'unknown' };
  }
  if (waitMinutes < 15) {
    return { colorHex: COLOR_BRO_CYAN, status: 'clear' };
  }
  if (waitMinutes <= 45) {
    return { colorHex: COLOR_BRO_GOLD, status: 'moderate' };
  }
  return { colorHex: COLOR_BRO_CRIMSON, status: 'congested' };
}

/**
 * Builds a 1-click `/quote` URL pre-populated with origin/destination parameters
 * for either a logistics hub or a commercial border crossing.
 */
export function buildQuoteUrlForNode(node: GlobeNode): string {
  const params = new URLSearchParams();
  if (node.kind === 'border_port') {
    params.set('origin', node.caCityProv);
    params.set('destination', node.usCityState);
    params.set('port', node.cbpCode);
  } else {
    if (node.isHQ) {
      params.set('origin', `${node.city}, ${node.region}`);
      params.set('destination', 'Toronto, ON');
    } else {
      params.set('origin', 'Charlottetown, PE');
      params.set('destination', `${node.city}, ${node.region}`);
    }
    params.set('hub', node.id);
  }
  return `/quote?${params.toString()}`;
}

/**
 * Count how many active trade corridors connect to a given hub.
 */
export function countRoutesForHub(hubId: HubId): number {
  let count = 0;
  for (const route of CORRIDOR_ROUTES) {
    if (route.fromId === hubId || route.toId === hubId) {
      count++;
    }
  }
  return count;
}
