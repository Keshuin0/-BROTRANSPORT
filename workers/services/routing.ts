import {
  haversineKm,
  NORTH_AMERICAN_PORTS,
  type BorderPortInfo,
  type CountryCode,
} from '@bro/contracts';

export const OSRM_DRIVING_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
export const HAVERSINE_HIGHWAY_CIRCUITY_FACTOR = 1.22;
const OSRM_TIMEOUT_MS = 3000;
const OSRM_CACHE_TTL_SECONDS = 86_400; // 24h for verified road geometry
const FALLBACK_CACHE_TTL_SECONDS = 900; // 15m for fallback so OSRM recovery is picked up
const KM_PER_MILE = 1.60934;
const AVG_COMMERCIAL_HIGHWAY_KMH = 80;

export interface HighwayRouteResult {
  distanceKm: number;
  distanceMiles: number;
  durationMinutes: number;
  source: 'osrm' | 'haversine_adjusted';
  cached: boolean;
  isCrossBorder: boolean;
  recommendedPort: BorderPortInfo | null;
  portDetourKm: number | null;
}

interface CachedRouteEntry {
  distanceKm: number;
  distanceMiles: number;
  durationMinutes: number;
  source: 'osrm' | 'haversine_adjusted';
  isCrossBorder: boolean;
  recommendedPortCode: string | null;
  portDetourKm: number | null;
}

function isMexicoCrossing(port: BorderPortInfo): boolean {
  return (
    port.cbpCode === '2304' ||
    port.caCityProv.toUpperCase().endsWith('MX') ||
    port.highway.toUpperCase().includes('MEX-')
  );
}

/**
 * Deterministically selects the optimal commercial border port along an international corridor
 * by minimizing total great-circle transit distance `d(origin, port) + d(port, dest)`.
 */
export function findNearestBorderPort(
  oLat: number,
  oLon: number,
  dLat: number,
  dLon: number,
  originCountry: CountryCode,
  destCountry: CountryCode,
): { port: BorderPortInfo; detourKm: number } | null {
  if (originCountry === destCountry) return null;

  const involvesMexico = originCountry === 'MX' || destCountry === 'MX';
  const eligiblePorts = NORTH_AMERICAN_PORTS.filter((port) =>
    involvesMexico ? isMexicoCrossing(port) : !isMexicoCrossing(port),
  );

  const candidates = eligiblePorts.length > 0 ? eligiblePorts : NORTH_AMERICAN_PORTS;
  const directKm = haversineKm(oLat, oLon, dLat, dLon);

  let bestPort = candidates[0];
  let bestCorridorKm = Number.POSITIVE_INFINITY;

  for (const port of candidates) {
    const corridorKm =
      haversineKm(oLat, oLon, port.lat, port.lon) + haversineKm(port.lat, port.lon, dLat, dLon);
    if (corridorKm < bestCorridorKm) {
      bestCorridorKm = corridorKm;
      bestPort = port;
    }
  }

  return {
    port: bestPort,
    detourKm: Math.max(0, Math.round(bestCorridorKm - directKm)),
  };
}

function buildRouteCacheKey(
  oLat: number,
  oLon: number,
  dLat: number,
  dLon: number,
  originCountry: CountryCode,
  destCountry: CountryCode,
): string {
  return `route:v1:${oLat.toFixed(3)},${oLon.toFixed(3)}:${dLat.toFixed(3)},${dLon.toFixed(3)}:${originCountry}:${destCountry}`;
}

async function queryOsrmRoute(
  oLat: number,
  oLon: number,
  dLat: number,
  dLon: number,
  fetchImpl: typeof fetch,
): Promise<{ distanceKm: number; durationMinutes: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

  try {
    // OSRM requires longitude,latitude coordinate ordering
    const url = `${OSRM_DRIVING_BASE_URL}/${oLon},${oLat};${dLon},${dLat}?overview=false`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'BRO-Transport-Routing/2026 (+https://brotransport.com)',
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      code?: string;
      routes?: Array<{ distance?: number; duration?: number }>;
    };

    if (payload.code !== 'Ok' || !Array.isArray(payload.routes) || payload.routes.length === 0) {
      return null;
    }

    const first = payload.routes[0];
    if (
      typeof first?.distance !== 'number' ||
      !Number.isFinite(first.distance) ||
      first.distance <= 0
    ) {
      return null;
    }

    const distanceKm = Number(Math.max(1, first.distance / 1000).toFixed(1));
    const durationMinutes =
      typeof first.duration === 'number' && Number.isFinite(first.duration) && first.duration > 0
        ? Math.max(1, Math.round(first.duration / 60))
        : Math.max(1, Math.round((distanceKm / AVG_COMMERCIAL_HIGHWAY_KMH) * 60));

    return { distanceKm, durationMinutes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calculates commercial highway routing distance & duration with:
 * 1. KV cache lookup
 * 2. Live OSRM public driving endpoint (3s AbortController timeout)
 * 3. Deterministic Haversine × 1.22 highway circuity fallback (`source: 'haversine_adjusted'`)
 * 4. Optimal commercial border port detection from `NORTH_AMERICAN_PORTS` for international loads
 */
export async function calculateHighwayRoute(
  oLat: number,
  oLon: number,
  dLat: number,
  dLon: number,
  originCountry: CountryCode,
  destCountry: CountryCode,
  kv?: KVNamespace,
  fetchImpl: typeof fetch = fetch,
): Promise<HighwayRouteResult> {
  if (
    !Number.isFinite(oLat) ||
    !Number.isFinite(oLon) ||
    !Number.isFinite(dLat) ||
    !Number.isFinite(dLon)
  ) {
    throw new Error('Route coordinates must be finite numbers.');
  }

  const isCrossBorder = originCountry !== destCountry;
  const cacheKey = buildRouteCacheKey(oLat, oLon, dLat, dLon, originCountry, destCountry);

  if (kv) {
    try {
      const cached = (await kv.get(cacheKey, 'json')) as CachedRouteEntry | null;
      if (cached && typeof cached.distanceKm === 'number' && cached.distanceKm > 0) {
        const port = cached.recommendedPortCode
          ? (NORTH_AMERICAN_PORTS.find((p) => p.cbpCode === cached.recommendedPortCode) ?? null)
          : null;

        return {
          distanceKm: cached.distanceKm,
          distanceMiles: cached.distanceMiles,
          durationMinutes: cached.durationMinutes,
          source: cached.source,
          cached: true,
          isCrossBorder: cached.isCrossBorder,
          recommendedPort: port,
          portDetourKm: cached.portDetourKm,
        };
      }
    } catch {
      // Cache read failure falls through to live calculation
    }
  }

  const borderSelection = findNearestBorderPort(
    oLat,
    oLon,
    dLat,
    dLon,
    originCountry,
    destCountry,
  );

  const osrmResult = await queryOsrmRoute(oLat, oLon, dLat, dLon, fetchImpl);

  let distanceKm: number;
  let durationMinutes: number;
  let source: 'osrm' | 'haversine_adjusted';

  if (osrmResult) {
    distanceKm = osrmResult.distanceKm;
    durationMinutes = osrmResult.durationMinutes;
    source = 'osrm';
  } else {
    const directKm = haversineKm(oLat, oLon, dLat, dLon);
    distanceKm = Number(Math.max(1, directKm * HAVERSINE_HIGHWAY_CIRCUITY_FACTOR).toFixed(1));
    durationMinutes = Math.max(1, Math.round((distanceKm / AVG_COMMERCIAL_HIGHWAY_KMH) * 60));
    source = 'haversine_adjusted';
  }

  const distanceMiles = Number((distanceKm / KM_PER_MILE).toFixed(1));

  if (kv) {
    const entry: CachedRouteEntry = {
      distanceKm,
      distanceMiles,
      durationMinutes,
      source,
      isCrossBorder,
      recommendedPortCode: borderSelection?.port.cbpCode ?? null,
      portDetourKm: borderSelection?.detourKm ?? null,
    };

    try {
      await kv.put(cacheKey, JSON.stringify(entry), {
        expirationTtl: source === 'osrm' ? OSRM_CACHE_TTL_SECONDS : FALLBACK_CACHE_TTL_SECONDS,
      });
    } catch {
      // Non-fatal cache write error
    }
  }

  return {
    distanceKm,
    distanceMiles,
    durationMinutes,
    source,
    cached: false,
    isCrossBorder,
    recommendedPort: borderSelection?.port ?? null,
    portDetourKm: borderSelection?.detourKm ?? null,
  };
}
