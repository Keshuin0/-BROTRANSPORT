import { describe, it, expect, vi } from 'vitest';
import {
  NORTH_AMERICAN_PORTS,
  haversineKm,
} from '@bro/contracts';
import {
  BORDER_WAIT_CACHE_KEY,
  BORDER_WAIT_CACHE_TTL_SECONDS,
  CBSA_BWT_CSV_URL,
  CBP_BWT_XML_URL,
  getBorderWaitTimes,
  normalizeWaitMinutes,
  parseCbpXml,
  parseCbsaCsv,
  syncBorderWaitTimes,
} from '../borderWaitTimes';
import { runBorderSync } from '../../cron/borderSync';
import {
  FMCSA_CACHE_TTL_SECONDS,
  MIN_BIPD_INSURANCE_CENTS,
  evaluateCarrierFraudRisk,
  parseFmcsaQcmobileResponse,
  verifyFmcsaCarrier,
  type FmcsaCarrierRecord,
} from '../fmcsa';
import {
  HAVERSINE_HIGHWAY_CIRCUITY_FACTOR,
  calculateHighwayRoute,
  findNearestBorderPort,
} from '../routing';
import {
  escapeHtml,
  sendEscalationEmail,
  sendInvoiceEmail,
  sendOtpEmail,
  sendQuoteEmail,
} from '../email';
import {
  DEFAULT_POW_DIFFICULTY_BITS,
  POW_MAX_AGE_MS,
  POW_REPLAY_TTL_SECONDS,
  countLeadingZeroBits,
  sha256Hex,
  verifyOfflinePowToken,
} from '../powVerify';

interface StoredKvEntry {
  value: string;
  expirationTtl?: number;
}

function createMemoryKv(): {
  kv: KVNamespace;
  store: Map<string, StoredKvEntry>;
} {
  const store = new Map<string, StoredKvEntry>();

  const kv = {
    async get(key: string, type?: string): Promise<unknown> {
      const entry = store.get(key);
      if (!entry) return null;
      if (type === 'json') {
        return JSON.parse(entry.value) as unknown;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, {
        value: String(value),
        expirationTtl: options?.expirationTtl,
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as KVNamespace;

  return { kv, store };
}

/**
 * Mines a real SHA-256 Proof-of-Work token (`timestamp:nonce:payloadHash`)
 * meeting the requested leading-zero-bit difficulty using Web Crypto.
 */
async function mineValidPowToken(
  timestampMs: number,
  payloadHashHex: string,
  difficultyBits = DEFAULT_POW_DIFFICULTY_BITS,
): Promise<string> {
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < 2_000_000; nonce++) {
    const candidate = `${timestampMs}:${nonce.toString(36)}:${payloadHashHex}`;
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    );
    if (countLeadingZeroBits(digest) >= difficultyBits) {
      return candidate;
    }
  }
  throw new Error('Failed to mine PoW token within iteration cap');
}

const SAMPLE_CBSA_CSV = [
  'Customs Office;; Location;; Updated;; Commercial Flow;; Travellers Flow',
  'Ambassador Bridge;; Windsor, ON / Detroit, MI;; 2026-11-20 13:00 EST;; 25 minutes;; No Delay',
  'Fort Erie (Peace Bridge);; Fort Erie, ON / Buffalo, NY;; 2026-11-20 13:00 EST;; No Delay;; 10 minutes',
  'St. Stephen 3rd Bridge;; St. Stephen, NB / Calais, ME;; 2026-11-20 13:00 EST;; Not Applicable;; No Delay',
  'Pacific Highway;; Surrey, BC / Blaine, WA;; 2026-11-20 13:00 EST;; 1 hour 15 minutes;; 20 minutes',
].join('\n');

const SAMPLE_CBP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<border_wait_time>
  <last_updated_date>2026-11-20</last_updated_date>
  <last_updated_time>13:05:00</last_updated_time>
  <port>
    <port_number>380101</port_number>
    <border>Canadian Border</border>
    <port_name>Detroit</port_name>
    <crossing_name>Ambassador Bridge</crossing_name>
    <date>11/20/2026</date>
    <port_status>Open</port_status>
    <commercial_vehicle_lanes>
      <standard_lanes>
        <update_time>At 1:05 pm EST</update_time>
        <operational_status>delay</operational_status>
        <delay_minutes>25 minutes</delay_minutes>
        <lanes_open>5</lanes_open>
      </standard_lanes>
      <FAST_lanes>
        <update_time>At 1:05 pm EST</update_time>
        <operational_status>No Delay</operational_status>
        <delay_minutes></delay_minutes>
        <lanes_open>2</lanes_open>
      </FAST_lanes>
    </commercial_vehicle_lanes>
    <passenger_vehicle_lanes>
      <standard_lanes>
        <delay_minutes>10</delay_minutes>
      </standard_lanes>
    </passenger_vehicle_lanes>
  </port>
  <port>
    <port_number>090101</port_number>
    <border>Canadian Border</border>
    <port_name>Buffalo</port_name>
    <crossing_name>Peace Bridge</crossing_name>
    <date>11/20/2026</date>
    <port_status>Open</port_status>
    <commercial_vehicle_lanes>
      <standard_lanes>
        <update_time>At 1:05 pm EST</update_time>
        <operational_status>No Delay</operational_status>
        <delay_minutes>0</delay_minutes>
        <lanes_open>4</lanes_open>
      </standard_lanes>
      <FAST_lanes>
        <operational_status>Not Applicable</operational_status>
        <delay_minutes></delay_minutes>
      </FAST_lanes>
    </commercial_vehicle_lanes>
  </port>
  <port>
    <port_number>2304</port_number>
    <border>Mexican Border</border>
    <port_name>Laredo</port_name>
    <crossing_name>World Trade Bridge</crossing_name>
    <date>11/20/2026</date>
    <port_status>Open</port_status>
    <commercial_vehicle_lanes>
      <standard_lanes>
        <update_time>At 12:05 pm CST</update_time>
        <operational_status>delay</operational_status>
        <delay_minutes>55</delay_minutes>
        <lanes_open>12</lanes_open>
      </standard_lanes>
      <FAST_lanes>
        <delay_minutes>15</delay_minutes>
      </FAST_lanes>
    </commercial_vehicle_lanes>
  </port>
</border_wait_time>`;

describe('Border Wait Times — CBSA CSV & CBP XML Parsers + KV Stale Fallback', () => {
  it('normalizes wait time strings deterministically', () => {
    expect(normalizeWaitMinutes('No Delay')).toBe(0);
    expect(normalizeWaitMinutes('25 minutes')).toBe(25);
    expect(normalizeWaitMinutes('Not Applicable')).toBeNull();
    expect(normalizeWaitMinutes('1 hour 15 minutes')).toBe(75);
    expect(normalizeWaitMinutes('0')).toBe(0);
    expect(normalizeWaitMinutes('40')).toBe(40);
    expect(normalizeWaitMinutes('Update Pending')).toBeNull();
    expect(normalizeWaitMinutes('Lanes Closed')).toBeNull();
    expect(normalizeWaitMinutes('')).toBeNull();
    expect(normalizeWaitMinutes(null)).toBeNull();
  });

  it('parses official CBSA double-semicolon CSV and standard comma CSV', () => {
    const records = parseCbsaCsv(SAMPLE_CBSA_CSV);
    expect(records).toHaveLength(4);

    expect(records[0]).toMatchObject({
      officeName: 'Ambassador Bridge',
      commercialNorthboundMinutes: 25,
      travellerNorthboundMinutes: 0,
    });
    expect(records[1]).toMatchObject({
      officeName: 'Fort Erie (Peace Bridge)',
      commercialNorthboundMinutes: 0,
      travellerNorthboundMinutes: 10,
    });
    expect(records[2]).toMatchObject({
      officeName: 'St. Stephen 3rd Bridge',
      commercialNorthboundMinutes: null,
      travellerNorthboundMinutes: 0,
    });
    expect(records[3]).toMatchObject({
      officeName: 'Pacific Highway',
      commercialNorthboundMinutes: 75,
      travellerNorthboundMinutes: 20,
    });

    const commaCsv = [
      'Customs Office,Location,Updated,Commercial Flow,Travellers Flow',
      '"Woodstock Road","Woodstock, NB / Houlton, ME","2026-11-20 13:00","No Delay","Not Applicable"',
    ].join('\n');
    const commaRecords = parseCbsaCsv(commaCsv);
    expect(commaRecords).toHaveLength(1);
    expect(commaRecords[0].officeName).toBe('Woodstock Road');
    expect(commaRecords[0].commercialNorthboundMinutes).toBe(0);
    expect(commaRecords[0].travellerNorthboundMinutes).toBeNull();
  });

  it('parses official CBP XML including standard, FAST, and Not Applicable lanes', () => {
    const records = parseCbpXml(SAMPLE_CBP_XML);
    expect(records).toHaveLength(3);

    expect(records[0]).toMatchObject({
      portNumber: '380101',
      cbpCode: '3801',
      crossingName: 'Ambassador Bridge',
      commercialStandardMinutes: 25,
      commercialFastMinutes: 0,
      commercialLanesOpen: 5,
      passengerStandardMinutes: 10,
    });

    expect(records[1]).toMatchObject({
      portNumber: '090101',
      cbpCode: '0901',
      crossingName: 'Peace Bridge',
      commercialStandardMinutes: 0,
      commercialFastMinutes: null,
      commercialLanesOpen: 4,
    });

    expect(records[2]).toMatchObject({
      portNumber: '2304',
      cbpCode: '2304',
      commercialStandardMinutes: 55,
      commercialFastMinutes: 15,
      commercialLanesOpen: 12,
    });
  });

  it('syncs, caches in KV with 900s TTL, and returns stale cached snapshot on upstream outage without fabricating numbers', async () => {
    const { kv, store } = createMemoryKv();

    const liveFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === CBSA_BWT_CSV_URL) {
        return new Response(SAMPLE_CBSA_CSV, { status: 200 });
      }
      if (url === CBP_BWT_XML_URL) {
        return new Response(SAMPLE_CBP_XML, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    const synced = await syncBorderWaitTimes({ CACHE: kv }, liveFetch);
    expect(synced.stale).toBe(false);
    expect(synced.sources.cbsa.ok).toBe(true);
    expect(synced.sources.cbp.ok).toBe(true);
    expect(synced.ports).toHaveLength(NORTH_AMERICAN_PORTS.length);

    const ambassador = synced.ports.find((p) => p.cbpCode === '3801');
    expect(ambassador).toMatchObject({
      northboundCommercialMinutes: 25,
      southboundCommercialMinutes: 25,
      southboundFastMinutes: 0,
      commercialLanesOpen: 5,
      status: 'delayed',
    });

    const peaceBridge = synced.ports.find((p) => p.cbpCode === '0901');
    expect(peaceBridge).toMatchObject({
      northboundCommercialMinutes: 0,
      southboundCommercialMinutes: 0,
      southboundFastMinutes: null,
      status: 'open',
    });

    const laredo = synced.ports.find((p) => p.cbpCode === '2304');
    expect(laredo).toMatchObject({
      southboundCommercialMinutes: 55,
      status: 'congested',
    });

    const cachedEntry = store.get(BORDER_WAIT_CACHE_KEY);
    expect(cachedEntry?.expirationTtl).toBe(BORDER_WAIT_CACHE_TTL_SECONDS);

    // Cache hit via getBorderWaitTimes should not invoke fetch
    const neverFetch: typeof fetch = vi.fn(() => {
      throw new Error('Should not fetch on warm KV cache');
    });
    const fromCache = await getBorderWaitTimes({ CACHE: kv }, neverFetch);
    expect(fromCache.ports.find((p) => p.cbpCode === '3801')?.southboundCommercialMinutes).toBe(25);

    // Upstream outage should return last cached snapshot with stale: true
    const failingFetch: typeof fetch = vi.fn(async () => new Response('Service Unavailable', { status: 503 }));
    const staleFallback = await syncBorderWaitTimes({ CACHE: kv }, failingFetch);
    expect(staleFallback.stale).toBe(true);
    expect(staleFallback.sources.cbsa.ok).toBe(false);
    expect(staleFallback.sources.cbp.ok).toBe(false);
    expect(staleFallback.ports.find((p) => p.cbpCode === '3801')?.southboundCommercialMinutes).toBe(25);

    // Outage with empty cache must return null values (never fabricate random numbers)
    const emptyKv = createMemoryKv();
    const emptyFallback = await syncBorderWaitTimes({ CACHE: emptyKv.kv }, failingFetch);
    expect(emptyFallback.stale).toBe(true);
    expect(
      emptyFallback.ports.every(
        (p) =>
          p.northboundCommercialMinutes === null &&
          p.southboundCommercialMinutes === null &&
          p.status === 'unavailable',
      ),
    ).toBe(true);
  });

  it('cron handler syncs wait times and broadcasts to OPS_HUB when bound', async () => {
    const { kv } = createMemoryKv();
    const hubFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const opsHub = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: hubFetch })),
    } as unknown as DurableObjectNamespace;

    const liveFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === CBSA_BWT_CSV_URL) return new Response(SAMPLE_CBSA_CSV, { status: 200 });
      return new Response(SAMPLE_CBP_XML, { status: 200 });
    });

    const result = await runBorderSync({ CACHE: kv, OPS_HUB: opsHub }, '*/10 * * * *', liveFetch);
    expect(result.hubNotified).toBe(true);
    expect(result.feed.stale).toBe(false);
    expect(hubFetch).toHaveBeenCalledTimes(1);
  });
});

describe('FMCSA Carrier Verification & Double-Brokering Fraud Risk Engine', () => {
  const baseHealthyCarrier: FmcsaCarrierRecord = {
    dotNumber: '224466',
    legalName: 'NORTH ATLANTIC EXPRESS LTD',
    dbaName: null,
    allowedToOperate: true,
    statusCode: 'A',
    oosDate: null,
    commonAuthorityStatus: 'A',
    contractAuthorityStatus: 'N',
    brokerAuthorityStatus: 'N',
    bipdInsuranceOnFileCents: 100_000_000, // $1,000,000 USD
    bipdInsuranceRequiredCents: MIN_BIPD_INSURANCE_CENTS,
    cargoInsuranceOnFileCents: 25_000_000,
    totalPowerUnits: 12,
    totalDrivers: 14,
    safetyRating: 'S',
    phyCity: 'HALIFAX',
    phyState: 'NS',
    phyCountry: 'CA',
    fetchedAt: '2026-11-20T12:00:00.000Z',
  };

  it('approves a compliant carrier operating below fleet capacity', () => {
    const risk = evaluateCarrierFraudRisk(baseHealthyCarrier, 4);
    expect(risk.approved).toBe(true);
    expect(risk.flags).toEqual([]);
    expect(risk.riskLevel).toBe('LOW');
    expect(risk.riskScore).toBe(0);
  });

  it('detects NOT_AUTHORIZED, INSURANCE_DEFICIENT, DOUBLE_BROKERING_CAPACITY_ANOMALY, and BROKER_ONLY_AUTHORITY', () => {
    const notAuthorized = evaluateCarrierFraudRisk(
      { ...baseHealthyCarrier, allowedToOperate: false, oosDate: '2026-09-01' },
      1,
    );
    expect(notAuthorized.approved).toBe(false);
    expect(notAuthorized.flags).toContain('NOT_AUTHORIZED');

    const lowInsurance = evaluateCarrierFraudRisk(
      { ...baseHealthyCarrier, bipdInsuranceOnFileCents: 50_000_000 }, // $500,000 < $750,000
      1,
    );
    expect(lowInsurance.approved).toBe(false);
    expect(lowInsurance.flags).toContain('INSURANCE_DEFICIENT');

    const exactBoundaryInsurance = evaluateCarrierFraudRisk(
      { ...baseHealthyCarrier, bipdInsuranceOnFileCents: 75_000_000 }, // exactly $750,000
      1,
    );
    expect(exactBoundaryInsurance.flags).not.toContain('INSURANCE_DEFICIENT');

    const capacityExhausted = evaluateCarrierFraudRisk(baseHealthyCarrier, 12);
    expect(capacityExhausted.approved).toBe(false);
    expect(capacityExhausted.flags).toContain('DOUBLE_BROKERING_CAPACITY_ANOMALY');

    const zeroTrucks = evaluateCarrierFraudRisk(
      { ...baseHealthyCarrier, totalPowerUnits: 0 },
      0,
    );
    expect(zeroTrucks.approved).toBe(false);
    expect(zeroTrucks.flags).toContain('DOUBLE_BROKERING_CAPACITY_ANOMALY');

    const brokerOnly = evaluateCarrierFraudRisk(
      {
        ...baseHealthyCarrier,
        commonAuthorityStatus: 'N',
        contractAuthorityStatus: 'N',
        brokerAuthorityStatus: 'A',
      },
      1,
    );
    expect(brokerOnly.approved).toBe(false);
    expect(brokerOnly.flags).toContain('BROKER_ONLY_AUTHORITY');
  });

  it('returns deterministic dev fixtures in development and fails closed in production when FMCSA_WEB_KEY is missing', async () => {
    const devHealthy = await verifyFmcsaCarrier('123456', { ENVIRONMENT: 'development' }, 2);
    expect(devHealthy.verified).toBe(true);
    expect(devHealthy.source).toBe('dev_fixture');
    expect(devHealthy.fraudAssessment?.approved).toBe(true);

    const devFraud = await verifyFmcsaCarrier('999999', { ENVIRONMENT: 'development' }, 0);
    expect(devFraud.verified).toBe(true);
    expect(devFraud.fraudAssessment?.approved).toBe(false);
    expect(devFraud.fraudAssessment?.flags).toEqual(
      expect.arrayContaining([
        'NOT_AUTHORIZED',
        'BROKER_ONLY_AUTHORITY',
        'INSURANCE_DEFICIENT',
        'DOUBLE_BROKERING_CAPACITY_ANOMALY',
      ]),
    );

    const prodFailClosed = await verifyFmcsaCarrier('123456', { ENVIRONMENT: 'production' }, 0);
    expect(prodFailClosed.verified).toBe(false);
    expect(prodFailClosed.reason).toBe('FMCSA_KEY_UNCONFIGURED');
    expect(prodFailClosed.record).toBeNull();
  });

  it('queries live FMCSA QCMobile API and caches parsed record in KV for 24h', async () => {
    const { kv, store } = createMemoryKv();
    const mockQcmobilePayload = {
      content: {
        carrier: {
          dotNumber: 554433,
          legalName: 'ST LAWRENCE COLD CHAIN INC',
          allowedToOperate: 'Y',
          statusCode: 'A',
          oosDate: null,
          commonAuthorityStatus: 'A',
          contractAuthorityStatus: 'N',
          brokerAuthorityStatus: 'N',
          bipdInsuranceOnFile: '1000', // QCMobile thousands = $1,000,000 USD
          bipdRequiredAmount: '750',
          cargoInsuranceOnFile: '250',
          totalPowerUnits: 8,
          totalDrivers: 10,
          safetyRating: 'S',
        },
      },
    };

    const parsed = parseFmcsaQcmobileResponse(mockQcmobilePayload, '554433');
    expect(parsed?.bipdInsuranceOnFileCents).toBe(100_000_000);

    const fetchMock: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      expect(url).toContain('/carriers/554433?webKey=test-fmcsa-key');
      return new Response(JSON.stringify(mockQcmobilePayload), { status: 200 });
    });

    const first = await verifyFmcsaCarrier(
      '554433',
      { FMCSA_WEB_KEY: 'test-fmcsa-key', ENVIRONMENT: 'production', CACHE: kv },
      2,
      fetchMock,
    );
    expect(first.verified).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.fraudAssessment?.approved).toBe(true);
    expect(store.get('fmcsa:carrier:554433')?.expirationTtl).toBe(FMCSA_CACHE_TTL_SECONDS);

    // Second call hits KV cache and evaluates new active load count dynamically
    const second = await verifyFmcsaCarrier(
      '554433',
      { FMCSA_WEB_KEY: 'test-fmcsa-key', ENVIRONMENT: 'production', CACHE: kv },
      8,
      fetchMock,
    );
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fraudAssessment?.flags).toContain('DOUBLE_BROKERING_CAPACITY_ANOMALY');
  });
});

describe('Highway Routing — OSRM, Deterministic Haversine × 1.22 Fallback & Nearest Port Detection', () => {
  it('uses OSRM response when available and caches subsequent requests in KV', async () => {
    const { kv } = createMemoryKv();
    const osrmFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      // Verify lon,lat order for OSRM
      expect(url).toContain('-63.1311,46.2382;-71.0589,42.3601');
      return new Response(
        JSON.stringify({
          code: 'Ok',
          routes: [{ distance: 1_042_500, duration: 39_600 }],
        }),
        { status: 200 },
      );
    });

    const first = await calculateHighwayRoute(
      46.2382,
      -63.1311,
      42.3601,
      -71.0589,
      'CA',
      'US',
      kv,
      osrmFetch,
    );
    expect(first.source).toBe('osrm');
    expect(first.cached).toBe(false);
    expect(first.distanceKm).toBe(1042.5);
    expect(first.durationMinutes).toBe(660);
    expect(first.isCrossBorder).toBe(true);
    expect(first.recommendedPort?.cbpCode).toBe('0115'); // Calais, ME / St. Stephen, NB

    const second = await calculateHighwayRoute(
      46.2382,
      -63.1311,
      42.3601,
      -71.0589,
      'CA',
      'US',
      kv,
      osrmFetch,
    );
    expect(second.cached).toBe(true);
    expect(second.distanceKm).toBe(1042.5);
    expect(osrmFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically to Haversine × 1.22 when OSRM fails', async () => {
    const failingFetch: typeof fetch = vi.fn(async () => {
      throw new Error('OSRM unreachable');
    });

    const oLat = 45.5017;
    const oLon = -73.5673; // Montreal, QC
    const dLat = 40.7128;
    const dLon = -74.006; // New York, NY

    const result = await calculateHighwayRoute(
      oLat,
      oLon,
      dLat,
      dLon,
      'CA',
      'US',
      undefined,
      failingFetch,
    );

    const expectedKm = Number(
      (haversineKm(oLat, oLon, dLat, dLon) * HAVERSINE_HIGHWAY_CIRCUITY_FACTOR).toFixed(1),
    );
    expect(result.source).toBe('haversine_adjusted');
    expect(result.distanceKm).toBe(expectedKm);
    expect(result.isCrossBorder).toBe(true);
    expect(result.recommendedPort?.cbpCode).toBe('0712'); // Champlain, NY / Lacolle, QC
  });

  it('detects optimal North American commercial border ports and omits port for domestic routes', () => {
    // Domestic Canada -> null port
    expect(findNearestBorderPort(46.24, -63.13, 43.65, -79.38, 'CA', 'CA')).toBeNull();

    // Vancouver, BC -> Seattle, WA => Pacific Highway (3004)
    const west = findNearestBorderPort(49.2827, -123.1207, 47.6062, -122.3321, 'CA', 'US');
    expect(west?.port.cbpCode).toBe('3004');

    // Toronto, ON -> Chicago, IL => Sarnia Blue Water Bridge (3802) or Detroit (3801/3807)
    const midwest = findNearestBorderPort(43.6532, -79.3832, 41.8781, -87.6298, 'CA', 'US');
    expect(['3802', '3801', '3807']).toContain(midwest?.port.cbpCode);

    // Dallas, TX -> Monterrey, MX => Laredo World Trade Bridge (2304)
    const mexico = findNearestBorderPort(32.7767, -96.797, 25.6866, -100.3161, 'US', 'MX');
    expect(mexico?.port.cbpCode).toBe('2304');
  });
});

describe('Transactional Email — HTML Escaping & Resend Dispatch', () => {
  it('escapes XSS script tags and dangerous HTML entities', () => {
    const xss = '<script>alert(1)</script>';
    const escaped = escapeHtml(xss);
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped).not.toContain('<script>');

    expect(escapeHtml(`"O'Reilly" & <img onerror=alert(1)>`)).toBe(
      '&quot;O&#39;Reilly&quot; &amp; &lt;img onerror=alert(1)&gt;',
    );
  });

  it('escapes all user fields across quote, escalation, invoice, and OTP emails and checks res.ok', async () => {
    const sentBodies: Array<{ subject: string; html: string }> = [];
    const okFetch: typeof fetch = vi.fn(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as { subject: string; html: string };
      sentBodies.push(parsed);
      return new Response(JSON.stringify({ id: 're_test_123' }), { status: 200 });
    });

    const env = { RESEND_API_KEY: 're_live_key' };

    const quoteRes = await sendQuoteEmail(
      env,
      {
        to: 'shipper@example.com',
        quoteReference: 'QT-9001',
        contactName: '<script>alert(1)</script>',
        origin: 'Charlottetown, PE',
        destination: 'Boston, MA',
        equipmentLabel: '53ft Reefer',
        distanceKm: 1045,
        weightLbs: 39000,
        commodity: '<b>Frozen Seafood</b>',
        linehaulCents: 280_000,
        fuelSurchargeCents: 45_000,
        customsBrokerageCents: 18_500,
        accessorialsCents: 31_500,
        totalCents: 375_000,
        currency: 'CAD',
        estimatedTransitHours: 24,
        recommendedPortName: 'Calais, ME / St. Stephen, NB',
      },
      okFetch,
    );
    expect(quoteRes).toEqual({ sent: true, id: 're_test_123' });

    const escRes = await sendEscalationEmail(
      env,
      {
        to: 'ops@brotransport.com',
        ticketId: 'ESC-42',
        severity: 'critical',
        category: 'border_hold',
        contactName: 'Dispatcher <script>alert(1)</script>',
        contactChannel: '+1-902-555-0199',
        summary: 'CBSA hold <script>alert(1)</script> at Lacolle',
      },
      okFetch,
    );
    expect(escRes.sent).toBe(true);

    const invRes = await sendInvoiceEmail(
      env,
      {
        to: 'ap@example.com',
        invoiceNumber: 'INV-2026-001',
        shipperName: 'Acme <script>alert(1)</script>',
        loadReference: 'BROP-2026-100',
        subtotalCents: 350_000,
        taxCents: 0,
        totalCents: 350_000,
        currency: 'CAD',
        taxLabel: 'Zero-Rated International Freight (0%)',
        dueDateIso: '2026-12-20',
        paymentPortalUrl: 'javascript:alert(1)',
      },
      okFetch,
    );
    expect(invRes.sent).toBe(true);

    const otpRes = await sendOtpEmail(
      env,
      {
        to: 'driver@example.com',
        recipientName: '<script>alert(1)</script>',
        otpCode: '847291',
      },
      okFetch,
    );
    expect(otpRes.sent).toBe(true);

    expect(sentBodies).toHaveLength(4);
    for (const body of sentBodies) {
      expect(body.html).not.toContain('<script>');
      expect(body.html).not.toContain('javascript:alert(1)');
    }
    expect(sentBodies[0].html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sentBodies[0].html).toContain('$3,750.00 CAD');

    // Non-OK response must return { sent: false, error }
    const errFetch: typeof fetch = vi.fn(
      async () => new Response('Invalid domain', { status: 422 }),
    );
    const failedRes = await sendOtpEmail(
      env,
      { to: 'driver@example.com', otpCode: '123456' },
      errFetch,
    );
    expect(failedRes.sent).toBe(false);
    expect(failedRes.error).toContain('422');

    // Missing RESEND_API_KEY fails closed
    const unconfigured = await sendOtpEmail(
      {},
      { to: 'driver@example.com', otpCode: '123456' },
      okFetch,
    );
    expect(unconfigured).toEqual({ sent: false, error: 'RESEND_API_KEY_UNCONFIGURED' });
  });
});

describe('Offline Proof-of-Work Verifier — Valid, Forged, Expired & Replayed Tokens', () => {
  it('accepts a genuinely mined >=16-bit SHA-256 token and blocks KV replay', async () => {
    const { kv, store } = createMemoryKv();
    const nowMs = 1_795_000_000_000;
    const payloadHash = await sha256Hex('{"driverEmail":"owner@brotransport.com","usdot":"123456"}');
    const validToken = await mineValidPowToken(nowMs - 30_000, payloadHash, 16);

    const firstCheck = await verifyOfflinePowToken(validToken, payloadHash, kv, { nowMs });
    expect(firstCheck.valid).toBe(true);
    expect(firstCheck.reason).toBe('VERIFIED');
    expect(firstCheck.leadingZeroBits).toBeGreaterThanOrEqual(16);
    expect(firstCheck.digestHex).toMatch(/^0000[0-9a-f]{60}$/);

    const replayKey = `pow:used:${firstCheck.digestHex}`;
    expect(store.get(replayKey)?.expirationTtl).toBe(POW_REPLAY_TTL_SECONDS);

    // Replaying the exact same valid token must be rejected
    const replayCheck = await verifyOfflinePowToken(validToken, payloadHash, kv, { nowMs });
    expect(replayCheck.valid).toBe(false);
    expect(replayCheck.reason).toBe('TOKEN_REPLAYED');
  }, 15_000);

  it('rejects forged (insufficient work), payload-tampered, expired, future, and malformed tokens', async () => {
    const nowMs = 1_795_000_000_000;
    const payloadHash = await sha256Hex('carrier-intake-payload');
    const otherPayloadHash = await sha256Hex('tampered-payload');

    // Forged nonce that does not achieve 16 leading zero bits
    let forgedToken = '';
    for (let i = 0; i < 100; i++) {
      const candidate = `${nowMs - 5_000}:forged${i}:${payloadHash}`;
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate)),
      );
      if (countLeadingZeroBits(digest) < 16) {
        forgedToken = candidate;
        break;
      }
    }
    const forgedResult = await verifyOfflinePowToken(forgedToken, payloadHash, undefined, { nowMs });
    expect(forgedResult.valid).toBe(false);
    expect(forgedResult.reason).toBe('INSUFFICIENT_WORK');

    // Valid PoW mined for one payload rejected against tampered payload hash
    const minedForOriginal = await mineValidPowToken(nowMs - 10_000, payloadHash, 16);
    const mismatchResult = await verifyOfflinePowToken(
      minedForOriginal,
      otherPayloadHash,
      undefined,
      { nowMs },
    );
    expect(mismatchResult.valid).toBe(false);
    expect(mismatchResult.reason).toBe('PAYLOAD_HASH_MISMATCH');

    // Expired token (> 24 hours old)
    const expiredTimestamp = nowMs - POW_MAX_AGE_MS - 1_000;
    const expiredToken = `${expiredTimestamp}:abc123:${payloadHash}`;
    const expiredResult = await verifyOfflinePowToken(expiredToken, payloadHash, undefined, {
      nowMs,
    });
    expect(expiredResult.valid).toBe(false);
    expect(expiredResult.reason).toBe('TOKEN_EXPIRED');

    // Future-dated token (> 5 minutes ahead)
    const futureToken = `${nowMs + 10 * 60 * 1000}:abc123:${payloadHash}`;
    const futureResult = await verifyOfflinePowToken(futureToken, payloadHash, undefined, {
      nowMs,
    });
    expect(futureResult.valid).toBe(false);
    expect(futureResult.reason).toBe('TOKEN_FUTURE_TIMESTAMP');

    // Malformed token syntax
    const malformedResult = await verifyOfflinePowToken('not-a-valid-token', payloadHash, undefined, {
      nowMs,
    });
    expect(malformedResult.valid).toBe(false);
    expect(malformedResult.reason).toBe('MALFORMED_TOKEN');
  }, 15_000);
});
