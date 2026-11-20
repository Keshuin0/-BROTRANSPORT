import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type {
  Currency,
  CustomsManifestInput,
  CustomsValidationReport,
  EbolBlockRecord,
  InvoiceLineItem,
} from '@bro/contracts';
import { encodeCode128B } from '../../src/lib/barcode.js';
import { computeGenesisHash, computeJwkThumbprint, verifyEbolChain } from '../../src/lib/ebolCrypto.js';

const PAGE_WIDTH = 612; // US Letter 8.5 in @ 72 pt/in
const PAGE_HEIGHT = 792; // US Letter 11.0 in @ 72 pt/in
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 540 pt

const COLOR_OBSIDIAN = rgb(0.047, 0.086, 0.157); // #0c1628
const COLOR_SLATE_DARK = rgb(0.118, 0.161, 0.231); // #1e293b
const COLOR_SLATE_MUTED = rgb(0.392, 0.455, 0.545); // #64748b
const COLOR_BORDER = rgb(0.804, 0.839, 0.882); // #cdd6e1
const COLOR_ROW_ALT = rgb(0.957, 0.969, 0.984); // #f4f7fb
const COLOR_WHITE = rgb(1, 1, 1);
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_CYAN = rgb(0.024, 0.714, 0.831); // #06b6d4
const COLOR_GOLD = rgb(0.851, 0.624, 0.024); // #d99f06
const COLOR_GREEN = rgb(0.063, 0.525, 0.294); // #10864b
const COLOR_GREEN_BG = rgb(0.914, 0.976, 0.941);
const COLOR_CRIMSON = rgb(0.761, 0.141, 0.188); // #c22430
const COLOR_CRIMSON_BG = rgb(0.992, 0.929, 0.933);
const COLOR_AMBER = rgb(0.706, 0.435, 0.024);
const COLOR_AMBER_BG = rgb(0.996, 0.961, 0.89);

export interface InvoicePdfInput {
  invoiceNumber: string;
  orgName: string;
  orgAddress: string;
  loadNumber: string;
  currency: Currency;
  lineItems: InvoiceLineItem[];
  subtotalCents: number;
  taxCents: number;
  taxLabel: string;
  totalCents: number;
  dueDateIso: string;
  issuedDateIso: string;
  taxCitation?: string;
}

export interface SettlementLoadLine {
  loadNumber: string;
  lane?: string;
  originDest?: string;
  deliveredDate?: string;
  loadedMiles?: number;
  payModel?: string;
  grossPayCents: number;
  detentionPayCents?: number;
}

export interface SettlementDeductionLine {
  code?: string;
  label: string;
  amountCents: number;
}

export interface SettlementPdfInput {
  settlementNumber: string;
  driverName: string;
  periodLabel: string;
  currency: Currency;
  loads: SettlementLoadLine[];
  deductions: SettlementDeductionLine[];
  grossPayCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  netPayCents: number;
}

interface EmbeddedFonts {
  sans: PDFFont;
  sansBold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

/**
 * Normalizes arbitrary UTF-8 strings into WinAnsi-safe text for PDF StandardFonts.
 */
function safePdfText(input: string): string {
  const normalized = input
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2194/g, '<->')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '-')
    .replace(/\u2713|\u2714/g, '[OK]')
    .replace(/\u2717|\u2718/g, '[X]')
    .replace(/\u00A0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ');

  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += normalized[i];
    } else {
      out += '?';
    }
  }
  return out;
}

function toCode128Printable(input: string): string {
  const cleaned = safePdfText(input)
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : 'UNKNOWN';
}

/**
 * Pure integer-cent currency formatter (Law 4: zero floating-point currency math).
 */
function formatCents(cents: number, currency: Currency): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const formattedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${formattedWhole}.${String(frac).padStart(2, '0')} ${currency}`;
}

function truncateText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = safePdfText(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let end = safe.length;
  while (end > 3 && font.widthOfTextAtSize(`${safe.slice(0, end)}...`, size) > maxWidth) {
    end -= 1;
  }
  return `${safe.slice(0, Math.max(1, end))}...`;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = safePdfText(text);
  if (!safe) return [''];
  const words = safe.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
      } else {
        // Hard-break long unbroken tokens (such as URLs or 64-char SHA-256 digests)
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk.length > 0) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function embedStandardFonts(pdfDoc: PDFDocument): Promise<EmbeddedFonts> {
  const [sans, sansBold, mono, monoBold] = await Promise.all([
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
    pdfDoc.embedFont(StandardFonts.Courier),
    pdfDoc.embedFont(StandardFonts.CourierBold),
  ]);
  return { sans, sansBold, mono, monoBold };
}

function drawBrandBanner(
  page: PDFPage,
  fonts: EmbeddedFonts,
  title: string,
  subtitle: string,
  badge?: { text: string; bg: ReturnType<typeof rgb>; fg: ReturnType<typeof rgb> },
): number {
  const bannerHeight = 68;
  const bannerY = PAGE_HEIGHT - bannerHeight;

  page.drawRectangle({
    x: 0,
    y: bannerY,
    width: PAGE_WIDTH,
    height: bannerHeight,
    color: COLOR_OBSIDIAN,
  });

  // Accent stripe along bottom of header
  page.drawRectangle({
    x: 0,
    y: bannerY,
    width: PAGE_WIDTH,
    height: 3,
    color: COLOR_CYAN,
  });

  page.drawText('#BRO TRANSPORT', {
    x: MARGIN,
    y: PAGE_HEIGHT - 26,
    size: 15,
    font: fonts.sansBold,
    color: COLOR_WHITE,
  });

  page.drawText('SCAC: BROP  |  CHARLOTTETOWN, PE, CANADA  |  NORTH AMERICAN COMMERCIAL FREIGHT', {
    x: MARGIN,
    y: PAGE_HEIGHT - 40,
    size: 7.5,
    font: fonts.mono,
    color: rgb(0.65, 0.78, 0.88),
  });

  page.drawText(truncateText(title, fonts.sansBold, 11, 340), {
    x: MARGIN,
    y: PAGE_HEIGHT - 56,
    size: 11,
    font: fonts.sansBold,
    color: COLOR_GOLD,
  });

  const subWidth = fonts.sans.widthOfTextAtSize(safePdfText(subtitle), 8);
  page.drawText(safePdfText(subtitle), {
    x: PAGE_WIDTH - MARGIN - subWidth,
    y: PAGE_HEIGHT - 24,
    size: 8,
    font: fonts.sans,
    color: rgb(0.82, 0.88, 0.94),
  });

  if (badge) {
    const safeBadge = safePdfText(badge.text);
    const textW = fonts.sansBold.widthOfTextAtSize(safeBadge, 8.5);
    const padX = 10;
    const boxW = textW + padX * 2;
    const boxH = 19;
    const boxX = PAGE_WIDTH - MARGIN - boxW;
    const boxY = PAGE_HEIGHT - 54;

    page.drawRectangle({
      x: boxX,
      y: boxY,
      width: boxW,
      height: boxH,
      color: badge.bg,
    });
    page.drawText(safeBadge, {
      x: boxX + padX,
      y: boxY + 6,
      size: 8.5,
      font: fonts.sansBold,
      color: badge.fg,
    });
  }

  return bannerY - 16;
}

function drawSectionHeading(page: PDFPage, fonts: EmbeddedFonts, label: string, y: number): number {
  page.drawRectangle({
    x: MARGIN,
    y: y - 14,
    width: CONTENT_WIDTH,
    height: 16,
    color: COLOR_ROW_ALT,
  });
  page.drawRectangle({
    x: MARGIN,
    y: y - 14,
    width: 3,
    height: 16,
    color: COLOR_CYAN,
  });
  page.drawText(safePdfText(label.toUpperCase()), {
    x: MARGIN + 8,
    y: y - 10,
    size: 8.5,
    font: fonts.sansBold,
    color: COLOR_OBSIDIAN,
  });
  return y - 22;
}

/**
 * Draws a real ISO/IEC 15417 Code-128B vector barcode box onto a PDF page.
 * Renders pure black bars over a pure white 10X quiet zone for border/dock laser scanners.
 */
function drawCode128VectorBox(
  page: PDFPage,
  fonts: EmbeddedFonts,
  params: {
    caption: string;
    value: string;
    x: number;
    yTop: number;
    boxWidth: number;
    boxHeight: number;
  },
): void {
  const { caption, x, yTop, boxWidth, boxHeight } = params;
  const printableValue = toCode128Printable(params.value);
  const { modules } = encodeCode128B(printableValue);

  const boxY = yTop - boxHeight;

  // Outer pure-white laser-scannable container
  page.drawRectangle({
    x,
    y: boxY,
    width: boxWidth,
    height: boxHeight,
    color: COLOR_WHITE,
    borderColor: COLOR_BORDER,
    borderWidth: 1,
  });

  // Caption line inside top of box
  page.drawText(truncateText(caption.toUpperCase(), fonts.sansBold, 7.5, boxWidth - 16), {
    x: x + 8,
    y: yTop - 13,
    size: 7.5,
    font: fonts.sansBold,
    color: COLOR_SLATE_MUTED,
  });

  // Compute ISO 10X quiet zone & module width
  const quietModules = 10;
  const totalModules = modules.length + quietModules * 2;
  const innerMaxWidth = boxWidth - 16;
  const moduleWidth = Math.min(1.5, innerMaxWidth / totalModules);
  const symbolRenderWidth = totalModules * moduleWidth;
  const startX = x + (boxWidth - symbolRenderWidth) / 2 + quietModules * moduleWidth;

  const barHeight = Math.max(24, boxHeight - 38);
  const barY = boxY + 18;

  // Merge consecutive dark modules into single vector rectangles (zero subpixel seams)
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === 1) {
      const start = i;
      while (i < modules.length && modules[i] === 1) {
        i += 1;
      }
      const runLen = i - start;
      page.drawRectangle({
        x: startX + start * moduleWidth,
        y: barY,
        width: runLen * moduleWidth,
        height: barHeight,
        color: COLOR_BLACK,
      });
    } else {
      i += 1;
    }
  }

  // Human-readable text centered beneath bars
  const labelW = fonts.monoBold.widthOfTextAtSize(printableValue, 9.5);
  page.drawText(printableValue, {
    x: x + Math.max(8, (boxWidth - labelW) / 2),
    y: boxY + 5.5,
    size: 9.5,
    font: fonts.monoBold,
    color: COLOR_BLACK,
  });
}

function drawFooter(page: PDFPage, fonts: EmbeddedFonts, leftText: string, pageNum: number, totalPages: number): void {
  page.drawLine({
    start: { x: MARGIN, y: 34 },
    end: { x: PAGE_WIDTH - MARGIN, y: 34 },
    thickness: 0.5,
    color: COLOR_BORDER,
  });
  page.drawText(truncateText(leftText, fonts.sans, 7.5, 420), {
    x: MARGIN,
    y: 22,
    size: 7.5,
    font: fonts.sans,
    color: COLOR_SLATE_MUTED,
  });
  const rightText = `Page ${pageNum} of ${totalPages}`;
  const rw = fonts.mono.widthOfTextAtSize(rightText, 7.5);
  page.drawText(rightText, {
    x: PAGE_WIDTH - MARGIN - rw,
    y: 22,
    size: 7.5,
    font: fonts.mono,
    color: COLOR_SLATE_MUTED,
  });
}

/**
 * 1. Generates an official CBP ACE PAPS / CBSA ACI PARS Border Cover Sheet PDF
 *    with real ISO/IEC 15417 Code-128B vector barcodes for Control Number & Trip Number,
 *    conveyance VIN/Plate, FAST driver credentials, Port of Entry, and CARM/FDA stamps.
 */
export async function generateCustomsCoverSheetPdf(
  manifest: CustomsManifestInput,
  validationReport: CustomsValidationReport,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Customs Cover Sheet - ${manifest.controlNumber}`);
  pdfDoc.setCreator('#BRO Transport TMS');
  pdfDoc.setProducer('#BRO Transport Edge PDF Engine (pdf-lib)');

  const fonts = await embedStandardFonts(pdfDoc);
  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);

  const isPaps = manifest.manifestType === 'ACE_PAPS';
  const docTitle = isPaps
    ? 'U.S. CBP ACE eMANIFEST PAPS COVER SHEET (SOUTHBOUND)'
    : 'CANADA CBSA ACI eMANIFEST PARS COVER SHEET (NORTHBOUND)';

  let y = drawBrandBanner(
    page,
    fonts,
    docTitle,
    `Manifest ID: ${validationReport.manifestId}`,
    validationReport.compliant
      ? { text: 'CLEARED FOR BORDER DISPATCH', bg: COLOR_GREEN_BG, fg: COLOR_GREEN }
      : {
          text: `COMPLIANCE HOLD (${validationReport.errors.length} ERROR${validationReport.errors.length === 1 ? '' : 'S'})`,
          bg: COLOR_CRIMSON_BG,
          fg: COLOR_CRIMSON,
        },
  );

  // Side-by-side Code-128B laser-scannable barcode boxes
  const barcodeBoxW = (CONTENT_WIDTH - 12) / 2;
  const barcodeBoxH = 82;
  drawCode128VectorBox(page, fonts, {
    caption: isPaps ? 'PAPS Cargo Control Number (Code-128B)' : 'PARS Cargo Control Number (Code-128B)',
    value: manifest.controlNumber,
    x: MARGIN,
    yTop: y,
    boxWidth: barcodeBoxW,
    boxHeight: barcodeBoxH,
  });
  drawCode128VectorBox(page, fonts, {
    caption: 'Conveyance / Trip Number (Code-128B)',
    value: manifest.tripNumber,
    x: MARGIN + barcodeBoxW + 12,
    yTop: y,
    boxWidth: barcodeBoxW,
    boxHeight: barcodeBoxH,
  });
  y -= barcodeBoxH + 14;

  // Crossing & Conveyance metadata grid
  y = drawSectionHeading(page, fonts, 'Carrier, Crossing & Conveyance Identification', y);

  const drawKeyValue = (colX: number, rowY: number, label: string, val: string, mono = false) => {
    page.drawText(safePdfText(label), {
      x: colX,
      y: rowY,
      size: 7.5,
      font: fonts.sansBold,
      color: COLOR_SLATE_MUTED,
    });
    page.drawText(truncateText(val, mono ? fonts.monoBold : fonts.sansBold, 9, 165), {
      x: colX,
      y: rowY - 12,
      size: 9,
      font: mono ? fonts.monoBold : fonts.sansBold,
      color: COLOR_OBSIDIAN,
    });
  };

  const col1 = MARGIN + 4;
  const col2 = MARGIN + 184;
  const col3 = MARGIN + 364;

  drawKeyValue(col1, y, 'SCAC / CBSA CARRIER CODE', manifest.scacOrCarrierCode, true);
  drawKeyValue(col2, y, 'PORT OF ENTRY', `${manifest.portCode} - ${validationReport.portName}`);
  drawKeyValue(col3, y, 'SCHEDULED ETA (UTC)', manifest.etaUtc, true);
  y -= 30;

  drawKeyValue(col1, y, 'TRACTOR VIN (ISO 3779)', manifest.conveyance.vin, true);
  drawKeyValue(col2, y, 'LICENSE PLATE / JURISDICTION', `${manifest.conveyance.plate} (${manifest.conveyance.jurisdiction})`, true);
  drawKeyValue(
    col3,
    y,
    'PRE-ARRIVAL LEAD WINDOW',
    `${validationReport.leadTimeMinutes} min (req >= ${validationReport.requiredLeadTimeMinutes} min)`,
    true,
  );
  y -= 28;

  // Driver / FAST Crew
  y = drawSectionHeading(page, fonts, 'Commercial Driver & FAST Credentials', y);
  for (const member of manifest.crew) {
    const line = `${member.firstName} ${member.lastName}   |   FAST Card #: ${member.fastCardNumber}   |   DOB: ${member.dateOfBirth}`;
    page.drawText(truncateText(line, fonts.mono, 8.5, CONTENT_WIDTH - 12), {
      x: MARGIN + 6,
      y,
      size: 8.5,
      font: fonts.mono,
      color: COLOR_SLATE_DARK,
    });
    y -= 14;
  }
  y -= 6;

  // Regulatory Compliance Stamps (CARM Release 2 / FDA Prior Notice / Overweight)
  y = drawSectionHeading(page, fonts, 'Regulatory Gateway Stamps (CBSA CARM R2 / US FDA / Permits)', y);

  const hasFoodFda = manifest.shipments.some((s) => s.isFoodFda);
  const stamps: Array<{ title: string; detail: string; status: 'ok' | 'warn' | 'fail' }> = [];

  if (manifest.manifestType === 'ACI_PARS') {
    stamps.push({
      title: 'CBSA CARM RELEASE 2 IOR / RPP BOND',
      detail: manifest.carmIorAccountVerified
        ? `VERIFIED (${manifest.carmImporterBnRm || 'RM ACCOUNT ACTIVE'})`
        : 'FAILED - IOR PORTAL / RPP BOND NOT VERIFIED',
      status: manifest.carmIorAccountVerified ? 'ok' : 'fail',
    });
  } else {
    stamps.push({
      title: 'US CBP ACE eMANIFEST / SECTION 321-338',
      detail: `CARRIER ${manifest.scacOrCarrierCode} FILED FOR PORT ${manifest.portCode}`,
      status: 'ok',
    });
  }

  if (hasFoodFda) {
    const hasPn = Boolean(manifest.fdaPriorNoticeNumber && manifest.fdaPriorNoticeNumber.length >= 8);
    stamps.push({
      title: 'US FDA 2-HOUR PRIOR NOTICE (FOOD / PERISHABLE)',
      detail: hasPn ? `CONFIRMED PN #${manifest.fdaPriorNoticeNumber}` : 'MISSING MANDATORY PRIOR NOTICE NUMBER',
      status: hasPn ? 'ok' : 'fail',
    });
  } else {
    stamps.push({
      title: 'US FDA PRIOR NOTICE',
      detail: 'NOT REQUIRED (NON-FOOD COMMERCIAL COMMODITY)',
      status: 'ok',
    });
  }

  if (manifest.overweightPermitNumber) {
    stamps.push({
      title: 'OVERWEIGHT PERMIT AUTHORIZATION',
      detail: `PERMIT #${manifest.overweightPermitNumber}`,
      status: 'warn',
    });
  }

  const stampW = (CONTENT_WIDTH - (stamps.length - 1) * 8) / stamps.length;
  stamps.forEach((stamp, idx) => {
    const sx = MARGIN + idx * (stampW + 8);
    const bg = stamp.status === 'ok' ? COLOR_GREEN_BG : stamp.status === 'warn' ? COLOR_AMBER_BG : COLOR_CRIMSON_BG;
    const fg = stamp.status === 'ok' ? COLOR_GREEN : stamp.status === 'warn' ? COLOR_AMBER : COLOR_CRIMSON;
    page.drawRectangle({
      x: sx,
      y: y - 30,
      width: stampW,
      height: 32,
      color: bg,
      borderColor: fg,
      borderWidth: 0.75,
    });
    page.drawText(truncateText(stamp.title, fonts.sansBold, 7, stampW - 10), {
      x: sx + 5,
      y: y - 9,
      size: 7,
      font: fonts.sansBold,
      color: fg,
    });
    page.drawText(truncateText(stamp.detail, fonts.monoBold, 7.5, stampW - 10), {
      x: sx + 5,
      y: y - 22,
      size: 7.5,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
  });
  y -= 42;

  // Shipments / Commodities Table
  y = drawSectionHeading(page, fonts, `Commercial Cargo Manifest (${manifest.shipments.length} Line Item${manifest.shipments.length === 1 ? '' : 's'})`, y);

  const ensureSpace = (needed: number) => {
    if (y - needed < 54) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pages.push(page);
      y = drawBrandBanner(page, fonts, `${docTitle} (CONT.)`, `Control #: ${manifest.controlNumber}`);
    }
  };

  // Table header
  page.drawRectangle({ x: MARGIN, y: y - 14, width: CONTENT_WIDTH, height: 16, color: COLOR_OBSIDIAN });
  const cols = [
    { label: 'COMMODITY / SHIPPER -> CONSIGNEE', x: MARGIN + 6 },
    { label: 'HS CODE', x: MARGIN + 230 },
    { label: 'ORIG/CUSMA', x: MARGIN + 292 },
    { label: 'QTY / PKG', x: MARGIN + 356 },
    { label: 'WT (KG)', x: MARGIN + 416 },
    { label: 'VALUE', x: MARGIN + 464 },
  ];
  for (const c of cols) {
    page.drawText(c.label, { x: c.x, y: y - 10, size: 7, font: fonts.sansBold, color: COLOR_WHITE });
  }
  y -= 20;

  let totalWeightKg = 0;
  manifest.shipments.forEach((s, idx) => {
    ensureSpace(32);
    totalWeightKg += s.weightKg;
    if (idx % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - 18, width: CONTENT_WIDTH, height: 26, color: COLOR_ROW_ALT });
    }
    page.drawText(truncateText(s.commodity, fonts.sansBold, 8.5, 218), {
      x: MARGIN + 6,
      y: y - 2,
      size: 8.5,
      font: fonts.sansBold,
      color: COLOR_OBSIDIAN,
    });
    page.drawText(truncateText(`${s.shipperName} -> ${s.consigneeName}`, fonts.sans, 7, 218), {
      x: MARGIN + 6,
      y: y - 13,
      size: 7,
      font: fonts.sans,
      color: COLOR_SLATE_MUTED,
    });
    page.drawText(safePdfText(s.hsCode), { x: MARGIN + 230, y: y - 5, size: 8, font: fonts.mono, color: COLOR_SLATE_DARK });
    page.drawText(`${s.countryOfOrigin} / ${s.cusmaCertOnFile ? 'YES' : 'NO'}`, {
      x: MARGIN + 292,
      y: y - 5,
      size: 8,
      font: fonts.mono,
      color: s.cusmaCertOnFile ? COLOR_GREEN : COLOR_AMBER,
    });
    page.drawText(truncateText(`${s.quantity} ${s.packageType}`, fonts.sans, 8, 56), {
      x: MARGIN + 356,
      y: y - 5,
      size: 8,
      font: fonts.sans,
      color: COLOR_SLATE_DARK,
    });
    page.drawText(s.weightKg.toFixed(1), { x: MARGIN + 416, y: y - 5, size: 8, font: fonts.mono, color: COLOR_SLATE_DARK });
    page.drawText(truncateText(formatCents(s.invoiceValueCents, s.currency), fonts.monoBold, 7.5, 74), {
      x: MARGIN + 464,
      y: y - 5,
      size: 7.5,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
    y -= 26;
  });

  page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: PAGE_WIDTH - MARGIN, y: y + 4 }, thickness: 0.75, color: COLOR_BORDER });
  page.drawText(`AGGREGATE CARGO WEIGHT: ${totalWeightKg.toFixed(1)} kg (Standard 5-Axle Limit: 36,287.0 kg)`, {
    x: MARGIN + 6,
    y: y - 8,
    size: 8,
    font: fonts.monoBold,
    color: COLOR_OBSIDIAN,
  });
  y -= 22;

  // Automated compliance check audit list
  ensureSpace(28 + validationReport.checks.length * 14);
  y = drawSectionHeading(page, fonts, 'Automated Pre-Arrival Compliance Verification Audit', y);

  for (const chk of validationReport.checks) {
    ensureSpace(16);
    const badgeColor = chk.status === 'pass' ? COLOR_GREEN : chk.status === 'warn' ? COLOR_AMBER : COLOR_CRIMSON;
    page.drawText(`[${chk.status.toUpperCase()}]`, {
      x: MARGIN + 6,
      y,
      size: 7.5,
      font: fonts.monoBold,
      color: badgeColor,
    });
    page.drawText(truncateText(`${chk.label}: ${chk.detail}`, fonts.sans, 8, CONTENT_WIDTH - 56), {
      x: MARGIN + 48,
      y,
      size: 8,
      font: fonts.sans,
      color: COLOR_SLATE_DARK,
    });
    y -= 13;
  }

  if (validationReport.warnings.length > 0) {
    y -= 4;
    for (const warning of validationReport.warnings) {
      ensureSpace(14);
      page.drawText(truncateText(`WARNING: ${warning}`, fonts.sansBold, 7.5, CONTENT_WIDTH - 12), {
        x: MARGIN + 6,
        y,
        size: 7.5,
        font: fonts.sansBold,
        color: COLOR_AMBER,
      });
      y -= 12;
    }
  }

  pages.forEach((p, idx) =>
    drawFooter(
      p,
      fonts,
      `#BRO Transport Customs Engine | Control ${manifest.controlNumber} | Trip ${manifest.tripNumber}`,
      idx + 1,
      pages.length,
    ),
  );

  return pdfDoc.save();
}

/**
 * 2. Generates a commercial Freight Invoice PDF with pure integer-cent arithmetic formatting
 *    and a laser-scannable Code-128B invoice reference barcode.
 */
export async function generateInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const {
    invoiceNumber,
    orgName,
    orgAddress,
    loadNumber,
    currency,
    lineItems,
    subtotalCents,
    taxCents,
    taxLabel,
    totalCents,
    dueDateIso,
    issuedDateIso,
    taxCitation,
  } = input;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Invoice ${invoiceNumber}`);
  pdfDoc.setCreator('#BRO Transport TMS');
  pdfDoc.setProducer('#BRO Transport Edge PDF Engine (pdf-lib)');

  const fonts = await embedStandardFonts(pdfDoc);
  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);

  let y = drawBrandBanner(
    page,
    fonts,
    `COMMERCIAL FREIGHT INVOICE  #${invoiceNumber}`,
    `Load Reference: ${loadNumber}`,
    { text: `TOTAL DUE: ${formatCents(totalCents, currency)}`, bg: COLOR_ROW_ALT, fg: COLOR_OBSIDIAN },
  );

  // Bill To + Remit To + Barcode Row
  const leftW = 285;
  const rightW = CONTENT_WIDTH - leftW - 12;

  page.drawRectangle({
    x: MARGIN,
    y: y - 78,
    width: leftW,
    height: 78,
    color: COLOR_ROW_ALT,
    borderColor: COLOR_BORDER,
    borderWidth: 0.75,
  });
  page.drawText('BILL TO', { x: MARGIN + 10, y: y - 14, size: 7.5, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
  page.drawText(truncateText(orgName, fonts.sansBold, 10.5, leftW - 20), {
    x: MARGIN + 10,
    y: y - 29,
    size: 10.5,
    font: fonts.sansBold,
    color: COLOR_OBSIDIAN,
  });
  const addrLines = wrapText(orgAddress, fonts.sans, 8.5, leftW - 20).slice(0, 3);
  addrLines.forEach((line, i) => {
    page.drawText(line, { x: MARGIN + 10, y: y - 43 - i * 11, size: 8.5, font: fonts.sans, color: COLOR_SLATE_DARK });
  });

  drawCode128VectorBox(page, fonts, {
    caption: 'Invoice / Factoring Reference (Code-128B)',
    value: invoiceNumber,
    x: MARGIN + leftW + 12,
    yTop: y,
    boxWidth: rightW,
    boxHeight: 78,
  });
  y -= 92;

  // Invoice Metadata Bar
  const metaItems = [
    { label: 'INVOICE NUMBER', value: invoiceNumber },
    { label: 'LOAD NUMBER', value: loadNumber },
    { label: 'ISSUED DATE', value: issuedDateIso.slice(0, 10) },
    { label: 'PAYMENT DUE', value: dueDateIso.slice(0, 10) },
    { label: 'CURRENCY', value: currency },
  ];
  const metaColW = CONTENT_WIDTH / metaItems.length;
  page.drawRectangle({ x: MARGIN, y: y - 30, width: CONTENT_WIDTH, height: 32, color: COLOR_WHITE, borderColor: COLOR_BORDER, borderWidth: 0.75 });
  metaItems.forEach((m, idx) => {
    const mx = MARGIN + idx * metaColW + 8;
    page.drawText(m.label, { x: mx, y: y - 10, size: 6.8, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
    page.drawText(truncateText(m.value, fonts.monoBold, 8.5, metaColW - 12), {
      x: mx,
      y: y - 22,
      size: 8.5,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
  });
  y -= 44;

  // Line Items Table
  y = drawSectionHeading(page, fonts, 'Itemized Freight & Accessorial Charges', y);

  const drawItemsHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_WIDTH, height: 18, color: COLOR_OBSIDIAN });
    page.drawText('CODE', { x: MARGIN + 8, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
    page.drawText('DESCRIPTION', { x: MARGIN + 78, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
    page.drawText('QTY', { x: MARGIN + 332, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
    page.drawText('UNIT RATE', { x: MARGIN + 372, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
    page.drawText('AMOUNT', { x: MARGIN + 456, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
    y -= 22;
  };
  drawItemsHeader();

  lineItems.forEach((item, idx) => {
    if (y < 140) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pages.push(page);
      y = drawBrandBanner(page, fonts, `INVOICE #${invoiceNumber} (CONT.)`, `Load: ${loadNumber}`);
      drawItemsHeader();
    }
    if (idx % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - 12, width: CONTENT_WIDTH, height: 19, color: COLOR_ROW_ALT });
    }
    page.drawText(truncateText(item.code, fonts.monoBold, 8, 64), {
      x: MARGIN + 8,
      y: y - 5,
      size: 8,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
    page.drawText(truncateText(item.description, fonts.sans, 8.5, 246), {
      x: MARGIN + 78,
      y: y - 5,
      size: 8.5,
      font: fonts.sans,
      color: COLOR_SLATE_DARK,
    });
    page.drawText(String(item.quantity), {
      x: MARGIN + 332,
      y: y - 5,
      size: 8.5,
      font: fonts.mono,
      color: COLOR_SLATE_DARK,
    });
    page.drawText(truncateText(formatCents(item.unitPriceCents, currency), fonts.mono, 8, 78), {
      x: MARGIN + 372,
      y: y - 5,
      size: 8,
      font: fonts.mono,
      color: COLOR_SLATE_DARK,
    });
    page.drawText(truncateText(formatCents(item.amountCents, currency), fonts.monoBold, 8.5, 80), {
      x: MARGIN + 456,
      y: y - 5,
      size: 8.5,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
    y -= 19;
  });

  // Totals Summary Block
  y -= 12;
  const summaryW = 240;
  const summaryX = PAGE_WIDTH - MARGIN - summaryW;

  page.drawRectangle({
    x: summaryX,
    y: y - 76,
    width: summaryW,
    height: 78,
    color: COLOR_ROW_ALT,
    borderColor: COLOR_BORDER,
    borderWidth: 1,
  });

  const drawTotalRow = (label: string, val: string, rowY: number, bold = false) => {
    const fLabel = bold ? fonts.sansBold : fonts.sans;
    const fVal = bold ? fonts.monoBold : fonts.mono;
    const sz = bold ? 10 : 8.5;
    page.drawText(truncateText(label, fLabel, sz, 130), {
      x: summaryX + 10,
      y: rowY,
      size: sz,
      font: fLabel,
      color: bold ? COLOR_OBSIDIAN : COLOR_SLATE_DARK,
    });
    const vw = fVal.widthOfTextAtSize(val, sz);
    page.drawText(val, {
      x: summaryX + summaryW - 10 - vw,
      y: rowY,
      size: sz,
      font: fVal,
      color: COLOR_OBSIDIAN,
    });
  };

  drawTotalRow('Subtotal', formatCents(subtotalCents, currency), y - 16);
  drawTotalRow(taxLabel, formatCents(taxCents, currency), y - 34);
  page.drawLine({
    start: { x: summaryX + 8, y: y - 46 },
    end: { x: summaryX + summaryW - 8, y: y - 46 },
    thickness: 1,
    color: COLOR_OBSIDIAN,
  });
  drawTotalRow('TOTAL DUE', formatCents(totalCents, currency), y - 64, true);

  // Remittance box on the left
  page.drawText('REMIT PAYMENT TO:', { x: MARGIN, y: y - 14, size: 8, font: fonts.sansBold, color: COLOR_OBSIDIAN });
  page.drawText('#BRO Transport Inc. | Charlottetown, PE, Canada', { x: MARGIN, y: y - 27, size: 8, font: fonts.sans, color: COLOR_SLATE_DARK });
  page.drawText(`Reference Invoice #${invoiceNumber} on all EFT / ACH / Wire transfers.`, {
    x: MARGIN,
    y: y - 39,
    size: 7.5,
    font: fonts.sans,
    color: COLOR_SLATE_MUTED,
  });
  if (taxCitation) {
    page.drawText(truncateText(`Tax Authority Basis: ${taxCitation}`, fonts.mono, 7.5, 270), {
      x: MARGIN,
      y: y - 53,
      size: 7.5,
      font: fonts.mono,
      color: COLOR_SLATE_MUTED,
    });
  }

  pages.forEach((p, idx) =>
    drawFooter(p, fonts, `#BRO Transport Accounts Receivable | Invoice ${invoiceNumber} | Load ${loadNumber}`, idx + 1, pages.length),
  );

  return pdfDoc.save();
}

/**
 * 3. Merges Invoice + Rate Confirmation + eBOL/POD + Lumper PDFs into one Factoring Packet PDF
 *    using pure edge `PDFDocument.copyPages()`.
 */
export async function mergeFactoringPacketPdf(pdfBuffers: Uint8Array[]): Promise<Uint8Array> {
  if (!Array.isArray(pdfBuffers) || pdfBuffers.length === 0) {
    throw new Error('mergeFactoringPacketPdf requires at least one PDF buffer.');
  }

  const mergedDoc = await PDFDocument.create();
  mergedDoc.setTitle('#BRO Transport Factoring Packet');
  mergedDoc.setCreator('#BRO Transport TMS');
  mergedDoc.setProducer('#BRO Transport Edge PDF Engine (pdf-lib)');

  for (const buffer of pdfBuffers) {
    const sourceDoc = await PDFDocument.load(buffer);
    const copiedPages = await mergedDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());
    for (const copied of copiedPages) {
      mergedDoc.addPage(copied);
    }
  }

  return mergedDoc.save();
}

/**
 * 4. Generates a Driver Settlement Statement PDF (Company CPM & Owner-Operator % Gross)
 *    with strict integer-cent payroll math.
 */
export async function generateSettlementPdf(input: SettlementPdfInput): Promise<Uint8Array> {
  const {
    settlementNumber,
    driverName,
    periodLabel,
    currency,
    loads,
    deductions,
    grossPayCents,
    reimbursementsCents,
    deductionsCents,
    netPayCents,
  } = input;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Driver Settlement ${settlementNumber}`);
  pdfDoc.setCreator('#BRO Transport TMS');
  pdfDoc.setProducer('#BRO Transport Edge PDF Engine (pdf-lib)');

  const fonts = await embedStandardFonts(pdfDoc);
  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);

  let y = drawBrandBanner(
    page,
    fonts,
    `DRIVER SETTLEMENT STATEMENT  #${settlementNumber}`,
    `Pay Period: ${periodLabel}`,
    { text: `NET PAY: ${formatCents(netPayCents, currency)}`, bg: COLOR_GREEN_BG, fg: COLOR_GREEN },
  );

  // Driver summary box
  page.drawRectangle({ x: MARGIN, y: y - 34, width: CONTENT_WIDTH, height: 36, color: COLOR_ROW_ALT, borderColor: COLOR_BORDER, borderWidth: 0.75 });
  page.drawText('DRIVER / OWNER-OPERATOR', { x: MARGIN + 10, y: y - 11, size: 7, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
  page.drawText(truncateText(driverName, fonts.sansBold, 10, 220), { x: MARGIN + 10, y: y - 25, size: 10, font: fonts.sansBold, color: COLOR_OBSIDIAN });

  page.drawText('SETTLEMENT PERIOD', { x: MARGIN + 240, y: y - 11, size: 7, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
  page.drawText(truncateText(periodLabel, fonts.monoBold, 9, 170), { x: MARGIN + 240, y: y - 25, size: 9, font: fonts.monoBold, color: COLOR_OBSIDIAN });

  page.drawText('CURRENCY', { x: MARGIN + 430, y: y - 11, size: 7, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
  page.drawText(currency, { x: MARGIN + 430, y: y - 25, size: 9.5, font: fonts.monoBold, color: COLOR_OBSIDIAN });
  y -= 48;

  const ensureSpace = (needed: number) => {
    if (y - needed < 60) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pages.push(page);
      y = drawBrandBanner(page, fonts, `DRIVER SETTLEMENT #${settlementNumber} (CONT.)`, driverName);
    }
  };

  // Loads & Earnings Table
  y = drawSectionHeading(page, fonts, `Dispatched Loads & Earnings (${loads.length})`, y);
  page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_WIDTH, height: 18, color: COLOR_OBSIDIAN });
  page.drawText('LOAD #', { x: MARGIN + 8, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
  page.drawText('LANE / CORRIDOR', { x: MARGIN + 102, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
  page.drawText('DELIVERED', { x: MARGIN + 308, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
  page.drawText('MILES', { x: MARGIN + 388, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
  page.drawText('EARNINGS', { x: MARGIN + 448, y: y - 11, size: 7.5, font: fonts.sansBold, color: COLOR_WHITE });
  y -= 22;

  loads.forEach((ld, idx) => {
    ensureSpace(22);
    if (idx % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - 12, width: CONTENT_WIDTH, height: 19, color: COLOR_ROW_ALT });
    }
    const corridor = ld.lane ?? ld.originDest ?? 'Commercial Freight Run';
    page.drawText(truncateText(ld.loadNumber, fonts.monoBold, 8.5, 88), { x: MARGIN + 8, y: y - 5, size: 8.5, font: fonts.monoBold, color: COLOR_OBSIDIAN });
    page.drawText(truncateText(corridor, fonts.sans, 8.5, 198), { x: MARGIN + 102, y: y - 5, size: 8.5, font: fonts.sans, color: COLOR_SLATE_DARK });
    page.drawText(truncateText(ld.deliveredDate ?? '-', fonts.mono, 8, 72), { x: MARGIN + 308, y: y - 5, size: 8, font: fonts.mono, color: COLOR_SLATE_DARK });
    page.drawText(ld.loadedMiles !== undefined ? String(ld.loadedMiles) : '-', {
      x: MARGIN + 388,
      y: y - 5,
      size: 8.5,
      font: fonts.mono,
      color: COLOR_SLATE_DARK,
    });
    page.drawText(truncateText(formatCents(ld.grossPayCents, currency), fonts.monoBold, 8.5, 88), {
      x: MARGIN + 448,
      y: y - 5,
      size: 8.5,
      font: fonts.monoBold,
      color: COLOR_OBSIDIAN,
    });
    y -= 19;
  });

  y -= 12;

  // Deductions & Escrows Table
  ensureSpace(60);
  y = drawSectionHeading(page, fonts, `Deductions, Fuel Advances & Escrows (${deductions.length})`, y);
  if (deductions.length === 0) {
    page.drawText('No deductions applied for this settlement period.', {
      x: MARGIN + 8,
      y: y - 4,
      size: 8.5,
      font: fonts.sans,
      color: COLOR_SLATE_MUTED,
    });
    y -= 20;
  } else {
    deductions.forEach((ded, idx) => {
      ensureSpace(20);
      if (idx % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - 11, width: CONTENT_WIDTH, height: 18, color: COLOR_ROW_ALT });
      }
      page.drawText(truncateText(ded.code ?? 'DED', fonts.monoBold, 8, 70), { x: MARGIN + 8, y: y - 4, size: 8, font: fonts.monoBold, color: COLOR_SLATE_DARK });
      page.drawText(truncateText(ded.label, fonts.sans, 8.5, 340), { x: MARGIN + 86, y: y - 4, size: 8.5, font: fonts.sans, color: COLOR_SLATE_DARK });
      page.drawText(truncateText(`-${formatCents(ded.amountCents, currency)}`, fonts.monoBold, 8.5, 96), {
        x: MARGIN + 440,
        y: y - 4,
        size: 8.5,
        font: fonts.monoBold,
        color: COLOR_CRIMSON,
      });
      y -= 18;
    });
  }

  // Settlement Net Summary Box
  ensureSpace(108);
  y -= 10;
  const boxW = 260;
  const boxX = PAGE_WIDTH - MARGIN - boxW;
  page.drawRectangle({ x: boxX, y: y - 92, width: boxW, height: 94, color: COLOR_ROW_ALT, borderColor: COLOR_BORDER, borderWidth: 1 });

  const drawRow = (label: string, val: string, rowY: number, color = COLOR_OBSIDIAN, bold = false) => {
    const fL = bold ? fonts.sansBold : fonts.sans;
    const fV = bold ? fonts.monoBold : fonts.mono;
    const sz = bold ? 10 : 8.5;
    page.drawText(label, { x: boxX + 10, y: rowY, size: sz, font: fL, color });
    const vw = fV.widthOfTextAtSize(val, sz);
    page.drawText(val, { x: boxX + boxW - 10 - vw, y: rowY, size: sz, font: fV, color });
  };

  drawRow('Gross Load Earnings', formatCents(grossPayCents, currency), y - 16);
  drawRow('Reimbursements', formatCents(reimbursementsCents, currency), y - 34, COLOR_GREEN);
  drawRow('Total Deductions', `-${formatCents(deductionsCents, currency)}`, y - 52, COLOR_CRIMSON);
  page.drawLine({ start: { x: boxX + 8, y: y - 62 }, end: { x: boxX + boxW - 8, y: y - 62 }, thickness: 1, color: COLOR_OBSIDIAN });
  drawRow('NET SETTLEMENT PAY', formatCents(netPayCents, currency), y - 80, COLOR_OBSIDIAN, true);

  pages.forEach((p, idx) =>
    drawFooter(p, fonts, `#BRO Transport Driver Payroll | Settlement ${settlementNumber} | ${driverName}`, idx + 1, pages.length),
  );

  return pdfDoc.save();
}

/**
 * 5. Generates a Cryptographic eBOL Chain-of-Custody Verification Certificate PDF
 *    performing real ECDSA P-256 chain verification and rendering full SHA-256 digests,
 *    GPS custody coordinates, public key thumbprints, and a Code-128B load barcode.
 */
export async function generateEbolCertificatePdf(
  loadNumber: string,
  blocks: EbolBlockRecord[],
  verifyUrl: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Cryptographic eBOL Certificate - ${loadNumber}`);
  pdfDoc.setCreator('#BRO Transport TMS');
  pdfDoc.setProducer('#BRO Transport Edge PDF Engine (pdf-lib)');

  const fonts = await embedStandardFonts(pdfDoc);
  const pages: PDFPage[] = [];
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);

  const loadIdForChain = blocks.length > 0 ? blocks[0].loadId : loadNumber;
  const genesisHash = await computeGenesisHash(loadIdForChain);
  const verification =
    blocks.length > 0
      ? await verifyEbolChain(loadIdForChain, blocks)
      : { valid: false, verifiedCount: 0, reason: 'No signed custody blocks recorded yet.' };

  let y = drawBrandBanner(
    page,
    fonts,
    `CRYPTOGRAPHIC eBOL CHAIN-OF-CUSTODY CERTIFICATE`,
    `Load #${loadNumber}`,
    verification.valid
      ? { text: `ECDSA P-256 VERIFIED (${verification.verifiedCount}/${blocks.length})`, bg: COLOR_GREEN_BG, fg: COLOR_GREEN }
      : { text: `INTEGRITY ALERT (${verification.verifiedCount}/${blocks.length} VERIFIED)`, bg: COLOR_CRIMSON_BG, fg: COLOR_CRIMSON },
  );

  // Top summary + barcode panel
  const leftW = 336;
  const rightW = CONTENT_WIDTH - leftW - 12;

  page.drawRectangle({
    x: MARGIN,
    y: y - 78,
    width: leftW,
    height: 78,
    color: COLOR_ROW_ALT,
    borderColor: COLOR_BORDER,
    borderWidth: 0.75,
  });
  page.drawText('CRYPTOGRAPHIC CHAIN ANCHOR (DOMAIN-SEPARATED GENESIS)', {
    x: MARGIN + 8,
    y: y - 13,
    size: 7,
    font: fonts.sansBold,
    color: COLOR_SLATE_MUTED,
  });
  page.drawText(`Load Ref: ${safePdfText(loadNumber)}   |   Chain ID: ${truncateText(loadIdForChain, fonts.mono, 7.5, 145)}`, {
    x: MARGIN + 8,
    y: y - 26,
    size: 7.5,
    font: fonts.monoBold,
    color: COLOR_OBSIDIAN,
  });
  page.drawText(`Genesis SHA-256:`, { x: MARGIN + 8, y: y - 39, size: 7, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
  page.drawText(genesisHash, { x: MARGIN + 8, y: y - 50, size: 6.5, font: fonts.mono, color: COLOR_SLATE_DARK });
  page.drawText(
    truncateText(
      verification.valid
        ? 'Algorithm: Web Crypto ECDSA P-256 / SHA-256 | Zero Tampering Detected'
        : `Verification Failure: ${verification.reason ?? 'Invalid chain'}`,
      fonts.sansBold,
      7.5,
      leftW - 16,
    ),
    {
      x: MARGIN + 8,
      y: y - 66,
      size: 7.5,
      font: fonts.sansBold,
      color: verification.valid ? COLOR_GREEN : COLOR_CRIMSON,
    },
  );

  drawCode128VectorBox(page, fonts, {
    caption: 'eBOL Load Control Barcode (Code-128B)',
    value: loadNumber,
    x: MARGIN + leftW + 12,
    yTop: y,
    boxWidth: rightW,
    boxHeight: 78,
  });
  y -= 92;

  y = drawSectionHeading(page, fonts, `Append-Only Custody Ledger (${blocks.length} Signed Block${blocks.length === 1 ? '' : 's'})`, y);

  if (blocks.length === 0) {
    page.drawText('No custody signatures have been appended to this electronic Bill of Lading.', {
      x: MARGIN + 8,
      y: y - 6,
      size: 9,
      font: fonts.sans,
      color: COLOR_SLATE_MUTED,
    });
    y -= 24;
  }

  for (const block of blocks) {
    const blockCardH = 98;
    if (y - blockCardH < 80) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pages.push(page);
      y = drawBrandBanner(page, fonts, `eBOL CERTIFICATE #${loadNumber} (CONT.)`, `Blocks: ${blocks.length}`);
    }

    const isBroken = verification.brokenBlockSeq === block.seq;
    const cardBottom = y - blockCardH;

    page.drawRectangle({
      x: MARGIN,
      y: cardBottom,
      width: CONTENT_WIDTH,
      height: blockCardH,
      color: isBroken ? COLOR_CRIMSON_BG : COLOR_WHITE,
      borderColor: isBroken ? COLOR_CRIMSON : COLOR_BORDER,
      borderWidth: isBroken ? 1.25 : 0.75,
    });

    // Top bar of card
    page.drawRectangle({
      x: MARGIN,
      y: y - 18,
      width: CONTENT_WIDTH,
      height: 18,
      color: isBroken ? COLOR_CRIMSON : COLOR_OBSIDIAN,
    });

    const signedIso = new Date(block.signedAt).toISOString();
    page.drawText(
      `BLOCK #${block.seq}  |  ${safePdfText(block.stage)}  |  ${safePdfText(block.actorRole.toUpperCase())}: ${truncateText(block.actorName, fonts.sansBold, 8, 190)}`,
      {
        x: MARGIN + 8,
        y: y - 12.5,
        size: 8,
        font: fonts.sansBold,
        color: COLOR_WHITE,
      },
    );
    const tsW = fonts.mono.widthOfTextAtSize(signedIso, 7.5);
    page.drawText(signedIso, {
      x: PAGE_WIDTH - MARGIN - 8 - tsW,
      y: y - 12.5,
      size: 7.5,
      font: fonts.mono,
      color: COLOR_WHITE,
    });

    const thumbprint = await computeJwkThumbprint(block.signerPublicKeyJwk as JsonWebKey);

    const rows: Array<[string, string]> = [
      ['GPS Coordinates', `${block.gpsLat.toFixed(5)}, ${block.gpsLon.toFixed(5)}   |   Key Thumbprint: ${thumbprint.slice(0, 32)}...`],
      ['Prev Block Hash', block.prevHash],
      ['Payload SHA-256', block.payloadSha256],
      ['Block SHA-256', block.blockHash],
      ['ECDSA P-256 Sig', `${block.ecdsaSignatureB64.slice(0, 72)}${block.ecdsaSignatureB64.length > 72 ? '...' : ''}`],
    ];

    rows.forEach(([lbl, val], rIdx) => {
      const ry = y - 32 - rIdx * 14;
      page.drawText(`${lbl}:`, { x: MARGIN + 8, y: ry, size: 7.2, font: fonts.sansBold, color: COLOR_SLATE_MUTED });
      page.drawText(truncateText(val, fonts.mono, 7.2, CONTENT_WIDTH - 96), {
        x: MARGIN + 86,
        y: ry,
        size: 7.2,
        font: fonts.mono,
        color: COLOR_OBSIDIAN,
      });
    });

    y -= blockCardH + 10;
  }

  // Independent Public Verification URL Banner
  if (y < 92) {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = drawBrandBanner(page, fonts, `eBOL CERTIFICATE #${loadNumber} — VERIFICATION`, verifyUrl);
  }

  const urlLines = wrapText(verifyUrl, fonts.monoBold, 8, CONTENT_WIDTH - 20);
  const urlBoxH = 26 + urlLines.length * 12;
  page.drawRectangle({
    x: MARGIN,
    y: y - urlBoxH,
    width: CONTENT_WIDTH,
    height: urlBoxH,
    color: COLOR_ROW_ALT,
    borderColor: COLOR_CYAN,
    borderWidth: 1,
  });
  page.drawText('INDEPENDENT PUBLIC CRYPTOGRAPHIC VERIFICATION ENDPOINT', {
    x: MARGIN + 10,
    y: y - 13,
    size: 7.5,
    font: fonts.sansBold,
    color: COLOR_OBSIDIAN,
  });
  urlLines.forEach((line, idx) => {
    page.drawText(line, {
      x: MARGIN + 10,
      y: y - 26 - idx * 12,
      size: 8,
      font: fonts.monoBold,
      color: COLOR_SLATE_DARK,
    });
  });

  pages.forEach((p, idx) =>
    drawFooter(p, fonts, `#BRO Transport Cryptographic eBOL Ledger | Load ${loadNumber} | ECDSA P-256 / SHA-256`, idx + 1, pages.length),
  );

  return pdfDoc.save();
}
