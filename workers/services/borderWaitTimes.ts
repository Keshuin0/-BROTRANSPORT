import { NORTH_AMERICAN_PORTS, type BorderPortInfo } from '@bro/contracts';
import type { CloudflareEnv } from '../../src/env';

export const CBSA_BWT_CSV_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
export const CBP_BWT_XML_URL = 'https://bwt.cbp.gov/xml/bwt.xml';
export const BORDER_WAIT_CACHE_KEY = 'border:wait_times:latest';
export const BORDER_WAIT_CACHE_TTL_SECONDS = 900;
const UPSTREAM_TIMEOUT_MS = 6000;

export interface CbsaWaitRecord {
  officeName: string;
  location: string;
  updatedAt: string | null;
  commercialNorthboundMinutes: number | null;
  travellerNorthboundMinutes: number | null;
  rawCommercialStatus: string;
}

export interface CbpWaitRecord {
  portNumber: string;
  cbpCode: string;
  border: string;
  portName: string;
  crossingName: string;
  portStatus: string;
  updatedAt: string | null;
  commercialStandardMinutes: number | null;
  commercialFastMinutes: number | null;
  commercialLanesOpen: number | null;
  passengerStandardMinutes: number | null;
}

export type PortOperationalStatus = 'open' | 'delayed' | 'congested' | 'unavailable';

export interface PortWaitSnapshot {
  cbpCode: string;
  cbsaName: string;
  crossingName: string;
  usCityState: string;
  caCityProv: string;
  lat: number;
  lon: number;
  highway: string;
  commercialFastLane: boolean;
  northboundCommercialMinutes: number | null;
  southboundCommercialMinutes: number | null;
  southboundFastMinutes: number | null;
  commercialLanesOpen: number | null;
  status: PortOperationalStatus;
  cbsaUpdatedAt: string | null;
  cbpUpdatedAt: string | null;
}

export interface BorderSourceStatus {
  ok: boolean;
  error?: string;
  recordCount: number;
}

export interface BorderWaitFeed {
  fetchedAt: string;
  stale: boolean;
  sources: {
    cbsa: BorderSourceStatus;
    cbp: BorderSourceStatus;
  };
  ports: PortWaitSnapshot[];
}

/**
 * Normalizes CBSA / CBP wait time text values into integer minutes or null.
 * Examples:
 * - "No Delay" -> 0
 * - "25 minutes" -> 25
 * - "1 hour 15 minutes" -> 75
 * - "Not Applicable" -> null
 */
export function normalizeWaitMinutes(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();

  if (
    lower === 'not applicable' ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'update pending' ||
    lower === 'not reported' ||
    lower === 'closed' ||
    lower === 'lanes closed' ||
    lower === 'lane closed' ||
    lower === 'temporarily closed' ||
    lower === '--' ||
    lower === '-'
  ) {
    return null;
  }

  if (lower === 'no delay' || lower === 'no delays' || lower === 'none') {
    return 0;
  }

  // Handle "1 hour 15 minutes", "2 hrs 30 min", "1 hour"
  const hourMatch = lower.match(
    /(\d+)\s*(?:hours?|hrs?|hr|h)\b(?:\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?|min|m)\b)?/,
  );
  if (hourMatch) {
    const hours = Number.parseInt(hourMatch[1], 10);
    const mins = hourMatch[2] ? Number.parseInt(hourMatch[2], 10) : 0;
    return hours * 60 + mins;
  }

  // Handle "25 minutes", "10 min", "0 mins"
  const minMatch = lower.match(/(\d+)\s*(?:minutes?|mins?|min|m)\b/);
  if (minMatch) {
    return Number.parseInt(minMatch[1], 10);
  }

  // Handle plain non-negative integers (e.g., CBP XML <delay_minutes>25</delay_minutes>)
  if (/^\d+$/.test(lower)) {
    return Number.parseInt(lower, 10);
  }

  return null;
}

/**
 * Parses a single RFC-4180 CSV line supporting quoted fields and escaped quotes.
 */
function parseCommaCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function splitCbsaLine(line: string, useDoubleSemicolon: boolean): string[] {
  if (useDoubleSemicolon) {
    return line
      .split(';;')
      .map((cell) => cell.trim().replace(/^"(.*)"$/, '$1').trim());
  }
  return parseCommaCsvLine(line);
}

/**
 * Pure parser for the official CBSA Border Wait Times CSV feed.
 * Supports both CBSA's native `;;`-delimited format and standard comma-separated CSV.
 */
export function parseCbsaCsv(csvText: string): CbsaWaitRecord[] {
  const normalized = csvText.replace(/^\uFEFF/, '');
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const useDoubleSemicolon = lines[0].includes(';;');
  const firstCols = splitCbsaLine(lines[0], useDoubleSemicolon);
  const firstRowLower = firstCols.map((c) => c.toLowerCase());

  const hasHeader = firstRowLower.some(
    (col) =>
      col.includes('customs office') ||
      col.includes('commercial') ||
      col.includes('traveller') ||
      col.includes('traveler') ||
      col === 'office' ||
      col === 'port',
  );

  let officeIdx = 0;
  let locationIdx = 1;
  let updatedIdx = 2;
  let commercialIdx = 3;
  let travellerIdx = 4;

  if (hasHeader) {
    const foundOffice = firstRowLower.findIndex(
      (c) => c.includes('customs office') || c === 'office' || c.includes('port') || c.includes('crossing'),
    );
    const foundLocation = firstRowLower.findIndex((c) => c.includes('location'));
    const foundUpdated = firstRowLower.findIndex(
      (c) => c.includes('updated') || c.includes('date') || c.includes('time'),
    );
    const foundCommercialCa = firstRowLower.findIndex(
      (c) => c.includes('commercial') && !c.includes('u.s.') && !c.includes('us-bound'),
    );
    const foundCommercialAny = firstRowLower.findIndex((c) => c.includes('commercial'));
    const foundTravellerCa = firstRowLower.findIndex(
      (c) => (c.includes('traveller') || c.includes('traveler') || c.includes('passenger')) && !c.includes('u.s.'),
    );
    const foundTravellerAny = firstRowLower.findIndex(
      (c) => c.includes('traveller') || c.includes('traveler') || c.includes('passenger'),
    );

    if (foundOffice >= 0) officeIdx = foundOffice;
    if (foundLocation >= 0) locationIdx = foundLocation;
    if (foundUpdated >= 0) updatedIdx = foundUpdated;
    if (foundCommercialCa >= 0) {
      commercialIdx = foundCommercialCa;
    } else if (foundCommercialAny >= 0) {
      commercialIdx = foundCommercialAny;
    }
    if (foundTravellerCa >= 0) {
      travellerIdx = foundTravellerCa;
    } else if (foundTravellerAny >= 0) {
      travellerIdx = foundTravellerAny;
    }
  }

  const startRow = hasHeader ? 1 : 0;
  const records: CbsaWaitRecord[] = [];

  for (let i = startRow; i < lines.length; i++) {
    const cols = splitCbsaLine(lines[i], useDoubleSemicolon);
    const officeName = (cols[officeIdx] ?? '').trim();
    if (!officeName) continue;

    const location = (cols[locationIdx] ?? '').trim();
    const updatedRaw = (cols[updatedIdx] ?? '').trim();
    const rawCommercialStatus = (cols[commercialIdx] ?? '').trim();
    const rawTravellerStatus = (cols[travellerIdx] ?? '').trim();

    records.push({
      officeName,
      location,
      updatedAt: updatedRaw.length > 0 ? updatedRaw : null,
      commercialNorthboundMinutes: normalizeWaitMinutes(rawCommercialStatus),
      travellerNorthboundMinutes: normalizeWaitMinutes(rawTravellerStatus),
      rawCommercialStatus,
    });
  }

  return records;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function extractXmlTag(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  return decodeXmlEntities(match[1]).trim();
}

function parseCbpLaneDelay(laneBlock: string): number | null {
  if (!laneBlock) return null;
  const delayRaw = extractXmlTag(laneBlock, 'delay_minutes');
  const fromDelay = normalizeWaitMinutes(delayRaw);
  if (fromDelay !== null) return fromDelay;

  const statusRaw = extractXmlTag(laneBlock, 'operational_status');
  return normalizeWaitMinutes(statusRaw);
}

function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * Pure parser for the official U.S. CBP Border Wait Times XML feed (`bwt.xml`).
 */
export function parseCbpXml(xmlText: string): CbpWaitRecord[] {
  const records: CbpWaitRecord[] = [];
  const portRegex = /<port\b[^>]*>([\s\S]*?)<\/port>/gi;

  for (const match of xmlText.matchAll(portRegex)) {
    const block = match[1];
    const portNumber = extractXmlTag(block, 'port_number');
    const portName = extractXmlTag(block, 'port_name');
    const crossingName = extractXmlTag(block, 'crossing_name');

    if (!portNumber && !portName && !crossingName) continue;

    const digits = portNumber.replace(/\D/g, '');
    const cbpCode = digits.length >= 4 ? digits.slice(0, 4) : digits.padStart(4, '0');

    const border = extractXmlTag(block, 'border');
    const portStatus = extractXmlTag(block, 'port_status') || 'Unknown';
    const dateStr = extractXmlTag(block, 'date');

    const commercialBlock = extractXmlTag(block, 'commercial_vehicle_lanes');
    const commercialStandardBlock = extractXmlTag(commercialBlock, 'standard_lanes');
    const commercialFastBlock = extractXmlTag(commercialBlock, 'FAST_lanes');

    const passengerBlock = extractXmlTag(block, 'passenger_vehicle_lanes');
    const passengerStandardBlock = extractXmlTag(passengerBlock, 'standard_lanes');

    const updateTime = extractXmlTag(commercialStandardBlock, 'update_time');
    const updatedAt = [dateStr, updateTime].filter(Boolean).join(' ').trim() || null;

    records.push({
      portNumber,
      cbpCode,
      border,
      portName,
      crossingName,
      portStatus,
      updatedAt,
      commercialStandardMinutes: parseCbpLaneDelay(commercialStandardBlock),
      commercialFastMinutes: parseCbpLaneDelay(commercialFastBlock),
      commercialLanesOpen: parseOptionalInt(extractXmlTag(commercialStandardBlock, 'lanes_open')),
      passengerStandardMinutes: parseCbpLaneDelay(passengerStandardBlock),
    });
  }

  return records;
}

function normalizeMatchKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchCbsaRecord(port: BorderPortInfo, records: CbsaWaitRecord[]): CbsaWaitRecord | undefined {
  const targetFull = normalizeMatchKey(port.cbsaName);
  const parenMatch = port.cbsaName.match(/\(([^)]+)\)/);
  const targetParen = parenMatch ? normalizeMatchKey(parenMatch[1]) : '';
  const targetBase = normalizeMatchKey(port.cbsaName.replace(/\([^)]*\)/g, ''));
  const targetCity = normalizeMatchKey(port.caCityProv.split(',')[0] ?? '');

  // Pass 1: exact normalized office name match
  const exact = records.find((r) => normalizeMatchKey(r.officeName) === targetFull);
  if (exact) return exact;

  // Pass 2: substring / alias match (e.g. "Fort Erie (Peace Bridge)" vs "Peace Bridge")
  const alias = records.find((r) => {
    const recName = normalizeMatchKey(r.officeName);
    if (!recName) return false;
    if (recName.includes(targetFull) || targetFull.includes(recName)) return true;
    if (targetParen && (recName.includes(targetParen) || targetParen.includes(recName))) return true;
    if (targetBase.length >= 5 && (recName.includes(targetBase) || targetBase.includes(recName))) return true;
    return false;
  });
  if (alias) return alias;

  // Pass 3: Canadian city name match inside officeName or location
  if (targetCity.length >= 5) {
    return records.find((r) => {
      const combined = normalizeMatchKey(`${r.officeName} ${r.location}`);
      return combined.includes(targetCity);
    });
  }

  return undefined;
}

function matchCbpRecord(port: BorderPortInfo, records: CbpWaitRecord[]): CbpWaitRecord | undefined {
  const byCode = records.filter(
    (r) => r.cbpCode === port.cbpCode || r.portNumber === port.cbpCode || r.portNumber.startsWith(port.cbpCode),
  );

  if (byCode.length === 1) return byCode[0];

  const targetKeys = [
    normalizeMatchKey(port.cbsaName),
    normalizeMatchKey(port.crossingName),
    normalizeMatchKey(port.usCityState.split(',')[0] ?? ''),
  ].filter((k) => k.length > 0);

  if (byCode.length > 1) {
    let best = byCode[0];
    let bestScore = -1;

    for (const candidate of byCode) {
      const candidateText = normalizeMatchKey(`${candidate.crossingName} ${candidate.portName}`);
      let score = 0;
      for (const key of targetKeys) {
        if (candidateText.includes(key) || key.includes(candidateText)) {
          score += 10;
        } else {
          for (const token of key.split(' ')) {
            if (token.length >= 4 && candidateText.includes(token)) {
              score += 2;
            }
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  // Fallback: crossing name match when CBP uses a different sub-port code
  const cbsaNorm = normalizeMatchKey(port.cbsaName);
  return records.find((r) => {
    const crossingNorm = normalizeMatchKey(r.crossingName);
    return crossingNorm.length >= 5 && (crossingNorm.includes(cbsaNorm) || cbsaNorm.includes(crossingNorm));
  });
}

function derivePortStatus(
  northboundMinutes: number | null,
  southboundMinutes: number | null,
): PortOperationalStatus {
  const observed = [northboundMinutes, southboundMinutes].filter((v): v is number => v !== null);
  if (observed.length === 0) return 'unavailable';

  const worstDelay = Math.max(...observed);
  if (worstDelay >= 45) return 'congested';
  if (worstDelay >= 15) return 'delayed';
  return 'open';
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'text/csv, application/xml, text/xml;q=0.9, */*;q=0.8',
        'User-Agent': 'BRO-Transport-Ops/2026 (+https://brotransport.com)',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim() };
    }

    const text = await response.text();
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `Upstream timeout after ${timeoutMs}ms` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown upstream fetch error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCachedFeed(kv?: KVNamespace): Promise<BorderWaitFeed | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(BORDER_WAIT_CACHE_KEY, 'json');
    if (
      raw &&
      typeof raw === 'object' &&
      'ports' in raw &&
      Array.isArray((raw as BorderWaitFeed).ports)
    ) {
      return raw as BorderWaitFeed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches live official CBSA CSV and CBP XML border wait times (6s timeout each),
 * normalizes them against NORTH_AMERICAN_PORTS, and caches in KV (`border:wait_times:latest`, TTL 900s).
 * Never fabricates random wait times: falls back to the last cached snapshot with `stale: true`.
 */
export async function syncBorderWaitTimes(
  env: Pick<Partial<CloudflareEnv>, 'CACHE'>,
  fetchImpl: typeof fetch = fetch,
): Promise<BorderWaitFeed> {
  const [cbsaFetch, cbpFetch, previousFeed] = await Promise.all([
    fetchTextWithTimeout(CBSA_BWT_CSV_URL, UPSTREAM_TIMEOUT_MS, fetchImpl),
    fetchTextWithTimeout(CBP_BWT_XML_URL, UPSTREAM_TIMEOUT_MS, fetchImpl),
    readCachedFeed(env.CACHE),
  ]);

  const cbsaRecords = cbsaFetch.ok ? parseCbsaCsv(cbsaFetch.text) : [];
  const cbpRecords = cbpFetch.ok ? parseCbpXml(cbpFetch.text) : [];

  const sources = {
    cbsa: cbsaFetch.ok
      ? { ok: true, recordCount: cbsaRecords.length }
      : { ok: false, error: cbsaFetch.error, recordCount: 0 },
    cbp: cbpFetch.ok
      ? { ok: true, recordCount: cbpRecords.length }
      : { ok: false, error: cbpFetch.error, recordCount: 0 },
  };

  // Both upstreams failed: return last cached snapshot marked stale (never fabricate numbers)
  if (!cbsaFetch.ok && !cbpFetch.ok) {
    if (previousFeed) {
      return {
        ...previousFeed,
        stale: true,
        sources,
      };
    }

    return {
      fetchedAt: new Date().toISOString(),
      stale: true,
      sources,
      ports: NORTH_AMERICAN_PORTS.map((port) => ({
        cbpCode: port.cbpCode,
        cbsaName: port.cbsaName,
        crossingName: port.crossingName,
        usCityState: port.usCityState,
        caCityProv: port.caCityProv,
        lat: port.lat,
        lon: port.lon,
        highway: port.highway,
        commercialFastLane: port.commercialFastLane,
        northboundCommercialMinutes: null,
        southboundCommercialMinutes: null,
        southboundFastMinutes: null,
        commercialLanesOpen: null,
        status: 'unavailable',
        cbsaUpdatedAt: null,
        cbpUpdatedAt: null,
      })),
    };
  }

  const prevByCode = new Map<string, PortWaitSnapshot>(
    (previousFeed?.ports ?? []).map((p) => [p.cbpCode, p]),
  );

  const ports: PortWaitSnapshot[] = NORTH_AMERICAN_PORTS.map((port) => {
    const prev = prevByCode.get(port.cbpCode);
    const cbsaMatch = cbsaFetch.ok ? matchCbsaRecord(port, cbsaRecords) : undefined;
    const cbpMatch = cbpFetch.ok ? matchCbpRecord(port, cbpRecords) : undefined;

    const northboundCommercialMinutes = cbsaFetch.ok
      ? (cbsaMatch?.commercialNorthboundMinutes ?? null)
      : (prev?.northboundCommercialMinutes ?? null);

    const southboundCommercialMinutes = cbpFetch.ok
      ? (cbpMatch?.commercialStandardMinutes ?? null)
      : (prev?.southboundCommercialMinutes ?? null);

    const southboundFastMinutes = cbpFetch.ok
      ? (cbpMatch?.commercialFastMinutes ?? null)
      : (prev?.southboundFastMinutes ?? null);

    const commercialLanesOpen = cbpFetch.ok
      ? (cbpMatch?.commercialLanesOpen ?? null)
      : (prev?.commercialLanesOpen ?? null);

    const cbsaUpdatedAt = cbsaFetch.ok
      ? (cbsaMatch?.updatedAt ?? null)
      : (prev?.cbsaUpdatedAt ?? null);

    const cbpUpdatedAt = cbpFetch.ok
      ? (cbpMatch?.updatedAt ?? null)
      : (prev?.cbpUpdatedAt ?? null);

    return {
      cbpCode: port.cbpCode,
      cbsaName: port.cbsaName,
      crossingName: port.crossingName,
      usCityState: port.usCityState,
      caCityProv: port.caCityProv,
      lat: port.lat,
      lon: port.lon,
      highway: port.highway,
      commercialFastLane: port.commercialFastLane,
      northboundCommercialMinutes,
      southboundCommercialMinutes,
      southboundFastMinutes,
      commercialLanesOpen,
      status: derivePortStatus(northboundCommercialMinutes, southboundCommercialMinutes),
      cbsaUpdatedAt,
      cbpUpdatedAt,
    };
  });

  const feed: BorderWaitFeed = {
    fetchedAt: new Date().toISOString(),
    stale: !(cbsaFetch.ok && cbpFetch.ok),
    sources,
    ports,
  };

  if (env.CACHE) {
    try {
      await env.CACHE.put(BORDER_WAIT_CACHE_KEY, JSON.stringify(feed), {
        expirationTtl: BORDER_WAIT_CACHE_TTL_SECONDS,
      });
    } catch {
      // Cache write failures should not drop live parsed data
    }
  }

  return feed;
}

/**
 * Returns the cached border wait times feed from KV, or triggers a live sync on cache miss.
 */
export async function getBorderWaitTimes(
  env: Pick<Partial<CloudflareEnv>, 'CACHE'>,
  fetchImpl: typeof fetch = fetch,
): Promise<BorderWaitFeed> {
  const cached = await readCachedFeed(env.CACHE);
  if (cached) {
    return cached;
  }
  return syncBorderWaitTimes(env, fetchImpl);
}
