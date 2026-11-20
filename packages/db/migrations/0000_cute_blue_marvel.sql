CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `customs_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text,
	`manifest_type` text NOT NULL,
	`scac_or_carrier_code` text NOT NULL,
	`control_number` text NOT NULL,
	`trip_number` text NOT NULL,
	`port_code` text NOT NULL,
	`eta_utc` text NOT NULL,
	`carm_ior_verified` integer DEFAULT false NOT NULL,
	`fda_prior_notice_num` text,
	`manifest_json` text NOT NULL,
	`validation_report_json` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rns_released_at` integer,
	`cover_sheet_r2_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customs_manifests_control_number_unique` ON `customs_manifests` (`control_number`);--> statement-breakpoint
CREATE INDEX `idx_customs_load` ON `customs_manifests` (`load_id`);--> statement-breakpoint
CREATE INDEX `idx_customs_ctrl` ON `customs_manifests` (`control_number`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text,
	`driver_id` text,
	`org_id` text,
	`uploaded_by_user_id` text,
	`doc_type` text NOT NULL,
	`r2_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256_hex` text NOT NULL,
	`ocr_status` text DEFAULT 'pending' NOT NULL,
	`ocr_json` text,
	`ocr_confidence` real,
	`review_notes` text,
	`verified_by` text,
	`verified_at` integer,
	`workflow_instance_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_docs_load` ON `documents` (`load_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_ocr_status` ON `documents` (`ocr_status`);--> statement-breakpoint
CREATE TABLE `driver_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`settlement_number` text NOT NULL,
	`driver_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`loads_json` text NOT NULL,
	`deductions_json` text NOT NULL,
	`gross_pay_cents` integer NOT NULL,
	`reimbursements_cents` integer DEFAULT 0 NOT NULL,
	`deductions_cents` integer DEFAULT 0 NOT NULL,
	`net_pay_cents` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pdf_r2_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `driver_settlements_settlement_number_unique` ON `driver_settlements` (`settlement_number`);--> statement-breakpoint
CREATE INDEX `idx_settle_driver` ON `driver_settlements` (`driver_id`);--> statement-breakpoint
CREATE TABLE `drivers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`organization_id` text,
	`full_name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text NOT NULL,
	`equipment_division` text NOT NULL,
	`preferred_lanes` text NOT NULL,
	`license_number` text,
	`license_class` text DEFAULT 'Class 1 / AZ',
	`license_expiry` integer,
	`medical_card_expiry` integer,
	`fast_card_number` text,
	`pay_model` text DEFAULT 'cpm' NOT NULL,
	`pay_rate_value` integer DEFAULT 68 NOT NULL,
	`status` text DEFAULT 'applicant' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_drivers_status` ON `drivers` (`status`);--> statement-breakpoint
CREATE TABLE `dvir_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`driver_id` text NOT NULL,
	`tractor_id` text NOT NULL,
	`trailer_id` text,
	`inspection_type` text NOT NULL,
	`odometer_km` integer NOT NULL,
	`checklist_json` text NOT NULL,
	`defects_found` integer DEFAULT false NOT NULL,
	`safe_to_operate` integer DEFAULT true NOT NULL,
	`driver_signature_name` text NOT NULL,
	`signed_at` integer NOT NULL,
	`mechanic_cleared_by` text,
	`mechanic_cleared_at` integer,
	FOREIGN KEY (`driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tractor_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trailer_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mechanic_cleared_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_dvir_tractor` ON `dvir_inspections` (`tractor_id`);--> statement-breakpoint
CREATE TABLE `ebol_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stage` text NOT NULL,
	`actor_role` text NOT NULL,
	`actor_name` text NOT NULL,
	`signer_public_key_jwk` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`prev_hash` text NOT NULL,
	`block_hash` text NOT NULL,
	`ecdsa_signature_b64` text NOT NULL,
	`gps_lat` real NOT NULL,
	`gps_lon` real NOT NULL,
	`signed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ebol_load_seq` ON `ebol_blocks` (`load_id`,`seq`);--> statement-breakpoint
CREATE TABLE `edi_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text,
	`transaction_set` text NOT NULL,
	`direction` text NOT NULL,
	`control_number` text NOT NULL,
	`raw_x12` text NOT NULL,
	`parsed_json` text,
	`status` text DEFAULT 'received' NOT NULL,
	`ack_997_received` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_edi_load` ON `edi_messages` (`load_id`);--> statement-breakpoint
CREATE TABLE `equipment` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_number` text NOT NULL,
	`type` text NOT NULL,
	`vin` text NOT NULL,
	`plate` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`gvwr_kg` integer DEFAULT 36287 NOT NULL,
	`operating_hours` integer DEFAULT 1200 NOT NULL,
	`annual_inspection_expiry` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_unit_number_unique` ON `equipment` (`unit_number`);--> statement-breakpoint
CREATE INDEX `idx_equip_status` ON `equipment` (`status`);--> statement-breakpoint
CREATE TABLE `escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_ref` text NOT NULL,
	`category` text NOT NULL,
	`severity` text DEFAULT 'high' NOT NULL,
	`load_reference` text,
	`contact_name` text NOT NULL,
	`contact_channel` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`sla_deadline` integer NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `escalations_incident_ref_unique` ON `escalations` (`incident_ref`);--> statement-breakpoint
CREATE INDEX `idx_esc_status` ON `escalations` (`status`);--> statement-breakpoint
CREATE TABLE `ifta_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text,
	`tractor_id` text NOT NULL,
	`quarter` text NOT NULL,
	`jurisdiction_code` text NOT NULL,
	`distance_km` real NOT NULL,
	`fuel_liters` real DEFAULT 0 NOT NULL,
	`fuel_cost_cents` integer DEFAULT 0 NOT NULL,
	`receipt_doc_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tractor_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ifta_quarter` ON `ifta_logs` (`quarter`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_number` text NOT NULL,
	`load_id` text NOT NULL,
	`shipper_org_id` text NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`line_items_json` text NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`tax_cents` integer NOT NULL,
	`tax_label` text NOT NULL,
	`total_cents` integer NOT NULL,
	`status` text DEFAULT 'pending_approval' NOT NULL,
	`due_date` integer NOT NULL,
	`paid_at` integer,
	`payment_ref` text,
	`invoice_pdf_r2_key` text,
	`factoring_packet_r2_key` text,
	`stripe_payment_url` text,
	`workflow_instance_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipper_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoice_number_unique` ON `invoices` (`invoice_number`);--> statement-breakpoint
CREATE INDEX `idx_inv_org` ON `invoices` (`shipper_org_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_status` ON `invoices` (`status`);--> statement-breakpoint
CREATE TABLE `load_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`load_id` text NOT NULL,
	`seq` integer NOT NULL,
	`stop_type` text NOT NULL,
	`facility_name` text NOT NULL,
	`address` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`appt_start` integer NOT NULL,
	`appt_end` integer NOT NULL,
	`arrived_at` integer,
	`departed_at` integer,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stops_load` ON `load_stops` (`load_id`);--> statement-breakpoint
CREATE TABLE `loads` (
	`id` text PRIMARY KEY NOT NULL,
	`load_number` text NOT NULL,
	`quote_id` text,
	`shipper_org_id` text NOT NULL,
	`assigned_driver_id` text,
	`tractor_id` text,
	`trailer_id` text,
	`equipment_type` text NOT NULL,
	`direction` text NOT NULL,
	`status` text DEFAULT 'BOOKED' NOT NULL,
	`commodity` text NOT NULL,
	`weight_lbs` integer NOT NULL,
	`loaded_miles` integer DEFAULT 450 NOT NULL,
	`temp_setpoint_c` real,
	`is_food_fda` integer DEFAULT false NOT NULL,
	`rate_customer_cents` integer NOT NULL,
	`rate_carrier_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`detention_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shipper_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_driver_id`) REFERENCES `drivers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tractor_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trailer_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loads_load_number_unique` ON `loads` (`load_number`);--> statement-breakpoint
CREATE INDEX `idx_loads_status` ON `loads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_loads_shipper` ON `loads` (`shipper_org_id`);--> statement-breakpoint
CREATE INDEX `idx_loads_driver` ON `loads` (`assigned_driver_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`usdot` text,
	`mc_number` text,
	`scac` text,
	`cra_bn_rm` text,
	`carm_rpp_verified` integer DEFAULT false NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`payment_terms_days` integer DEFAULT 30 NOT NULL,
	`billing_email` text,
	`phone` text,
	`address` text,
	`fmcsa_snapshot_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_orgs_usdot` ON `organizations` (`usdot`);--> statement-breakpoint
CREATE INDEX `idx_orgs_type` ON `organizations` (`type`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`quote_ref` text NOT NULL,
	`shipper_org_id` text,
	`equipment_type` text NOT NULL,
	`origin_label` text NOT NULL,
	`origin_country` text NOT NULL,
	`origin_lat` real NOT NULL,
	`origin_lon` real NOT NULL,
	`dest_label` text NOT NULL,
	`dest_country` text NOT NULL,
	`dest_lat` real NOT NULL,
	`dest_lon` real NOT NULL,
	`distance_km` integer NOT NULL,
	`weight_lbs` integer NOT NULL,
	`commodity` text NOT NULL,
	`temp_setpoint_c` real,
	`accessorials_json` text NOT NULL,
	`linehaul_cents` integer NOT NULL,
	`fsc_cents` integer NOT NULL,
	`customs_cents` integer NOT NULL,
	`accessorials_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`co2_kg` integer NOT NULL,
	`recommended_port_code` text,
	`contact_name` text NOT NULL,
	`contact_email` text NOT NULL,
	`contact_phone` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shipper_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_quote_ref_unique` ON `quotes` (`quote_ref`);--> statement-breakpoint
CREATE INDEX `idx_quotes_ref` ON `quotes` (`quote_ref`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `telematics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`equipment_id` text NOT NULL,
	`load_id` text,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`reefer_temp_c` real,
	`setpoint_c` real,
	`door_closed` integer,
	`axle_weight_kg` integer,
	`tpms_psi` integer,
	`vibration_hz` real,
	`weibull_hazard` real,
	`failure_risk_pct` real,
	`rul_hours` integer,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`equipment_id`) REFERENCES `equipment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`load_id`) REFERENCES `loads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tel_equip_time` ON `telematics_events` (`equipment_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'shipper_user' NOT NULL,
	`organization_id` text,
	`phone` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_role` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `idx_users_org` ON `users` (`organization_id`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
