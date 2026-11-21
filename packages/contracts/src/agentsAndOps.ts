import { z } from 'zod';
import { UserRoleSchema, type UserRole } from './auth.js';

const AssignableRoleSchema = UserRoleSchema.refine((role) => role !== 'visitor', {
  error: 'Select an active portal or operational role.',
});

export const StaffInviteCreateSchema = z.object({
  name: z.string().trim().min(2, { error: 'Full name must be at least 2 characters.' }).max(100),
  email: z.email({ error: 'Provide a valid corporate email address.' }),
  role: AssignableRoleSchema,
  title: z.string().trim().min(2, { error: 'Title must be at least 2 characters.' }).max(80).optional(),
  organizationId: z.string().trim().min(1).max(80).optional(),
  driverId: z.string().trim().min(1).max(80).optional(),
});

export type StaffInviteCreateInput = z.infer<typeof StaffInviteCreateSchema>;

export const AdminCreateUserSchema = z.object({
  name: z.string().trim().min(2, { error: 'Full name must be at least 2 characters.' }).max(100),
  email: z.email({ error: 'Provide a valid corporate email address.' }),
  role: AssignableRoleSchema,
  title: z.string().trim().min(2, { error: 'Title must be at least 2 characters.' }).max(80).optional(),
  organizationId: z.string().trim().min(1).max(80).optional(),
  tempPassword: z.string().min(10, { error: 'Temporary password must be at least 10 characters.' }).max(128),
});

export type AdminCreateUserInput = z.infer<typeof AdminCreateUserSchema>;

export const ActivateInviteSchema = z.object({
  token: z.string().trim().min(16, { error: 'Valid invite activation token is required.' }).max(256),
  password: z.string().min(10, { error: 'Password must be at least 10 characters.' }).max(128),
});

export type ActivateInviteInput = z.infer<typeof ActivateInviteSchema>;

export const ResetPasswordRequestSchema = z.object({
  email: z.email({ error: 'Provide a valid email address.' }),
});

export type ResetPasswordRequestInput = z.infer<typeof ResetPasswordRequestSchema>;

export const ResetPasswordConfirmSchema = z.object({
  tokenOrOtp: z.string().trim().min(6, { error: 'Provide a valid 6-digit OTP or reset token.' }).max(256),
  email: z.email({ error: 'Provide a valid email address.' }).optional(),
  password: z.string().min(10, { error: 'New password must be at least 10 characters.' }).max(128),
});

export type ResetPasswordConfirmInput = z.infer<typeof ResetPasswordConfirmSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, { error: 'Current password cannot be empty.' }).max(128).optional(),
  newPassword: z.string().min(10, { error: 'New password must be at least 10 characters.' }).max(128),
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const ShipperInviteMemberSchema = z.object({
  name: z.string().trim().min(2, { error: 'Member name must be at least 2 characters.' }).max(100),
  email: z.email({ error: 'Provide a valid corporate email address.' }),
  role: z.enum(['shipper_user', 'shipper_admin']).default('shipper_user'),
});

export type ShipperInviteMemberInput = z.infer<typeof ShipperInviteMemberSchema>;

export const AgentIdSchema = z.enum([
  'DispatchCopilotAgent',
  'LoadPlannerAgent',
  'CustomsPreFlightAgent',
  'BillingCollectionsAgent',
  'SettlementAuditAgent',
  'FleetWatchdogAgent',
  'ShopMaintenanceAgent',
  'RecruiterVettingAgent',
  'EscalationResponseAgent',
  'ExecutiveChiefOfStaffAgent',
  'ShipperConciergeAgent',
  'DriverCabAssistantAgent',
]);

export type AgentId = z.infer<typeof AgentIdSchema>;

export interface AgentSpec {
  id: AgentId;
  name: string;
  specialtyTitle: string;
  description: string;
  allowedRoles: readonly UserRole[];
  primaryRoutes: readonly string[];
  quickPrompts: readonly string[];
  hitlRequiredForMutations: boolean;
}

export const AGENT_DIRECTORY: Record<AgentId, AgentSpec> = {
  DispatchCopilotAgent: {
    id: 'DispatchCopilotAgent',
    name: 'Dispatch Copilot',
    specialtyTitle: 'Live Corridor Dispatch & EDI Coordinator',
    description: 'Assists dispatchers with active load status transitions, equipment matching, check-calls, and EDI 204/990/214 execution.',
    allowedRoles: ['dispatcher', 'night_coordinator', 'executive', 'super_admin'],
    primaryRoutes: ['/ops', '/ops/dispatch'],
    quickPrompts: [
      'Summarize loads currently held or approaching appointment windows.',
      'Suggest best available reefer tractor/trailer pair for PEI to Boston.',
      'Draft EDI 214 delay status update for shipper review.',
    ],
    hitlRequiredForMutations: true,
  },
  LoadPlannerAgent: {
    id: 'LoadPlannerAgent',
    name: 'Load Planner Agent',
    specialtyTitle: 'Corridor Capacity & Backhaul Optimization',
    description: 'Evaluates open tenders, deadhead mileage, equipment divisions, and margin impact for pre-dispatch load planning.',
    allowedRoles: ['load_planner', 'dispatcher', 'executive', 'super_admin'],
    primaryRoutes: ['/ops/planner', '/ops/dispatch'],
    quickPrompts: [
      'Rank unassigned booked loads by margin and pickup urgency.',
      'Identify Boston/New England to Atlantic Canada backhaul opportunities.',
      'Check equipment balance across dry_van, reefer, and flatbed pools.',
    ],
    hitlRequiredForMutations: true,
  },
  CustomsPreFlightAgent: {
    id: 'CustomsPreFlightAgent',
    name: 'Customs Pre-Flight Agent',
    specialtyTitle: 'CBSA ACI PARS, CBP ACE PAPS & CARM R2 Validator',
    description: 'Audits HS codes, FDA 2-hour Prior Notice windows, CARM RPP importer bonds, and border crossing wait times before wheels roll.',
    allowedRoles: ['customs_broker', 'dispatcher', 'super_admin'],
    primaryRoutes: ['/ops/customs', '/ops/documents'],
    quickPrompts: [
      'Audit all active cross-border manifests for FDA or CARM R2 blockers.',
      'Compare commercial wait times between Port 0115 (Calais) and Port 0106 (Houlton).',
      'Flag commercial invoices awaiting customs broker verification.',
    ],
    hitlRequiredForMutations: true,
  },
  BillingCollectionsAgent: {
    id: 'BillingCollectionsAgent',
    name: 'Billing & Collections Agent',
    specialtyTitle: 'Zero-Rated Cross-Border AR, Factoring & IFTA Analyst',
    description: 'Reconciles delivered loads ready for invoicing, verifies Canada ETA Schedule VI tax rules, tracks AR aging, and validates IFTA fuel logs.',
    allowedRoles: ['billing_clerk', 'executive', 'super_admin'],
    primaryRoutes: ['/ops/billing'],
    quickPrompts: [
      'List delivered loads missing finalized customer invoices.',
      'Summarize AR aging buckets over 30 days and draft payment reminder.',
      'Verify current quarter IFTA jurisdiction mileage vs fuel receipts.',
    ],
    hitlRequiredForMutations: true,
  },
  SettlementAuditAgent: {
    id: 'SettlementAuditAgent',
    name: 'Settlement Audit Agent',
    specialtyTitle: 'Driver CPM & Owner-Operator Payroll Auditor',
    description: 'Prepares bi-weekly settlement batches in integer cents, verifies detention pay and deductions, and enforces POD verification gates.',
    allowedRoles: ['settlement_clerk', 'billing_clerk', 'executive', 'super_admin'],
    primaryRoutes: ['/ops/settlements', '/ops/billing'],
    quickPrompts: [
      'Find delivered loads not yet batched into a driver settlement.',
      'Audit detention and reimbursement line items for accuracy.',
      'Compute projected batch totals for active drivers this period.',
    ],
    hitlRequiredForMutations: true,
  },
  FleetWatchdogAgent: {
    id: 'FleetWatchdogAgent',
    name: 'Fleet Watchdog Agent',
    specialtyTitle: 'DOT/NSC Compliance & Weibull-Cox RUL Sentinel',
    description: 'Monitors driver medical card/CDL expiries, annual CVIP inspections, cold-chain excursions, and Weibull-Cox hazard scores.',
    allowedRoles: ['safety_officer', 'maintenance_manager', 'dispatcher', 'super_admin'],
    primaryRoutes: ['/ops/fleet'],
    quickPrompts: [
      'List drivers and units with compliance expirations inside 30 days.',
      'Identify active units with elevated or critical Weibull failure risk.',
      'Review un-cleared DVIR defects requiring Out-Of-Service lock review.',
    ],
    hitlRequiredForMutations: true,
  },
  ShopMaintenanceAgent: {
    id: 'ShopMaintenanceAgent',
    name: 'Shop Maintenance Agent',
    specialtyTitle: 'Preventive Maintenance & DVIR Work Order Coordinator',
    description: 'Converts DVIR defect reports and high-hazard telematics readings into prioritized shop work orders and vendor estimates.',
    allowedRoles: ['maintenance_manager', 'safety_officer', 'dispatcher', 'super_admin'],
    primaryRoutes: ['/ops/maintenance', '/ops/fleet'],
    quickPrompts: [
      'Prioritize open shop work orders by safety criticality and RUL hours.',
      'Draft work order from latest DVIR defect or CVIP expiry alert.',
      'Summarize estimated vs actual maintenance spend across active tractors.',
    ],
    hitlRequiredForMutations: true,
  },
  RecruiterVettingAgent: {
    id: 'RecruiterVettingAgent',
    name: 'Recruiter Vetting Agent',
    specialtyTitle: 'FMCSA Authority, BIPD Insurance & Double-Brokering Screen',
    description: 'Audits applicant drivers and partner carriers against FMCSA safety ratings, 49 CFR 387.9 insurance minimums, and fleet-size anomalies.',
    allowedRoles: ['carrier_recruiter', 'safety_officer', 'super_admin'],
    primaryRoutes: ['/ops/onboarding'],
    quickPrompts: [
      'Summarize pending driver and carrier applications awaiting approval.',
      'Flag carriers with insurance gaps or double-brokering risk indicators.',
      'Verify Class 1 / AZ and FAST card readiness for cross-border applicants.',
    ],
    hitlRequiredForMutations: true,
  },
  EscalationResponseAgent: {
    id: 'EscalationResponseAgent',
    name: 'Escalation Response Agent',
    specialtyTitle: '24/7 Incident Triage & Shift Handoff Coordinator',
    description: 'Tracks SLA deadlines on border holds, cold-chain excursions, and roadside intercepts, and drafts structured shift handoff briefings.',
    allowedRoles: ['night_coordinator', 'dispatcher', 'safety_officer', 'executive', 'super_admin'],
    primaryRoutes: ['/ops/escalations', '/ops'],
    quickPrompts: [
      'Rank open escalations by SLA deadline and severity.',
      'Draft structured shift handoff briefing from recent check-calls and incidents.',
      'Suggest immediate containment checklist for active cold-chain excursion.',
    ],
    hitlRequiredForMutations: true,
  },
  ExecutiveChiefOfStaffAgent: {
    id: 'ExecutiveChiefOfStaffAgent',
    name: 'Executive Chief of Staff',
    specialtyTitle: 'Cross-Division Margin, Cashflow & SLA Intelligence',
    description: 'Synthesizes lane P&L margins, fleet utilization, AR aging, and operational bottleneck alerts for executive leadership.',
    allowedRoles: ['executive', 'super_admin'],
    primaryRoutes: ['/ops/executive', '/ops'],
    quickPrompts: [
      'Deliver executive margin and revenue brief across active lanes.',
      'Highlight operational bottlenecks affecting on-time border clearance.',
      'Summarize pending high-value HITL agent proposals across departments.',
    ],
    hitlRequiredForMutations: true,
  },
  ShipperConciergeAgent: {
    id: 'ShipperConciergeAgent',
    name: 'Shipper Concierge',
    specialtyTitle: 'Tenant-Scoped Shipment Tracking, Quotes & Docs Assistant',
    description: 'Helps shippers track active loads, verify customs clearance milestones, retrieve invoices, and prepare instant lane quotes.',
    allowedRoles: ['shipper_user', 'shipper_admin', 'super_admin'],
    primaryRoutes: ['/portal/shipper'],
    quickPrompts: [
      'Summarize live status and border ETAs for my organization loads.',
      'List unpaid or pending invoices with due dates.',
      'Explain required customs documents for my cross-border shipment.',
    ],
    hitlRequiredForMutations: true,
  },
  DriverCabAssistantAgent: {
    id: 'DriverCabAssistantAgent',
    name: 'Driver Cab Assistant',
    specialtyTitle: 'In-Cab Dispatch, Border Pre-Flight & DVIR Copilot',
    description: 'Guides drivers through assigned stop appointments, ACE/ACI control numbers, DVIR pre-trip checklists, and settlement status.',
    allowedRoles: ['carrier_driver', 'super_admin'],
    primaryRoutes: ['/portal/driver'],
    quickPrompts: [
      'What is my next pickup or delivery appointment and port code?',
      'Check if my ACE PAPS / ACI PARS customs clearance is released.',
      'Summarize my latest settlement statement and detention pay.',
    ],
    hitlRequiredForMutations: true,
  },
};

export function getAgentsForRole(role: UserRole): AgentSpec[] {
  return (Object.values(AGENT_DIRECTORY) as AgentSpec[]).filter((spec) =>
    spec.allowedRoles.includes(role),
  );
}

export function canAccessAgent(role: UserRole, agentId: AgentId): boolean {
  return AGENT_DIRECTORY[agentId].allowedRoles.includes(role);
}

export const AgentChatRequestSchema = z.object({
  agentId: AgentIdSchema,
  message: z.string().trim().min(1, { error: 'Prompt message cannot be empty.' }).max(2000),
  contextEntityType: z.string().trim().max(48).optional(),
  contextEntityId: z.string().trim().max(80).optional(),
  routePath: z.string().trim().max(160).optional(),
});

export type AgentChatRequest = z.infer<typeof AgentChatRequestSchema>;

export const AgentActionStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'executed',
  'expired',
]);

export type AgentActionStatus = z.infer<typeof AgentActionStatusSchema>;

export const AgentActionDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().trim().max(500).optional(),
});

export type AgentActionDecision = z.infer<typeof AgentActionDecisionSchema>;

export const WorkOrderPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type WorkOrderPriority = z.infer<typeof WorkOrderPrioritySchema>;

export const WorkOrderStatusSchema = z.enum([
  'open',
  'in_progress',
  'awaiting_parts',
  'completed',
  'cancelled',
]);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatusSchema>;

export const WorkOrderCreateSchema = z.object({
  equipmentId: z.string().trim().min(1, { error: 'Equipment ID is required.' }),
  dvirId: z.string().trim().min(1).optional(),
  unitNumber: z.string().trim().min(2, { error: 'Unit number is required.' }).max(32),
  priority: WorkOrderPrioritySchema.default('medium'),
  title: z.string().trim().min(3, { error: 'Work order title is required.' }).max(140),
  description: z.string().trim().min(5, { error: 'Work order description must be at least 5 characters.' }).max(2000),
  estimatedCostCents: z.number().int().min(0).default(0),
  vendorName: z.string().trim().max(120).optional(),
  assignedMechanic: z.string().trim().max(100).optional(),
});

export type WorkOrderCreateInput = z.infer<typeof WorkOrderCreateSchema>;

export const WorkOrderUpdateSchema = z.object({
  status: WorkOrderStatusSchema.optional(),
  priority: WorkOrderPrioritySchema.optional(),
  actualCostCents: z.number().int().min(0).optional(),
  vendorName: z.string().trim().max(120).optional(),
  assignedMechanic: z.string().trim().max(100).optional(),
  description: z.string().trim().min(5).max(2000).optional(),
  clearOosLock: z.boolean().optional(),
});

export type WorkOrderUpdateInput = z.infer<typeof WorkOrderUpdateSchema>;

export const LoadCheckCallCreateSchema = z.object({
  loadId: z.string().trim().min(1, { error: 'Load ID is required.' }),
  driverId: z.string().trim().min(1).optional(),
  statusNote: z.string().trim().min(3, { error: 'Status note must be at least 3 characters.' }).max(1000),
  etaUtc: z.iso.datetime({ error: 'ETA must be a valid ISO-8601 UTC timestamp.' }).optional(),
  locationText: z.string().trim().min(2, { error: 'Location description is required.' }).max(160),
  detentionMinutes: z.number().int().min(0).max(10_080).default(0),
});

export type LoadCheckCallCreateInput = z.infer<typeof LoadCheckCallCreateSchema>;

export const SettlementBatchCreateSchema = z
  .object({
    driverId: z.string().trim().min(1, { error: 'Driver ID is required.' }),
    periodStart: z.number().int().positive(),
    periodEnd: z.number().int().positive(),
    loadIds: z.array(z.string().trim().min(1)).min(1).optional(),
    reimbursementsCents: z.number().int().min(0).default(0),
    deductionsCents: z.number().int().min(0).default(0),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    error: 'Settlement periodEnd must be greater than or equal to periodStart.',
    path: ['periodEnd'],
  });

export type SettlementBatchCreateInput = z.infer<typeof SettlementBatchCreateSchema>;

export const ShiftHandoffCreateSchema = z.object({
  shiftWindow: z.string().trim().min(3, { error: 'Shift window label is required.' }).max(64),
  summaryMarkdown: z.string().trim().min(10, { error: 'Shift handoff summary must be at least 10 characters.' }).max(6000),
  openEscalationIds: z.array(z.string().trim().min(1)).default([]),
});

export type ShiftHandoffCreateInput = z.infer<typeof ShiftHandoffCreateSchema>;
