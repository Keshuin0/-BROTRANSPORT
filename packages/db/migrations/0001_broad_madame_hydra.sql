CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`target_role` text NOT NULL,
	`target_user_id` text,
	`organization_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action_type` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text NOT NULL,
	`payload_json` text NOT NULL,
	`deterministic_preview_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by_user_id` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_actions_status` ON `agent_actions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_actions_role` ON `agent_actions` (`target_role`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_actions_agent` ON `agent_actions` (`agent_id`);--> statement-breakpoint
CREATE TABLE `load_check_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text NOT NULL,
	`driver_id` text,
	`recorded_by_user_id` text,
	`recorded_by_type` text DEFAULT 'dispatcher' NOT NULL,
	`status_note` text NOT NULL,
	`eta_utc` text,
	`location_text` text NOT NULL,
	`detention_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_check_calls_load` ON `load_check_calls` (`load_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settlement_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`driver_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`gross_pay_cents` integer NOT NULL,
	`reimbursements_cents` integer DEFAULT 0 NOT NULL,
	`deductions_cents` integer DEFAULT 0 NOT NULL,
	`net_pay_cents` integer NOT NULL,
	`load_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pdf_r2_key` text,
	`approved_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_settle_batches_driver` ON `settlement_batches` (`driver_id`);--> statement-breakpoint
CREATE INDEX `idx_settle_batches_status` ON `settlement_batches` (`status`);--> statement-breakpoint
CREATE TABLE `shift_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_window` text NOT NULL,
	`outgoing_user_id` text NOT NULL,
	`summary_markdown` text NOT NULL,
	`open_escalation_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`outgoing_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_shift_handoffs_created` ON `shift_handoffs` (`created_at`);--> statement-breakpoint
CREATE TABLE `staff_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`title` text,
	`organization_id` text,
	`driver_id` text,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_invites_token_hash_unique` ON `staff_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_staff_invites_email` ON `staff_invites` (`email`);--> statement-breakpoint
CREATE TABLE `work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`equipment_id` text NOT NULL,
	`dvir_id` text,
	`unit_number` text NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`estimated_cost_cents` integer DEFAULT 0 NOT NULL,
	`actual_cost_cents` integer,
	`vendor_name` text,
	`assigned_mechanic` text,
	`cleared_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`equipment_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dvir_id`) REFERENCES `dvir_inspections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cleared_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_work_orders_equip` ON `work_orders` (`equipment_id`);--> statement-breakpoint
CREATE INDEX `idx_work_orders_status` ON `work_orders` (`status`);--> statement-breakpoint
ALTER TABLE `loads` ADD `settlement_batch_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `title` text;--> statement-breakpoint
ALTER TABLE `users` ADD `invited_by_user_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` integer;