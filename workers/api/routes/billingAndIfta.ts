import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import {
  createDb,
  invoices,
  loads,
  organizations,
  drivers,
  driverSettlements,
  iftaLogs,
  auditLogs,
} from '@bro/db';
import {
  CreateInvoiceSchema,
  IftaLogInputSchema,
  calculateDriverSettlement,
  calculateIftaQuarter,
  calculateInvoiceTotals,
  isOpsRole,
  type InvoiceLineItem,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import {
  generateInvoicePdf,
  generateSettlementPdf,
  mergeFactoringPacketPdf,
} from '../../services/pdfGenerator.js';

export const billingAndIftaRoutes = new Hono<ApiEnv>();

/** Ops: List invoices with computed AR Aging buckets + Load P&L margins. */
billingAndIftaRoutes.get('/ops/billing/invoices', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing Clerk or Super Admin role required.' }, 403);
  }
  const db = createDb(c.env.DB);
  const [invRows, loadRows, orgRows] = await Promise.all([
    db.select().from(invoices).orderBy(desc(invoices.createdAt)).limit(100),
    db.select().from(loads).orderBy(desc(loads.updatedAt)).limit(100),
    db.select().from(organizations).limit(50),
  ]);

  const now = Date.now();
  const aging = { currentCents: 0, days1To30Cents: 0, days31To60Cents: 0, days61To90Cents: 0, over90Cents: 0 };
  for (const inv of invRows) {
    if (inv.status === 'paid') continue;
    const overdueDays = Math.floor((now - inv.dueDate) / 86_400_000);
    if (overdueDays <= 0) aging.currentCents += inv.totalCents;
    else if (overdueDays <= 30) aging.days1To30Cents += inv.totalCents;
    else if (overdueDays <= 60) aging.days31To60Cents += inv.totalCents;
    else if (overdueDays <= 90) aging.days61To90Cents += inv.totalCents;
    else aging.over90Cents += inv.totalCents;
  }

  return c.json({ invoices: invRows, aging, loads: loadRows, organizations: orgRows });
});

billingAndIftaRoutes.post('/ops/billing/invoices', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing Clerk or Super Admin role required.' }, 403);
  }
  const parsed = CreateInvoiceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid invoice payload.' }, 400);

  const totals = calculateInvoiceTotals({
    lineItems: parsed.data.lineItems,
    direction: parsed.data.direction,
    destinationProvince: parsed.data.destinationProvince,
  });

  const now = Date.now();
  const id = `inv_${crypto.randomUUID()}`;
  const invoiceNumber = `INV-${new Date(now).getUTCFullYear()}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;

  const db = createDb(c.env.DB);
  await db.insert(invoices).values({
    id,
    invoiceNumber,
    loadId: parsed.data.loadId,
    shipperOrgId: parsed.data.shipperOrgId,
    currency: parsed.data.currency,
    lineItemsJson: JSON.stringify(parsed.data.lineItems),
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    taxLabel: totals.taxLabel,
    totalCents: totals.totalCents,
    status: 'pending_approval',
    dueDate: now + parsed.data.dueDays * 86_400_000,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ success: true, id, invoiceNumber, totals }, 201);
});

billingAndIftaRoutes.post('/ops/billing/invoices/:id/approve', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing Clerk or Super Admin role required.' }, 403);
  }
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  const inv = rows[0];
  if (!inv) return c.json({ error: 'Invoice not found.' }, 404);

  if (inv.workflowInstanceId && c.env.BILLING_WORKFLOW) {
    try {
      const wf = await c.env.BILLING_WORKFLOW.get(inv.workflowInstanceId);
      await wf.sendEvent({
        type: 'billing_approval',
        payload: { approved: true, approverUserId: user.id },
      });
    } catch {
      // fallback below
    }
  }

  const now = Date.now();
  const loadRows = await db.select().from(loads).where(eq(loads.id, inv.loadId)).limit(1);
  const orgRows = await db.select().from(organizations).where(eq(organizations.id, inv.shipperOrgId)).limit(1);
  const lineItems = JSON.parse(inv.lineItemsJson) as InvoiceLineItem[];

  const pdfBytes = await generateInvoicePdf({
    invoiceNumber: inv.invoiceNumber,
    orgName: orgRows[0]?.name || 'Commercial Shipper',
    orgAddress: orgRows[0]?.address || 'Atlantic Canada / North America',
    loadNumber: loadRows[0]?.loadNumber || inv.loadId,
    currency: inv.currency,
    lineItems,
    subtotalCents: inv.subtotalCents,
    taxCents: inv.taxCents,
    taxLabel: inv.taxLabel,
    totalCents: inv.totalCents,
    dueDateIso: new Date(inv.dueDate).toISOString().slice(0, 10),
    issuedDateIso: new Date(now).toISOString().slice(0, 10),
  });
  const packetBytes = await mergeFactoringPacketPdf([pdfBytes]);

  const invKey = `invoices/${crypto.randomUUID()}.pdf`;
  const pktKey = `factoring-packets/${crypto.randomUUID()}.pdf`;
  if (c.env.VAULT) {
    await c.env.VAULT.put(invKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } });
    await c.env.VAULT.put(pktKey, packetBytes, { httpMetadata: { contentType: 'application/pdf' } });
  }

  await db
    .update(invoices)
    .set({
      status: 'sent',
      invoicePdfR2Key: invKey,
      factoringPacketR2Key: pktKey,
      updatedAt: now,
    })
    .where(eq(invoices.id, id));
  await db.update(loads).set({ status: 'INVOICED', updatedAt: now }).where(eq(loads.id, inv.loadId));

  return c.json({ success: true, id, status: 'sent', invoicePdfUrl: `/api/billing/invoices/${id}/pdf` });
});

billingAndIftaRoutes.post('/ops/billing/invoices/:id/mark-paid', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing Clerk or Super Admin role required.' }, 403);
  }
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { paymentRef?: string };
  const db = createDb(c.env.DB);
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'Invoice not found.' }, 404);

  const now = Date.now();
  await db
    .update(invoices)
    .set({ status: 'paid', paidAt: now, paymentRef: body.paymentRef || 'EFT/ACH-CLEARED', updatedAt: now })
    .where(eq(invoices.id, id));
  await db.update(loads).set({ status: 'PAID', updatedAt: now }).where(eq(loads.id, rows[0].loadId));

  return c.json({ success: true, id, status: 'paid' });
});

billingAndIftaRoutes.get('/billing/invoices/:id/pdf', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required.' }, 401);
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  const inv = rows[0];
  if (!inv) return c.json({ error: 'Invoice not found.' }, 404);
  if (!isOpsRole(user.role) && user.organizationId !== inv.shipperOrgId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (inv.invoicePdfR2Key && c.env.VAULT) {
    const obj = await c.env.VAULT.get(inv.invoicePdfR2Key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${inv.invoiceNumber}.pdf"`,
        },
      });
    }
  }

  const orgRows = await db.select().from(organizations).where(eq(organizations.id, inv.shipperOrgId)).limit(1);
  const loadRows = await db.select().from(loads).where(eq(loads.id, inv.loadId)).limit(1);
  const pdf = await generateInvoicePdf({
    invoiceNumber: inv.invoiceNumber,
    orgName: orgRows[0]?.name || 'Commercial Shipper',
    orgAddress: orgRows[0]?.address || 'North America',
    loadNumber: loadRows[0]?.loadNumber || inv.loadId,
    currency: inv.currency,
    lineItems: JSON.parse(inv.lineItemsJson) as InvoiceLineItem[],
    subtotalCents: inv.subtotalCents,
    taxCents: inv.taxCents,
    taxLabel: inv.taxLabel,
    totalCents: inv.totalCents,
    dueDateIso: new Date(inv.dueDate).toISOString().slice(0, 10),
    issuedDateIso: new Date(inv.createdAt).toISOString().slice(0, 10),
  });
  return new Response(pdf as BodyInit, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${inv.invoiceNumber}.pdf"` },
  });
});

billingAndIftaRoutes.get('/ops/billing/invoices/:id/factoring-packet.pdf', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  const inv = rows[0];
  if (!inv) return c.json({ error: 'Invoice not found.' }, 404);

  if (inv.factoringPacketR2Key && c.env.VAULT) {
    const obj = await c.env.VAULT.get(inv.factoringPacketR2Key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${inv.invoiceNumber}_Factoring_Packet.pdf"`,
        },
      });
    }
  }
  return c.json({ error: 'Approve invoice first to assemble Factoring Packet PDF.' }, 404);
});

/** Driver Settlements (Payroll). */
billingAndIftaRoutes.get('/ops/settlements', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing role required.' }, 403);
  }
  const db = createDb(c.env.DB);
  const [rows, drvList] = await Promise.all([
    db.select().from(driverSettlements).orderBy(desc(driverSettlements.createdAt)).limit(50),
    db.select().from(drivers).limit(50),
  ]);
  return c.json({ settlements: rows, drivers: drvList });
});

billingAndIftaRoutes.post('/ops/settlements/generate', async (c) => {
  const user = c.get('user');
  if (!user || (user.role !== 'billing_clerk' && user.role !== 'super_admin')) {
    return c.json({ error: 'Billing role required.' }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    driverId: string;
    periodStart?: number;
    periodEnd?: number;
    fuelDeductionCents?: number;
    insuranceDeductionCents?: number;
  };
  if (!body.driverId) return c.json({ error: 'driverId required.' }, 400);

  const db = createDb(c.env.DB);
  const drvRows = await db.select().from(drivers).where(eq(drivers.id, body.driverId)).limit(1);
  const drv = drvRows[0];
  if (!drv) return c.json({ error: 'Driver not found.' }, 404);

  const drvLoads = await db.select().from(loads).where(eq(loads.assignedDriverId, drv.id));
  const totalMiles = drvLoads.reduce((s, l) => s + l.loadedMiles, 0);
  const totalLoadGross = drvLoads.reduce((s, l) => s + l.rateCustomerCents, 0);
  const deductions = [
    ...(body.fuelDeductionCents ? [{ code: 'FUEL_CARD', label: 'Fleet Fuel Card Deductions', amountCents: body.fuelDeductionCents }] : []),
    ...(body.insuranceDeductionCents ? [{ code: 'INS_ESCROW', label: 'Occupational Insurance / Escrow', amountCents: body.insuranceDeductionCents }] : []),
  ];
  const deductionsTotal = deductions.reduce((s, d) => s + d.amountCents, 0);

  const calc = calculateDriverSettlement({
    payModel: drv.payModel,
    rateValue: drv.payRateValue,
    loadedMiles: totalMiles,
    loadGrossCents: totalLoadGross,
    deductionsCents: deductionsTotal,
  });

  const now = Date.now();
  const id = `stl_${crypto.randomUUID()}`;
  const settlementNumber = `STL-${new Date(now).getUTCFullYear()}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
  const periodStart = body.periodStart ?? now - 14 * 86_400_000;
  const periodEnd = body.periodEnd ?? now;

  const pdfBytes = await generateSettlementPdf({
    settlementNumber,
    driverName: drv.fullName,
    periodLabel: `${new Date(periodStart).toISOString().slice(0, 10)} to ${new Date(periodEnd).toISOString().slice(0, 10)}`,
    currency: 'CAD',
    loads: drvLoads.map((l) => ({
      loadNumber: l.loadNumber,
      loadedMiles: l.loadedMiles,
      payModel: drv.payModel,
      grossPayCents:
        drv.payModel === 'cpm'
          ? Math.round(l.loadedMiles * drv.payRateValue)
          : Math.round((l.rateCustomerCents * drv.payRateValue) / 10000),
    })),
    deductions,
    grossPayCents: calc.grossPayCents,
    reimbursementsCents: calc.reimbursementsCents,
    deductionsCents: calc.deductionsCents,
    netPayCents: calc.netPayCents,
  });

  const pdfKey = `settlements/${crypto.randomUUID()}.pdf`;
  if (c.env.VAULT) {
    await c.env.VAULT.put(pdfKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } });
  }

  await db.insert(driverSettlements).values({
    id,
    settlementNumber,
    driverId: drv.id,
    periodStart,
    periodEnd,
    loadsJson: JSON.stringify(drvLoads.map((l) => ({ loadNumber: l.loadNumber, loadedMiles: l.loadedMiles }))),
    deductionsJson: JSON.stringify(deductions),
    grossPayCents: calc.grossPayCents,
    reimbursementsCents: calc.reimbursementsCents,
    deductionsCents: calc.deductionsCents,
    netPayCents: calc.netPayCents,
    currency: 'CAD',
    status: 'finalized',
    pdfR2Key: pdfKey,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'DRIVER_SETTLEMENT_GENERATED',
    entityType: 'settlement',
    entityId: id,
    detailJson: JSON.stringify({ settlementNumber, netPayCents: calc.netPayCents }),
    createdAt: now,
  });

  return c.json({ success: true, id, settlementNumber, calculation: calc, pdfUrl: `/api/settlements/${id}/pdf` }, 201);
});

billingAndIftaRoutes.get('/settlements/:id/pdf', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Auth required.' }, 401);
  const id = c.req.param('id');
  const db = createDb(c.env.DB);
  const rows = await db.select().from(driverSettlements).where(eq(driverSettlements.id, id)).limit(1);
  const stl = rows[0];
  if (!stl) return c.json({ error: 'Settlement not found.' }, 404);
  if (stl.pdfR2Key && c.env.VAULT) {
    const obj = await c.env.VAULT.get(stl.pdfR2Key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${stl.settlementNumber}.pdf"`,
        },
      });
    }
  }
  return c.json({ error: 'Settlement PDF not yet rendered.' }, 404);
});

/** Quarterly IFTA Fuel Tax Engine & Filing CSV Export. */
billingAndIftaRoutes.post('/ops/ifta/logs', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const parsed = IftaLogInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid IFTA log.' }, 400);

  const db = createDb(c.env.DB);
  const id = `ifta_${crypto.randomUUID()}`;
  await db.insert(iftaLogs).values({
    id,
    loadId: parsed.data.loadId ?? null,
    tractorId: parsed.data.tractorId,
    quarter: parsed.data.quarter,
    jurisdictionCode: parsed.data.jurisdictionCode,
    distanceKm: parsed.data.distanceKm,
    fuelLiters: parsed.data.fuelLiters,
    fuelCostCents: parsed.data.fuelCostCents,
    receiptDocId: parsed.data.receiptDocId ?? null,
    createdAt: Date.now(),
  });
  return c.json({ success: true, id }, 201);
});

billingAndIftaRoutes.get('/ops/ifta/report', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const quarter = c.req.query('quarter') || '2026-Q4';
  const db = createDb(c.env.DB);
  const logs = await db.select().from(iftaLogs).where(eq(iftaLogs.quarter, quarter));
  const report = calculateIftaQuarter(quarter, logs);
  return c.json({ report, rawLogsCount: logs.length });
});

billingAndIftaRoutes.get('/ops/ifta/report.csv', async (c) => {
  const user = c.get('user');
  if (!user || !isOpsRole(user.role)) return c.json({ error: 'Ops RBAC required.' }, 403);
  const quarter = c.req.query('quarter') || '2026-Q4';
  const db = createDb(c.env.DB);
  const logs = await db.select().from(iftaLogs).where(eq(iftaLogs.quarter, quarter));
  const report = calculateIftaQuarter(quarter, logs);

  const lines = [
    'Quarter,Jurisdiction,Miles,TaxableGallons,TaxPaidGallons,NetTaxableGallons,TaxRateUSDPerGal,NetTaxDueUSD',
    ...report.jurisdictions.map(
      (j) =>
        `${report.quarter},${j.jurisdictionCode},${j.miles},${j.taxableGallons},${j.taxPaidGallons},${j.netTaxableGallons},${(j.taxRateCentsPerGal / 100).toFixed(2)},${(j.netTaxDueCents / 100).toFixed(2)}`,
    ),
  ];

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="BRO_IFTA_${quarter}.csv"`,
    },
  });
});
