import { z } from 'zod';

export const EdiTransactionSetSchema = z.enum(['204', '990', '214', '210', '997']);
export type EdiTransactionSet = z.infer<typeof EdiTransactionSetSchema>;

export interface ParsedEdi204 {
  controlNumber: string;
  shipmentId: string;
  scac: string;
  paymentMethod: string;
  weightLbs: number;
  rateCents: number;
  stops: Array<{
    seq: number;
    reasonCode: string; // CL = Pickup, UL = Delivery
    facilityName: string;
    city: string;
    stateProv: string;
  }>;
}

function padControl(num: number | string, len = 9): string {
  return String(num).replace(/\D/g, '').padStart(len, '0').slice(-len);
}

function ediDate(ms: number): { yymmdd: string; yyyymmdd: string; hhmm: string } {
  const d = new Date(ms);
  const yyyy = String(d.getUTCFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return { yymmdd: `${yy}${mm}${dd}`, yyyymmdd: `${yyyy}${mm}${dd}`, hhmm: `${hh}${mi}` };
}

function wrapEnvelope(
  transactionSet: EdiTransactionSet,
  functionalId: string,
  senderId: string,
  receiverId: string,
  controlNum: string,
  bodySegments: string[],
  nowMs = Date.now(),
): string {
  const { yymmdd, yyyymmdd, hhmm } = ediDate(nowMs);
  const ctrl = padControl(controlNum, 9);
  const stCtrl = ctrl.slice(-4);
  const inner = [`ST*${transactionSet}*${stCtrl}`, ...bodySegments];
  inner.push(`SE*${inner.length + 1}*${stCtrl}`);
  const all = [
    `ISA*00*          *00*          *02*${senderId.padEnd(15, ' ').slice(0, 15)}*02*${receiverId.padEnd(15, ' ').slice(0, 15)}*${yymmdd}*${hhmm}*U*00401*${ctrl}*0*P*:`,
    `GS*${functionalId}*${senderId}*${receiverId}*${yyyymmdd}*${hhmm}*${Number(stCtrl)}*X*004010`,
    ...inner,
    `GE*1*${Number(stCtrl)}`,
    `IEA*1*${ctrl}`,
  ];
  return all.join('~\n') + '~';
}

/** Parse inbound ANSI X12 204 Motor Carrier Load Tender deterministically. */
export function parseEdi204(rawX12: string): ParsedEdi204 {
  const segments = rawX12
    .split('~')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('*'));

  const st = segments.find((s) => s[0] === 'ST');
  if (!st || st[1] !== '204') {
    throw new Error('Invalid X12 payload: missing ST*204 transaction header.');
  }

  const b2 = segments.find((s) => s[0] === 'B2');
  const l3 = segments.find((s) => s[0] === 'L3');
  const scac = b2?.[2] || 'BROP';
  const shipmentId = b2?.[4] || `EDI-${st[2] || '0001'}`;
  const paymentMethod = b2?.[6] || 'PP';
  const weightLbs = Math.max(1, Math.round(Number(l3?.[1] || 20000)));
  // L3*5 carries freight charge in cents or decimal dollars (normalize decimal dollars to integer cents)
  const rawCharge = l3?.[5] || '2400.00';
  const rateCents = rawCharge.includes('.')
    ? Math.round(Number(rawCharge) * 100)
    : Math.round(Number(rawCharge));

  const stops: ParsedEdi204['stops'] = [];
  let currentStop: ParsedEdi204['stops'][number] | null = null;

  for (const seg of segments) {
    if (seg[0] === 'S5') {
      if (currentStop) stops.push(currentStop);
      currentStop = {
        seq: Number(seg[1] || stops.length + 1),
        reasonCode: seg[2] || 'CL',
        facilityName: 'Facility',
        city: 'Unknown',
        stateProv: 'PE',
      };
    } else if (seg[0] === 'N1' && currentStop) {
      currentStop.facilityName = seg[2] || currentStop.facilityName;
    } else if (seg[0] === 'N4' && currentStop) {
      currentStop.city = seg[1] || currentStop.city;
      currentStop.stateProv = seg[2] || currentStop.stateProv;
    }
  }
  if (currentStop) stops.push(currentStop);

  return {
    controlNumber: st[2] || '0001',
    shipmentId,
    scac,
    paymentMethod,
    weightLbs,
    rateCents,
    stops,
  };
}

/** Generate X12 990 Response to a Load Tender (A = Accept, D = Decline). */
export function generateEdi990(params: {
  scac: string;
  shipmentId: string;
  action: 'A' | 'D';
  receiverId: string;
  controlNumber: string;
  nowMs?: number;
}): string {
  const { yyyymmdd } = ediDate(params.nowMs ?? Date.now());
  return wrapEnvelope(
    '990',
    'GF',
    params.scac,
    params.receiverId,
    params.controlNumber,
    [`B1*${params.scac}*${params.shipmentId}*${yyyymmdd}*${params.action}`],
    params.nowMs,
  );
}

/** Generate X12 214 Transportation Carrier Shipment Status Message. */
export function generateEdi214(params: {
  scac: string;
  shipmentId: string;
  statusCode: 'X3' | 'AF' | 'X1' | 'D1' | 'AG'; // Arrived Pickup, Departed, Arrived Delivery, Completed, Estimated
  city: string;
  stateProv: string;
  receiverId: string;
  controlNumber: string;
  nowMs?: number;
}): string {
  const { yyyymmdd, hhmm } = ediDate(params.nowMs ?? Date.now());
  return wrapEnvelope(
    '214',
    'QM',
    params.scac,
    params.receiverId,
    params.controlNumber,
    [
      `B10*${params.shipmentId}*${params.shipmentId}*${params.scac}`,
      `LX*1`,
      `AT7*${params.statusCode}*NS***${yyyymmdd}*${hhmm}*ET`,
      `MS1*${params.city}*${params.stateProv}*US`,
    ],
    params.nowMs,
  );
}

/** Generate X12 210 Motor Carrier Freight Details and Invoice. */
export function generateEdi210(params: {
  scac: string;
  invoiceNumber: string;
  shipmentId: string;
  totalCents: number;
  currency: 'CAD' | 'USD';
  receiverId: string;
  controlNumber: string;
  nowMs?: number;
}): string {
  const { yyyymmdd } = ediDate(params.nowMs ?? Date.now());
  return wrapEnvelope(
    '210',
    'IM',
    params.scac,
    params.receiverId,
    params.controlNumber,
    [
      `B3**${params.invoiceNumber}*${params.shipmentId}*PP*L*${yyyymmdd}*${params.totalCents}****${params.scac}*${yyyymmdd}`,
      `C3*${params.currency}`,
      `L3*****${params.totalCents}`,
    ],
    params.nowMs,
  );
}

/** Generate X12 997 Functional Acknowledgment. */
export function generateEdi997(params: {
  scac: string;
  receiverId: string;
  ackedSet: EdiTransactionSet;
  ackedControlNumber: string;
  accepted: boolean;
  controlNumber: string;
  nowMs?: number;
}): string {
  const code = params.accepted ? 'A' : 'R';
  return wrapEnvelope(
    '997',
    'FA',
    params.scac,
    params.receiverId,
    params.controlNumber,
    [
      `AK1*SM*${Number(params.ackedControlNumber.replace(/\D/g, '') || 1)}`,
      `AK2*${params.ackedSet}*${padControl(params.ackedControlNumber, 4)}`,
      `AK5*${code}`,
      `AK9*${code}*1*1*${params.accepted ? 1 : 0}`,
    ],
    params.nowMs,
  );
}
