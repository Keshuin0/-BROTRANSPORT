import { describe, it, expect } from 'vitest';
import {
  UserRoleSchema,
  PermissionSchema,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  OPS_ROLES,
  hasPermission,
  isOpsRole,
  canAccessRoute,
  defaultHomeForRole,
  getAuthorizedOpsTabs,
  RoleAccessError,
  AgentIdSchema,
  AGENT_DIRECTORY,
  getAgentsForRole,
  canAccessAgent,
  StaffInviteCreateSchema,
  AdminCreateUserSchema,
  ActivateInviteSchema,
  ResetPasswordRequestSchema,
  ResetPasswordConfirmSchema,
  ChangePasswordSchema,
  ShipperInviteMemberSchema,
  AgentChatRequestSchema,
  AgentActionStatusSchema,
  AgentActionDecisionSchema,
  WorkOrderCreateSchema,
  WorkOrderUpdateSchema,
  LoadCheckCallCreateSchema,
  SettlementBatchCreateSchema,
  ShiftHandoffCreateSchema,
} from '../src/index.js';

describe('@bro/contracts — 15-Role RBAC, Permissions, Routes & Agent OS Schemas', () => {
  it('defines all 15 roles, 11 internal ops roles, labels, and separation-of-duty permissions', () => {
    expect(UserRoleSchema.options).toHaveLength(15);
    expect(OPS_ROLES).toHaveLength(11);

    for (const role of UserRoleSchema.options) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }

    for (const perm of PermissionSchema.options) {
      expect(hasPermission('super_admin', perm)).toBe(true);
      expect(hasPermission('visitor', perm)).toBe(false);
    }

    // Financial separation of duties
    expect(hasPermission('billing_clerk', 'billing:issue')).toBe(true);
    expect(hasPermission('billing_clerk', 'settlement:approve')).toBe(false);
    expect(hasPermission('settlement_clerk', 'settlement:approve')).toBe(true);
    expect(hasPermission('settlement_clerk', 'billing:issue')).toBe(false);
    expect(hasPermission('executive', 'executive:read')).toBe(true);
    expect(hasPermission('executive', 'admin:team')).toBe(false);

    const err = new RoleAccessError({
      message: 'Forbidden',
      role: 'billing_clerk',
      requiredPermission: 'settlement:approve',
      pathname: '/ops/settlements',
    });
    expect(err.statusCode).toBe(403);
    expect(err.name).toBe('RoleAccessError');
  });

  it('enforces granular route authorization and default home routes across all 15 roles', () => {
    const expectedHomes: Record<string, string> = {
      dispatcher: '/ops/dispatch',
      load_planner: '/ops/planner',
      customs_broker: '/ops/customs',
      billing_clerk: '/ops/billing',
      settlement_clerk: '/ops/settlements',
      safety_officer: '/ops/fleet',
      maintenance_manager: '/ops/maintenance',
      carrier_recruiter: '/ops/onboarding',
      night_coordinator: '/ops/escalations',
      executive: '/ops/executive',
      super_admin: '/ops',
      shipper_user: '/portal/shipper',
      shipper_admin: '/portal/shipper',
      carrier_driver: '/portal/driver',
      visitor: '/',
    };

    for (const [role, home] of Object.entries(expectedHomes)) {
      const parsedRole = UserRoleSchema.parse(role);
      expect(defaultHomeForRole(parsedRole)).toBe(home);
    }

    expect(canAccessRoute('load_planner', '/ops/planner')).toBe(true);
    expect(canAccessRoute('load_planner', '/api/ops/planner/loads')).toBe(true);
    expect(canAccessRoute('load_planner', '/ops/billing')).toBe(false);

    expect(canAccessRoute('settlement_clerk', '/ops/settlements')).toBe(true);
    expect(canAccessRoute('settlement_clerk', '/api/ops/settlements')).toBe(true);
    expect(canAccessRoute('settlement_clerk', '/ops/billing')).toBe(true);
    expect(canAccessRoute('settlement_clerk', '/ops/admin')).toBe(false);

    expect(canAccessRoute('maintenance_manager', '/ops/maintenance')).toBe(true);
    expect(canAccessRoute('maintenance_manager', '/api/ops/maintenance/work-orders')).toBe(true);
    expect(canAccessRoute('maintenance_manager', '/ops/fleet')).toBe(true);
    expect(canAccessRoute('maintenance_manager', '/ops/customs')).toBe(false);

    expect(canAccessRoute('carrier_recruiter', '/ops/onboarding')).toBe(true);
    expect(canAccessRoute('carrier_recruiter', '/api/ops/carriers')).toBe(true);
    expect(canAccessRoute('carrier_recruiter', '/ops/executive')).toBe(false);

    expect(canAccessRoute('night_coordinator', '/ops/escalations')).toBe(true);
    expect(canAccessRoute('night_coordinator', '/api/ops/escalations')).toBe(true);
    expect(canAccessRoute('night_coordinator', '/ops/admin')).toBe(false);

    expect(canAccessRoute('executive', '/ops/executive')).toBe(true);
    expect(canAccessRoute('executive', '/api/ops/executive')).toBe(true);
    expect(canAccessRoute('executive', '/ops/admin')).toBe(false);

    expect(canAccessRoute('super_admin', '/ops/admin')).toBe(true);
    expect(canAccessRoute('super_admin', '/api/ops/admin/users')).toBe(true);

    // Ops tab helper
    expect(getAuthorizedOpsTabs('visitor')).toHaveLength(0);
    expect(getAuthorizedOpsTabs('shipper_admin')).toHaveLength(0);
    const adminTabs = getAuthorizedOpsTabs('super_admin');
    expect(adminTabs.length).toBeGreaterThanOrEqual(13);
    expect(adminTabs.every((t) => t.href && t.label && t.shortLabel)).toBe(true);
    expect(isOpsRole('night_coordinator')).toBe(true);
  });

  it('maps all 12 specialist agents cleanly with role scoping', () => {
    expect(AgentIdSchema.options).toHaveLength(12);
    for (const id of AgentIdSchema.options) {
      const spec = AGENT_DIRECTORY[id];
      expect(spec.id).toBe(id);
      expect(spec.allowedRoles.length).toBeGreaterThan(0);
      expect(spec.primaryRoutes.length).toBeGreaterThan(0);
      expect(spec.quickPrompts.length).toBeGreaterThan(0);
    }

    expect(canAccessAgent('customs_broker', 'CustomsPreFlightAgent')).toBe(true);
    expect(canAccessAgent('customs_broker', 'BillingCollectionsAgent')).toBe(false);
    expect(canAccessAgent('shipper_user', 'ShipperConciergeAgent')).toBe(true);
    expect(canAccessAgent('shipper_user', 'DispatchCopilotAgent')).toBe(false);
    expect(canAccessAgent('carrier_driver', 'DriverCabAssistantAgent')).toBe(true);
    expect(getAgentsForRole('super_admin')).toHaveLength(12);
    expect(getAgentsForRole('visitor')).toHaveLength(0);
  });

  it('validates onboarding, password, agent, work-order, check-call, settlement batch, and shift handoff schemas with Zod v4', () => {
    const badInvite = StaffInviteCreateSchema.safeParse({
      name: 'A',
      email: 'not-an-email',
      role: 'visitor',
    });
    expect(badInvite.success).toBe(false);
    if (!badInvite.success) {
      expect(badInvite.error.issues.length).toBeGreaterThan(0);
    }

    expect(
      StaffInviteCreateSchema.safeParse({
        name: 'Clara Arsenault',
        email: 'clara@brotransport.com',
        role: 'load_planner',
        title: 'Corridor Planner',
      }).success,
    ).toBe(true);

    expect(
      AdminCreateUserSchema.safeParse({
        name: 'Devon Chaisson',
        email: 'devon@brotransport.com',
        role: 'night_coordinator',
        tempPassword: 'TempPassword!2026',
      }).success,
    ).toBe(true);

    expect(
      ActivateInviteSchema.safeParse({
        token: 'tok_1234567890abcdef',
        password: 'StrongPassword!2026',
      }).success,
    ).toBe(true);

    expect(ResetPasswordRequestSchema.safeParse({ email: 'ops@brotransport.com' }).success).toBe(true);
    expect(
      ResetPasswordConfirmSchema.safeParse({
        tokenOrOtp: '482910',
        email: 'ops@brotransport.com',
        password: 'NewStrongPassword!2026',
      }).success,
    ).toBe(true);
    expect(
      ChangePasswordSchema.safeParse({
        currentPassword: 'OldPassword!2026',
        newPassword: 'NewStrongPassword!2026',
      }).success,
    ).toBe(true);
    expect(
      ShipperInviteMemberSchema.safeParse({
        name: 'Liam MacLeod',
        email: 'liam@cavendishvalley.example',
        role: 'shipper_user',
      }).success,
    ).toBe(true);

    expect(AgentActionStatusSchema.parse('pending')).toBe('pending');
    expect(
      AgentChatRequestSchema.safeParse({
        agentId: 'CustomsPreFlightAgent',
        message: 'Check active ACE PAPS holds',
      }).success,
    ).toBe(true);
    expect(
      AgentActionDecisionSchema.safeParse({
        decision: 'approve',
        notes: 'Verified by customs broker',
      }).success,
    ).toBe(true);

    expect(
      WorkOrderCreateSchema.safeParse({
        equipmentId: 'eq_fb_5022',
        unitNumber: 'FB-5022',
        priority: 'high',
        title: 'Replace rear tandem brake chamber',
        description: 'Right rear axle 4 brake chamber leak detected on DVIR.',
        estimatedCostCents: 45000,
      }).success,
    ).toBe(true);

    expect(
      WorkOrderUpdateSchema.safeParse({
        status: 'completed',
        actualCostCents: 47250,
        clearOosLock: true,
      }).success,
    ).toBe(true);

    expect(
      LoadCheckCallCreateSchema.safeParse({
        loadId: 'load_9948',
        statusNote: 'Cleared CBP Calais primary booth, rolling south on I-95.',
        etaUtc: '2026-11-21T23:30:00Z',
        locationText: 'Bangor, ME (I-95 MM 182)',
        detentionMinutes: 0,
      }).success,
    ).toBe(true);

    const badBatch = SettlementBatchCreateSchema.safeParse({
      driverId: 'drv_01',
      periodStart: 1_700_100_000_000,
      periodEnd: 1_700_000_000_000,
    });
    expect(badBatch.success).toBe(false);

    expect(
      SettlementBatchCreateSchema.safeParse({
        driverId: 'drv_01',
        periodStart: 1_700_000_000_000,
        periodEnd: 1_700_600_000_000,
        loadIds: ['load_9948'],
        reimbursementsCents: 5000,
        deductionsCents: 15000,
      }).success,
    ).toBe(true);

    expect(
      ShiftHandoffCreateSchema.safeParse({
        shiftWindow: '2026-11-21 20:00-06:00 AST',
        summaryMarkdown: 'All 4 reefer loads nominal; 1 border hold resolved at Port 0115.',
        openEscalationIds: ['esc_01'],
      }).success,
    ).toBe(true);
  });
});
