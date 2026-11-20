import { z } from 'zod';

export const UserRoleSchema = z.enum([
  'visitor',
  'shipper_user',
  'shipper_admin',
  'carrier_driver',
  'dispatcher',
  'customs_broker',
  'billing_clerk',
  'safety_officer',
  'super_admin',
]);

export type UserRole = z.infer<typeof UserRoleSchema>;

export const OPS_ROLES: readonly UserRole[] = [
  'dispatcher',
  'customs_broker',
  'billing_clerk',
  'safety_officer',
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

export function isOpsRole(role: UserRole): boolean {
  return (OPS_ROLES as readonly string[]).includes(role);
}

export function canAccessRoute(role: UserRole, pathname: string): boolean {
  const path = pathname.toLowerCase();

  if (path.startsWith('/ops/admin') || path.startsWith('/api/ops/admin')) {
    return role === 'super_admin';
  }
  if (path.startsWith('/ops/billing') || path.startsWith('/api/ops/billing') || path.startsWith('/api/ops/settlements') || path.startsWith('/api/ops/ifta')) {
    return role === 'billing_clerk' || role === 'super_admin';
  }
  if (path.startsWith('/ops/customs') || path.startsWith('/api/ops/customs')) {
    return role === 'customs_broker' || role === 'dispatcher' || role === 'super_admin';
  }
  if (path.startsWith('/ops/fleet') || path.startsWith('/api/ops/fleet')) {
    return role === 'safety_officer' || role === 'dispatcher' || role === 'super_admin';
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
  if (isOpsRole(role)) return '/ops';
  if (role === 'shipper_user' || role === 'shipper_admin') return '/portal/shipper';
  if (role === 'carrier_driver') return '/portal/driver';
  return '/';
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
