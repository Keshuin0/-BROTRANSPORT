import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  validateCustomsManifest,
  type CustomsManifestInput,
} from '@bro/contracts';
import {
  CODE128_PATTERNS,
  encodeCode128B,
  renderCode128Svg,
} from '../../../src/lib/barcode.js';
import {
  computeGenesisHash,
  createSignedEbolBlock,
  generateActorKeyPair,
} from '../../../src/lib/ebolCrypto.js';
import {
  generateCustomsCoverSheetPdf,
  generateEbolCertificatePdf,
  generateInvoicePdf,
  generateSettlementPdf,
  mergeFactoringPacketPdf,
} from '../pdfGenerator.js';

function assertPdf17Header(bytes: Uint8Array): void {
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(bytes.byteLength).toBeGreaterThan(500);
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 8));
  expect(header).toBe('%PDF-1.7');
}

describe('Code-128B Barcode Encoder & SVG Renderer (ISO/IEC 15417)', () => {
  it('maintains a mathematically valid 107-pattern ISO/IEC 15417 encoding table', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    const seen = new Set<string>();
    for (let i = 0; i < 106; i++) {
      const pattern = CODE128_PATTERNS[i];
      expect(pattern).toHaveLength(6);
      const widths = pattern.split('').map(Number);
      const total = widths.reduce((sum, w) => sum + w, 0);
      const barSum = widths[0] + widths[2] + widths[4];
      expect(total).toBe(11);
      expect(barSum % 2).toBe(0); // ISO/IEC 15417 even bar parity
      expect(seen.has(pattern)).toBe(false);
      seen.add(pattern);
    }
    expect(CODE128_PATTERNS[106]).toBe('2331112'); // 13-module Stop pattern
  });

  it('computes exact modulo-103 checksum and modules for BROP8843921', () => {
    const encoded = encodeCode128B('BROP8843921');
    // Manual ISO/IEC 15417 verification:
    // Start B (104) + B(34)*1 + R(50)*2 + O(47)*3 + P(48)*4 + 8(24)*5 + 8(24)*6 + 4(20)*7 + 3(19)*8 + 9(25)*9 + 2(18)*10 + 1(17)*11
    // = 104 + 34 + 100 + 141 + 192 + 120 + 144 + 140 + 152 + 225 + 180 + 187 = 1719
    // 1719 mod 103 = 71
    expect(encoded.checksum).toBe(71);

    // Module count: (Start 1 + Data 11 + Checksum 1) * 11 + Stop 13 = 156 modules
    expect(encoded.modules).toHaveLength(156);
    expect(encoded.modules.every((m) => m === 0 || m === 1)).toBe(true);

    // Starts with Start Code B (211214 -> 11010010000)
    expect(encoded.modules.slice(0, 11)).toEqual([1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
    // Ends with Stop pattern (2331112 -> 1100011101011)
    expect(encoded.modules.slice(-13)).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1]);
  });

  it('renders crisp laser-scannable SVG with white quiet zone, dark bars, and escaped label', () => {
    const svg = renderCode128Svg('BROP8843921', { height: 70, moduleWidth: 2, includeText: true });
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('>BROP8843921</text>');
    expect(svg).toContain('role="img"');

    const noTextSvg = renderCode128Svg('BROP8843921', { includeText: false });
    expect(noTextSvg).not.toContain('<text');

    const escapedSvg = renderCode128Svg('A&B<1>');
    expect(escapedSvg).toContain('A&amp;B&lt;1&gt;');
  });
});

describe('Edge pdf-lib Generator — Customs, Invoices, Factoring Merge, Settlements & eBOL Certificates', () => {
  const sampleManifest: CustomsManifestInput = {
    manifestType: 'ACE_PAPS',
    scacOrCarrierCode: 'BROP',
    controlNumber: 'BROP8843921',
    tripNumber: 'BROP20261120A',
    portCode: '0115',
    etaUtc: '2026-11-20T15:00:00Z',
    conveyance: {
      vin: '1HGCM82633A004352',
      plate: 'PE9948',
      jurisdiction: 'PE',
    },
    crew: [
      {
        fastCardNumber: '980012345',
        firstName: 'Liam',
        lastName: 'Gallant',
        dateOfBirth: '1984-05-10',
      },
    ],
    carmIorAccountVerified: false,
    fdaPriorNoticeNumber: 'FDA-PN-99887766',
    shipments: [
      {
        commodity: 'Fresh PEI Potatoes',
        hsCode: '070190',
        countryOfOrigin: 'CA',
        cusmaCertOnFile: true,
        invoiceValueCents: 4200000,
        currency: 'USD',
        weightKg: 21500,
        quantity: 24,
        packageType: 'Pallet',
        isFoodFda: true,
        shipperName: 'Cavendish Valley Produce Co.',
        shipperAddress: '100 Harvest Rd, Summerside, PE',
        consigneeName: 'New England Fresh Market Hub',
        consigneeAddress: '45 Terminal Way, Boston, MA',
      },
    ],
  };

  it('generates valid %PDF-1.7 ACE PAPS & ACI PARS Customs Cover Sheets with Code-128 barcodes', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const report = validateCustomsManifest(sampleManifest, now);
    expect(report.compliant).toBe(true);

    const papsPdf = await generateCustomsCoverSheetPdf(sampleManifest, report);
    assertPdf17Header(papsPdf);
    const parsedPaps = await PDFDocument.load(papsPdf);
    expect(parsedPaps.getPageCount()).toBeGreaterThanOrEqual(1);

    const parsManifest: CustomsManifestInput = {
      ...sampleManifest,
      manifestType: 'ACI_PARS',
      controlNumber: 'BROP7712044',
      portCode: '0712',
      carmIorAccountVerified: true,
      carmImporterBnRm: '123456789RM0001',
      shipments: [
        {
          ...sampleManifest.shipments[0],
          commodity: 'Industrial Packaging Equipment',
          hsCode: '842240',
          countryOfOrigin: 'US',
          isFoodFda: false,
        },
      ],
    };
    const parsReport = validateCustomsManifest(parsManifest, now);
    const parsPdf = await generateCustomsCoverSheetPdf(parsManifest, parsReport);
    assertPdf17Header(parsPdf);
    const parsedPars = await PDFDocument.load(parsPdf);
    expect(parsedPars.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('generates valid %PDF-1.7 Commercial Freight Invoices in integer cents', async () => {
    const invoicePdf = await generateInvoicePdf({
      invoiceNumber: 'INV-2026-00421',
      orgName: 'Cavendish Valley Produce Co.',
      orgAddress: '100 Harvest Rd, Summerside, PE C1N 4J8, Canada',
      loadNumber: 'BROP-2026-8843',
      currency: 'CAD',
      lineItems: [
        { code: 'LH', description: '53ft Reefer Linehaul: Summerside, PE -> Boston, MA', quantity: 1, unitPriceCents: 315000, amountCents: 315000 },
        { code: 'FSC', description: 'Fuel Surcharge (NRCan Diesel Index)', quantity: 1, unitPriceCents: 48500, amountCents: 48500 },
        { code: 'CUST', description: 'ACE PAPS & FDA Prior Notice Border Filing', quantity: 1, unitPriceCents: 25000, amountCents: 25000 },
      ],
      subtotalCents: 388500,
      taxCents: 0,
      taxLabel: 'Zero-Rated International Freight (0%)',
      totalCents: 388500,
      issuedDateIso: '2026-11-20T12:00:00Z',
      dueDateIso: '2026-12-20T12:00:00Z',
      taxCitation: 'Canada ETA Sch. VI, Part VII, s. 7',
    });

    assertPdf17Header(invoicePdf);
    const parsed = await PDFDocument.load(invoicePdf);
    expect(parsed.getPageCount()).toBe(1);
  });

  it('generates valid %PDF-1.7 Driver Settlement Statements in integer cents', async () => {
    const settlementPdf = await generateSettlementPdf({
      settlementNumber: 'SET-2026-W47-014',
      driverName: 'Liam Gallant',
      periodLabel: '2026-11-09 to 2026-11-15',
      currency: 'CAD',
      loads: [
        {
          loadNumber: 'BROP-2026-8843',
          lane: 'Summerside, PE -> Boston, MA',
          deliveredDate: '2026-11-11',
          loadedMiles: 612,
          grossPayCents: 185000,
        },
        {
          loadNumber: 'BROP-2026-8869',
          lane: 'Boston, MA -> Moncton, NB',
          deliveredDate: '2026-11-14',
          loadedMiles: 448,
          grossPayCents: 142000,
        },
      ],
      deductions: [
        { code: 'FUEL', label: 'Fleet Card Diesel Advance', amountCents: 64200 },
        { code: 'INS', label: 'Occupational Accident Insurance', amountCents: 12500 },
      ],
      grossPayCents: 327000,
      reimbursementsCents: 18500,
      deductionsCents: 76700,
      netPayCents: 268800,
    });

    assertPdf17Header(settlementPdf);
    const parsed = await PDFDocument.load(settlementPdf);
    expect(parsed.getPageCount()).toBe(1);
  });

  it('generates valid %PDF-1.7 Cryptographic eBOL Verification Certificates', async () => {
    const loadId = 'LOAD-BROP-CERT-99';
    const [shipper, driver, consignee] = await Promise.all([
      generateActorKeyPair(),
      generateActorKeyPair(),
      generateActorKeyPair(),
    ]);
    const genesis = await computeGenesisHash(loadId);
    const b1 = await createSignedEbolBlock({
      loadId,
      seq: 1,
      stage: 'SHIPPER_INIT',
      actorRole: 'shipper',
      actorName: 'Cavendish Valley Produce Co.',
      privateKey: shipper.privateKey,
      publicKeyJwk: shipper.publicKeyJwk,
      prevHash: genesis,
      payload: { pieces: 24, commodity: 'PEI Potatoes' },
      gpsLat: 46.3959,
      gpsLon: -63.7876,
      signedAt: 1795176000000,
    });
    const b2 = await createSignedEbolBlock({
      loadId,
      seq: 2,
      stage: 'CARRIER_PICKUP',
      actorRole: 'driver',
      actorName: 'Liam Gallant',
      privateKey: driver.privateKey,
      publicKeyJwk: driver.publicKeyJwk,
      prevHash: b1.blockHash,
      payload: { sealVerified: true, reeferTempC: 3.9 },
      gpsLat: 46.3961,
      gpsLon: -63.7872,
      signedAt: 1795179600000,
    });
    const b3 = await createSignedEbolBlock({
      loadId,
      seq: 3,
      stage: 'CONSIGNEE_POD',
      actorRole: 'consignee',
      actorName: 'Boston Fresh Hub',
      privateKey: consignee.privateKey,
      publicKeyJwk: consignee.publicKeyJwk,
      prevHash: b2.blockHash,
      payload: { piecesReceived: 24, exceptions: 'NONE' },
      gpsLat: 42.3418,
      gpsLon: -71.0365,
      signedAt: 1795222800000,
    });

    const certPdf = await generateEbolCertificatePdf(
      'BROP-2026-8843',
      [b1, b2, b3],
      'https://brotransport.com/verify/ebol/LOAD-BROP-CERT-99',
    );
    assertPdf17Header(certPdf);
    const parsed = await PDFDocument.load(certPdf);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('merges multiple PDFs into a Factoring Packet with exact combined page count', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const report = validateCustomsManifest(sampleManifest, now);
    const customsPdf = await generateCustomsCoverSheetPdf(sampleManifest, report);

    const invoicePdf = await generateInvoicePdf({
      invoiceNumber: 'INV-2026-00422',
      orgName: 'Atlantic Cold Storage Ltd.',
      orgAddress: '220 Port Rd, Moncton, NB',
      loadNumber: 'BROP-2026-8844',
      currency: 'CAD',
      lineItems: [
        { code: 'LH', description: 'Linehaul Freight', quantity: 1, unitPriceCents: 240000, amountCents: 240000 },
      ],
      subtotalCents: 240000,
      taxCents: 36000,
      taxLabel: 'NB HST (15%)',
      totalCents: 276000,
      issuedDateIso: '2026-11-20T12:00:00Z',
      dueDateIso: '2026-12-20T12:00:00Z',
    });

    const pagesA = (await PDFDocument.load(customsPdf)).getPageCount();
    const pagesB = (await PDFDocument.load(invoicePdf)).getPageCount();

    const merged = await mergeFactoringPacketPdf([customsPdf, invoicePdf]);
    assertPdf17Header(merged);

    const parsedMerged = await PDFDocument.load(merged);
    expect(parsedMerged.getPageCount()).toBe(pagesA + pagesB);
  });
});
