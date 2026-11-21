import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import {
  createDb,
  workOrders,
  equipment,
  dvirInspections,
  telematicsEvents,
  auditLogs,
} from '@bro/db';
import {
  WorkOrderCreateSchema,
  WorkOrderUpdateSchema,
  canAccessRoute,
  hasPermission,
} from '@bro/contracts';
import type { ApiEnv } from './authRoutes.js';
import { emitHubEvent } from '../../agents/hubEvents.js';

export const opsFleetMaintenanceRoutes = new Hono<ApiEnv>();

opsFleetMaintenanceRoutes.get('/ops/maintenance', async (c) => {
  const user = c.get('user');
  if (!user || !canAccessRoute(user.role, '/ops/maintenance')) {
    return c.json({ error: 'Maintenance Manager, Safety Officer, Dispatcher, or Super Admin required.' }, 403);
  }

  const db = createDb(c.env.DB);
  const [orders, equipRows, dvirRows, telRows] = await Promise.all([
    db.select().from(workOrders).orderBy(desc(workOrders.createdAt)).limit(100),
    db.select().from(equipment).orderBy(desc(equipment.updatedAt)).limit(50),
    db.select().from(dvirInspections).orderBy(desc(dvirInspections.signedAt)).limit(50),
    db.select().from(telematicsEvents).orderBy(desc(telematicsEvents.recordedAt)).limit(40),
  ]);

  return c.json({
    workOrders: orders,
    equipment: equipRows,
    dvirInspections: dvirRows,
    telematics: telRows,
  });
});

opsFleetMaintenanceRoutes.post('/ops/maintenance/work-orders', async (c) => {
  const user = c.get('user');
  if (!user || !hasPermission(user.role, 'maintenance:workorder')) {
    return c.json({ error: 'Shop work-order permission required.' }, 403);
  }

  const parsed = WorkOrderCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid work order payload.' }, 400);
  }

  const data = parsed.data;
  const db = createDb(c.env.DB);
  const now = Date.now();
  const id = `wo_${crypto.randomUUID()}`;

  await db.insert(workOrders).values({
    id,
    equipmentId: data.equipmentId,
    dvirId: data.dvirId ?? null,
    unitNumber: data.unitNumber,
    priority: data.priority,
    status: 'open',
    title: data.title,
    description: data.description,
    estimatedCostCents: data.estimatedCostCents,
    vendorName: data.vendorName ?? null,
    assignedMechanic: data.assignedMechanic ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (data.priority === 'critical') {
    await db
      .update(equipment)
      .set({ status: 'maintenance', updatedAt: now })
      .where(eq(equipment.id, data.equipmentId));
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: 'WORK_ORDER_CREATED',
    entityType: 'work_order',
    entityId: id,
    detailJson: JSON.stringify({
      unitNumber: data.unitNumber,
      priority: data.priority,
      estimatedCostCents: data.estimatedCostCents,
    }),
    createdAt: now,
  });

  return c.json({ success: true, id }, 201);
});

opsFleetMaintenanceRoutes.patch('/ops/maintenance/work-orders/:id', async (c) => {
  const user = c.get('user');
  if (!user || !hasPermission(user.role, 'maintenance:workorder')) {
    return c.json({ error: 'Shop work-order permission required.' }, 403);
  }

  const id = c.req.param('id');
  const parsed = WorkOrderUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid update payload.' }, 400);
  }

  const data = parsed.data;
  const db = createDb(c.env.DB);
  const existingRows = await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
  const wo = existingRows[0];
  if (!wo) {
    return c.json({ error: 'Work order not found.' }, 404);
  }

  const now = Date.now();
  const isCompleting = data.status === 'completed';

  await db
    .update(workOrders)
    .set({
      ...(data.status ? { status: data.status } : {}),
      ...(data.priority ? { priority: data.priority } : {}),
      ...(typeof data.actualCostCents === 'number' ? { actualCostCents: data.actualCostCents } : {}),
      ...(data.vendorName !== undefined ? { vendorName: data.vendorName } : {}),
      ...(data.assignedMechanic !== undefined ? { assignedMechanic: data.assignedMechanic } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(isCompleting ? { clearedByUserId: user.id } : {}),
      updatedAt: now,
    })
    .where(eq(workOrders.id, id));

  if (isCompleting || data.clearOosLock) {
    await db
      .update(equipment)
      .set({ status: 'active', updatedAt: now })
      .where(eq(equipment.id, wo.equipmentId));

    if (wo.dvirId) {
      await db
        .update(dvirInspections)
        .set({
          mechanicClearedBy: user.id,
          mechanicClearedAt: now,
        })
        .where(eq(dvirInspections.id, wo.dvirId));
    }
  }

  await db.insert(auditLogs).values({
    id: `aud_${crypto.randomUUID()}`,
    actorUserId: user.id,
    actorType: 'user',
    action: isCompleting ? 'WORK_ORDER_COMPLETED_AND_CLEARED' : 'WORK_ORDER_UPDATED',
    entityType: 'work_order',
    entityId: id,
    detailJson: JSON.stringify({
      unitNumber: wo.unitNumber,
      status: data.status ?? wo.status,
      actualCostCents: data.actualCostCents ?? wo.actualCostCents,
      clearOosLock: Boolean(isCompleting || data.clearOosLock),
    }),
    createdAt: now,
  });

  await emitHubEvent(c.env, {
    type: 'TELEMATICS_ALERT',
    channel: 'ops:all',
    payload: {
      workOrderId: id,
      unitNumber: wo.unitNumber,
      status: data.status ?? wo.status,
    },
  });

  return c.json({
    success: true,
    id,
    status: data.status ?? wo.status,
    equipmentCleared: Boolean(isCompleting || data.clearOosLock),
  });
});
