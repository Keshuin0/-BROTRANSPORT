import { z } from 'zod';

export const UserRoleSchema = z.enum([
  'visitor',
  'shipper_user',
  'shipper_admin',
  'carrier_driver',
  'dispatcher',
  'load_planner',
  'customs_broker',
  'billing_clerk',
  'settlement_clerk',
  'safety_officer',
  'maintenance_manager',
  'carrier_recruiter',
  'night_coordinator',
  'executive',
  'super_admin',
]);

export type UserRole = z.infer<typeof UserRoleSchema>;

export const PermissionSchema = z.enum([
  'load:read',
  'load:dispatch',
  'load:plan',
  'customs:file',
  'billing:issue',
  'settlement:approve',
  'fleet:safety',
  'maintenance:workorder',
  'recruiting:approve',
  'escalation:manage',
  'executive:read',
  'admin:team',
  'admin:agents',
  'shipper:manage_org',
  'driver:portal',
]);

export type Permission = z.infer<typeof PermissionSchema>;

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  visitor: [],
  shipper_user: ['load:read'],
  shipper_admin: ['load:read', 'shipper:manage_org'],
  carrier_driver: ['load:read', 'driver:portal'],
  dispatcher: [
    'load:read',
    'load:dispatch',
    'load:plan',
    'customs:file',
    'fleet:safety',
    'maintenance:workorder',
    'escalation:manage',
  ],
  load_planner: ['load:read', 'load:plan'],
  customs_broker: ['load:read', 'customs:file'],
  billing_clerk: ['load:read', 'billing:issue'],
  settlement_clerk: ['load:read', 'settlement:approve'],
  safety_officer: [
    'load:read',
    'fleet:safety',
    'maintenance:workorder',
    'recruiting:approve',
    'escalation:manage',
  ],
  maintenance_manager: ['load:read', 'fleet:safety', 'maintenance:workorder'],
  carrier_recruiter: ['load:read', 'recruiting:approve'],
  night_coordinator: ['load:read', 'escalation:manage'],
  executive: ['load:read', 'executive:read', 'escalation:manage'],
  super_admin: [
    'load:read',
    'load:dispatch',
    'load:plan',
    'customs:file',
    'billing:issue',
    'settlement:approve',
    'fleet:safety',
    'maintenance:workorder',
    'recruiting:approve',
    'escalation:manage',
    'executive:read',
    'admin:team',
    'admin:agents',
    'shipper:manage_org',
    'driver:portal',
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const OPS_ROLES: readonly UserRole[] = [
  'dispatcher',
  'load_planner',
  'customs_broker',
  'billing_clerk',
  'settlement_clerk',
  'safety_officer',
  'maintenance_manager',
  'carrier_recruiter',
  'night_coordinator',
  'executive',
  'super_admin',
] as const;

export const SHIPPER_ROLES: readonly UserRole[] = [
  'shipper_user',
  'shipper_admin',
  'super_admin',
] as const;

export const DRIVER_ROLES: readonly UserRole[] = [
  'carrier_driver',
  'super_admin',
] as const;

export const ROLE_LABELS: Record<UserRole, string> = {
  visitor: 'Public Visitor',
  shipper_user: 'Shipper User',
  shipper_admin: 'Shipper Admin',
  carrier_driver: 'Carrier Driver',
  dispatcher: 'Dispatcher',
  load_planner: 'Load Planner',
  customs_broker: 'Customs Broker',
  billing_clerk: 'Billing Clerk',
  settlement_clerk: 'Settlement Clerk',
  safety_officer: 'Safety Officer',
  maintenance_manager: 'Maintenance Manager',
  carrier_recruiter: 'Carrier Recruiter',
  night_coordinator: 'Night Coordinator',
  executive: 'Executive',
  super_admin: 'Super Admin',
};

export function isOpsRole(role: UserRole): boolean {
  return (OPS_ROLES as readonly string[]).includes(role);
}

export class RoleAccessError extends Error {
  public readonly statusCode: number;
  public readonly role: UserRole;
  public readonly requiredPermission?: Permission;
  public readonly pathname?: string;

  constructor(params: {
    message: string;
    role: UserRole;
    statusCode?: number;
    requiredPermission?: Permission;
    pathname?: string;
  }) {
    super(params.message);
    this.name = 'RoleAccessError';
    this.statusCode = params.statusCode ?? 403;
    this.role = params.role;
    this.requiredPermission = params.requiredPermission;
    this.pathname = params.pathname;
  }
}

export function canAccessRoute(role: UserRole, pathname: string): boolean {
  const path = pathname.split('?')[0]!.toLowerCase();

  if (path.startsWith('/ops/admin') || path.startsWith('/api/ops/admin')) {
    return role === 'super_admin';
  }
  if (path.startsWith('/ops/executive') || path.startsWith('/api/ops/executive')) {
    return role === 'executive' || role === 'super_admin';
  }
  if (path.startsWith('/ops/settlements') || path.startsWith('/api/ops/settlements')) {
    return (
      role === 'settlement_clerk' ||
      role === 'billing_clerk' ||
      role === 'executive' ||
      role === 'super_admin'
    );
  }
  if (
    path.startsWith('/ops/billing') ||
    path.startsWith('/api/ops/billing') ||
    path.startsWith('/api/ops/ifta')
  ) {
    return (
      role === 'billing_clerk' ||
      role === 'settlement_clerk' ||
      role === 'executive' ||
      role === 'super_admin'
    );
  }
  if (path.startsWith('/ops/planner') || path.startsWith('/api/ops/planner')) {
    return (
      role === 'load_planner' ||
      role === 'dispatcher' ||
      role === 'executive' ||
      role === 'super_admin'
    );
  }
  if (path.startsWith('/ops/customs') || path.startsWith('/api/ops/customs')) {
    return role === 'customs_broker' || role === 'dispatcher' || role === 'super_admin';
  }
  if (path.startsWith('/ops/fleet') || path.startsWith('/api/ops/fleet')) {
    return (
      role === 'safety_officer' ||
      role === 'maintenance_manager' ||
      role === 'dispatcher' ||
      role === 'super_admin'
    );
  }
  if (path.startsWith('/ops/maintenance') || path.startsWith('/api/ops/maintenance')) {
    return (
      role === 'maintenance_manager' ||
      role === 'safety_officer' ||
      role === 'dispatcher' ||
      role === 'super_admin'
    );
  }
  if (path.startsWith('/ops/onboarding') || path.startsWith('/api/ops/carriers')) {
    return role === 'carrier_recruiter' || role === 'safety_officer' || role === 'super_admin';
  }
  if (path.startsWith('/ops/escalations') || path.startsWith('/api/ops/escalations')) {
    return (
      role === 'night_coordinator' ||
      role === 'dispatcher' ||
      role === 'safety_officer' ||
      role === 'executive' ||
      role === 'super_admin'
    );
  }
  if (path.startsWith('/ops') || path.startsWith('/api/ops')) {
    return isOpsRole(role);
  }
  if (path.startsWith('/portal/shipper') || path.startsWith('/api/shipper')) {
    return (SHIPPER_ROLES as readonly string[]).includes(role);
  }
  if (path.startsWith('/portal/driver') || path.startsWith('/api/driver')) {
    return (DRIVER_ROLES as readonly string[]).includes(role);
  }
  return true;
}

export function defaultHomeForRole(role: UserRole): string {
  switch (role) {
    case 'dispatcher':
      return '/ops/dispatch';
    case 'load_planner':
      return '/ops/planner';
    case 'customs_broker':
      return '/ops/customs';
    case 'billing_clerk':
      return '/ops/billing';
    case 'settlement_clerk':
      return '/ops/settlements';
    case 'safety_officer':
      return '/ops/fleet';
    case 'maintenance_manager':
      return '/ops/maintenance';
    case 'carrier_recruiter':
      return '/ops/onboarding';
    case 'night_coordinator':
      return '/ops/escalations';
    case 'executive':
      return '/ops/executive';
    case 'super_admin':
      return '/ops';
    case 'shipper_user':
    case 'shipper_admin':
      return '/portal/shipper';
    case 'carrier_driver':
      return '/portal/driver';
    default:
      return '/';
  }
}

export interface OpsNavTab {
  href: string;
  label: string;
  shortLabel: string;
  code: string;
}

export const OPS_NAV_TABS: readonly OpsNavTab[] = [
  { href: '/ops', label: 'Control Tower', shortLabel: 'Tower', code: '00' },
  { href: '/ops/executive', label: 'Executive P&L', shortLabel: 'Exec', code: '01' },
  { href: '/ops/dispatch', label: 'Dispatch & EDI', shortLabel: 'Dispatch', code: '02' },
  { href: '/ops/planner', label: 'Load Planner', shortLabel: 'Planner', code: '03' },
  { href: '/ops/documents', label: 'AI OCR Queue', shortLabel: 'OCR Docs', code: '04' },
  { href: '/ops/customs', label: 'Customs & CARM', shortLabel: 'Customs', code: '05' },
  { href: '/ops/billing', label: 'Billing & IFTA', shortLabel: 'Billing', code: '06' },
  { href: '/ops/settlements', label: 'Driver Settlements', shortLabel: 'Settle', code: '07' },
  { href: '/ops/fleet', label: 'Fleet & Safety', shortLabel: 'Fleet', code: '08' },
  { href: '/ops/maintenance', label: 'Shop & Maintenance', shortLabel: 'Shop', code: '09' },
  { href: '/ops/onboarding', label: 'Carrier Onboarding', shortLabel: 'Recruit', code: '10' },
  { href: '/ops/escalations', label: 'Escalations & Night', shortLabel: 'Alerts', code: '11' },
  { href: '/ops/admin', label: 'Admin & Agents', shortLabel: 'Admin', code: '12' },
] as const;

export function getAuthorizedOpsTabs(role: UserRole): OpsNavTab[] {
  if (!isOpsRole(role)) return [];
  return OPS_NAV_TABS.filter((tab) => canAccessRoute(role, tab.href));
}

export const EscalationCategorySchema = z.enum([
  'border_hold',
  'cold_chain_excursion',
  'roadside_intercept',
  'urgent_capacity',
]);

export const EscalationSeveritySchema = z.enum(['high', 'critical']);

export const EscalationCreateSchema = z.object({
  category: EscalationCategorySchema,
  severity: EscalationSeveritySchema.default('high'),
  loadReference: z.string().trim().max(48).optional(),
  contactName: z.string().trim().min(2, { error: 'Contact name must be at least 2 characters.' }),
  contactChannel: z.string().trim().min(5, { error: 'Provide a valid phone number or email.' }),
  summary: z.string().trim().min(10, { error: 'Describe the operational issue in at least 10 characters.' }).max(1000),
});

export type EscalationCreateInput = z.infer<typeof EscalationCreateSchema>;
