CREATE TABLE `account` (
	`id` varchar(64) NOT NULL,
	`account_id` varchar(255) NOT NULL,
	`provider_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime(3),
	`refresh_token_expires_at` datetime(3),
	`scope` text,
	`password` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` varchar(64) NOT NULL,
	`config_id` varchar(255) NOT NULL DEFAULT 'default',
	`name` varchar(255),
	`start` varchar(64),
	`reference_id` varchar(255) NOT NULL,
	`prefix` varchar(64),
	`key` varchar(255) NOT NULL,
	`refill_interval` int,
	`refill_amount` int,
	`last_refill_at` datetime(3),
	`enabled` boolean DEFAULT true,
	`rate_limit_enabled` boolean DEFAULT true,
	`rate_limit_time_window` int DEFAULT 86400000,
	`rate_limit_max` int DEFAULT 10,
	`request_count` int DEFAULT 0,
	`remaining` int,
	`last_request` datetime(3),
	`expires_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`permissions` text,
	`metadata` text,
	CONSTRAINT `apikey_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`email` varchar(255) NOT NULL,
	`role` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`inviter_id` varchar(64) NOT NULL,
	CONSTRAINT `invitation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` varchar(64) NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`expires_at` datetime(3),
	`alg` varchar(32),
	`crv` varchar(32),
	CONSTRAINT `jwks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`role` varchar(64) NOT NULL DEFAULT 'member',
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `member_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` varchar(64) NOT NULL,
	`token` text NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`session_id` varchar(64),
	`user_id` varchar(64),
	`reference_id` varchar(255),
	`authorization_code_id` varchar(255),
	`resources` json,
	`requested_user_info_claims` json,
	`refresh_id` varchar(64),
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`revoked` datetime(3),
	`confirmation` json,
	`scopes` json NOT NULL,
	CONSTRAINT `oauth_access_token_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`client_secret` text,
	`client_discovery_id` varchar(255),
	`disabled` boolean DEFAULT false,
	`skip_consent` boolean,
	`enable_end_session` boolean,
	`subject_type` varchar(64),
	`scopes` json,
	`client_credentials_scopes` json,
	`user_id` varchar(64),
	`created_at` datetime(3),
	`updated_at` datetime(3),
	`name` varchar(255),
	`uri` text,
	`icon` text,
	`contacts` json,
	`tos` text,
	`policy` text,
	`software_id` varchar(255),
	`software_version` varchar(64),
	`software_statement` text,
	`redirect_uris` json NOT NULL,
	`post_logout_redirect_uris` json,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` boolean,
	`token_endpoint_auth_method` varchar(64),
	`application_type` varchar(64),
	`jwks` text,
	`jwks_uri` text,
	`grant_types` json,
	`response_types` json,
	`require_pkce` boolean,
	`dpop_bound_access_tokens` boolean,
	`reference_id` varchar(255),
	`metadata` json,
	CONSTRAINT `oauth_client_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_client_client_id_unique` UNIQUE(`client_id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_client_assertion` (
	`id` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `oauth_client_assertion_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`resource_id` varchar(64) NOT NULL,
	`metadata` json,
	`created_at` datetime(3),
	CONSTRAINT `oauth_client_resource_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` varchar(64) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(64),
	`reference_id` varchar(255),
	`resources` json,
	`requested_user_info_claims` json,
	`scopes` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `oauth_consent_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` varchar(64) NOT NULL,
	`token` text NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`session_id` varchar(64),
	`user_id` varchar(64) NOT NULL,
	`reference_id` varchar(255),
	`authorization_code_id` varchar(255),
	`resources` json,
	`requested_user_info_claims` json,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`revoked` datetime(3),
	`rotated_at` datetime(3),
	`rotation_replay_response` text,
	`rotation_replay_expires_at` datetime(3),
	`auth_time` datetime(3),
	`confirmation` json,
	`scopes` json NOT NULL,
	CONSTRAINT `oauth_refresh_token_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(512) NOT NULL,
	`name` varchar(255) NOT NULL,
	`access_token_ttl` int,
	`refresh_token_ttl` int,
	`signing_algorithm` varchar(32),
	`signing_key_id` varchar(255),
	`allowed_scopes` json,
	`custom_claims` json,
	`dpop_bound_access_tokens_required` boolean,
	`disabled` boolean DEFAULT false,
	`created_at` datetime(3),
	`updated_at` datetime(3),
	`policy_version` int,
	`metadata` json,
	CONSTRAINT `oauth_resource_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_resource_identifier_unique` UNIQUE(`identifier`)
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(255) NOT NULL,
	`logo` text,
	`created_at` datetime(3) NOT NULL,
	`metadata` text,
	CONSTRAINT `organization_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_slug_uidx` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`token` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`ip_address` varchar(64),
	`user_agent` text,
	`user_id` varchar(64) NOT NULL,
	`active_organization_id` varchar(64),
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` varchar(64) NOT NULL,
	`secret` varchar(255) NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`verified` boolean DEFAULT true,
	`failed_verification_count` int DEFAULT 0,
	`locked_until` datetime(3),
	CONSTRAINT `two_factor_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`locale` varchar(16),
	`two_factor_enabled` boolean DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(64) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_channel` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`project_id` varchar(36),
	`type` varchar(32) NOT NULL,
	`name` varchar(255) NOT NULL,
	`config` json NOT NULL DEFAULT ('{}'),
	`enabled` boolean NOT NULL DEFAULT true,
	`auto_enable` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `alert_channel_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_delivery` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`project_id` varchar(36),
	`channel_id` varchar(36),
	`channel_name` varchar(255) NOT NULL,
	`channel_type` varchar(32) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`incident_id` varchar(36),
	`monitor_name` varchar(255),
	`ok` boolean NOT NULL,
	`error` text,
	`status` varchar(16),
	`status_message` text,
	`claimed_at` datetime(3),
	`email_quota_attempted` boolean NOT NULL DEFAULT false,
	`acknowledged_at` datetime(3),
	`attempts` int NOT NULL DEFAULT 1,
	`next_attempt_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `alert_delivery_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `check_result` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`monitor_id` varchar(36) NOT NULL,
	`region` varchar(64) NOT NULL DEFAULT 'auto',
	`ok` boolean NOT NULL,
	`status_code` int,
	`latency_ms` int,
	`error` text,
	`mcp` json,
	`checked_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `check_result_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `check_rollup` (
	`monitor_id` varchar(36) NOT NULL,
	`bucket` datetime(3) NOT NULL,
	`total` int NOT NULL DEFAULT 0,
	`ok` int NOT NULL DEFAULT 0,
	`latency_sum` bigint NOT NULL DEFAULT 0,
	`latency_n` int NOT NULL DEFAULT 0,
	CONSTRAINT `check_rollup_monitor_id_bucket_pk` PRIMARY KEY(`monitor_id`,`bucket`)
);
--> statement-breakpoint
CREATE TABLE `incident` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`monitor_id` varchar(36),
	`project_id` varchar(36),
	`number` int,
	`title` varchar(255) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'investigating',
	`severity` varchar(16) NOT NULL DEFAULT 'major',
	`auto` boolean NOT NULL DEFAULT false,
	`assignee_id` varchar(64),
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`acknowledged_at` datetime(3),
	`resolved_at` datetime(3),
	`evaluation_note` text,
	`next_reminder_at` datetime(3),
	`reminder_count` int NOT NULL DEFAULT 0,
	`escalation_level` int NOT NULL DEFAULT 0,
	`next_escalation_at` datetime(3),
	`root_cause` text,
	`postmortem` text,
	`postmortem_published_at` datetime(3),
	CONSTRAINT `incident_id` PRIMARY KEY(`id`),
	CONSTRAINT `incident_project_number_idx` UNIQUE(`project_id`,`number`)
);
--> statement-breakpoint
CREATE TABLE `incident_update` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`incident_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL,
	`body` text NOT NULL,
	`visibility` varchar(16) NOT NULL DEFAULT 'public',
	`author_id` varchar(64),
	`by_person` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `incident_update_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `maintenance_reminder` (
	`maintenance_id` varchar(36) NOT NULL,
	`status_page_id` varchar(36) NOT NULL,
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `maintenance_reminder_maintenance_id_status_page_id_pk` PRIMARY KEY(`maintenance_id`,`status_page_id`)
);
--> statement-breakpoint
CREATE TABLE `maintenance_window` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`project_id` varchar(36),
	`name` varchar(255) NOT NULL,
	`series_id` varchar(36),
	`recurrence` json,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	`monitor_ids` json NOT NULL DEFAULT ('[]'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `maintenance_window_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mcp_alert_outbox` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`sequence` bigint unsigned AUTO_INCREMENT NOT NULL,
	`event_key` varchar(128) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`monitor_id` varchar(36) NOT NULL,
	`delivery_id` varchar(36) NOT NULL,
	`recipient` varchar(512) NOT NULL,
	`channel_id` varchar(36),
	`event` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`quota_attempted` boolean NOT NULL DEFAULT false,
	`quota_decision` varchar(16),
	`lease_token` varchar(36),
	`lease_until` datetime(3),
	`next_attempt_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `mcp_alert_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `mcp_alert_outbox_sequence_idx` UNIQUE(`sequence`),
	CONSTRAINT `mcp_alert_outbox_event_recipient_idx` UNIQUE(`event_key`,`recipient`)
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_lease` (
	`monitor_id` varchar(36) NOT NULL,
	`lease_token` varchar(36) NOT NULL,
	`lease_until` datetime(3) NOT NULL,
	CONSTRAINT `mcp_oauth_lease_monitor_id` PRIMARY KEY(`monitor_id`)
);
--> statement-breakpoint
CREATE TABLE `monitor` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`project_id` varchar(36),
	`import_source` varchar(128),
	`import_source_id` varchar(128),
	`name` varchar(255) NOT NULL,
	`type` varchar(32) NOT NULL DEFAULT 'http',
	`target` text NOT NULL,
	`method` varchar(16) NOT NULL DEFAULT 'GET',
	`request_body` text,
	`domain_expiry_warn_days` int NOT NULL DEFAULT 30,
	`domain_expiry` json,
	`mcp_config` json,
	`mcp_baseline` json,
	`mcp_observation` json,
	`mcp_generation` int NOT NULL DEFAULT 0,
	`expected_status` int NOT NULL DEFAULT 200,
	`interval_sec` int NOT NULL DEFAULT 60,
	`timeout_ms` int NOT NULL DEFAULT 10000,
	`failure_threshold` int NOT NULL DEFAULT 3,
	`recovery_threshold` int NOT NULL DEFAULT 1,
	`consecutive_successes` int NOT NULL DEFAULT 0,
	`regions` json NOT NULL DEFAULT ('["auto"]'),
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`status_changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`consecutive_failures` int NOT NULL DEFAULT 0,
	`last_checked_at` datetime(3),
	`next_check_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_run_token` datetime(3),
	`run_generation` int NOT NULL DEFAULT 0,
	`coverage_revision` int NOT NULL DEFAULT 0,
	`coverage_generation` int NOT NULL DEFAULT 0,
	`coverage_heartbeat_version` int NOT NULL DEFAULT 0,
	`last_run_generation` int NOT NULL DEFAULT 0,
	`paused` boolean NOT NULL DEFAULT false,
	`heartbeat_token` varchar(255),
	`keyword` text,
	`keyword_mode` varchar(32) NOT NULL DEFAULT 'contains',
	`expected_location` text,
	`json_assertions` json NOT NULL DEFAULT ('[]'),
	`headers` json NOT NULL DEFAULT ('{}'),
	`ws_message` text,
	`dns_record_type` varchar(16) NOT NULL DEFAULT 'A',
	`dns_expected_value` text,
	`dns_match_mode` varchar(16) NOT NULL DEFAULT 'exact',
	`grace_sec` int NOT NULL DEFAULT 0,
	`channel_ids` json NOT NULL DEFAULT ('[]'),
	`tags` json NOT NULL DEFAULT ('[]'),
	`slow_threshold_ms` int NOT NULL DEFAULT 1500,
	`slow_alert_after` int NOT NULL DEFAULT 0,
	`consecutive_slow` int NOT NULL DEFAULT 0,
	`depends_on_monitor_id` varchar(36),
	`min_regions_failing` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `monitor_id` PRIMARY KEY(`id`),
	CONSTRAINT `monitor_import_source_unique` UNIQUE(`organization_id`,`project_id`,`import_source`,`import_source_id`)
);
--> statement-breakpoint
CREATE TABLE `monitor_observation` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`monitor_id` varchar(36) NOT NULL,
	`observed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`state` varchar(16) NOT NULL,
	`valid_until` datetime(3),
	`maintenance_until` datetime(3),
	`revision` int NOT NULL,
	`generation` int,
	`interval_sec` int,
	`grace_sec` int,
	`timeout_ms` int,
	CONSTRAINT `monitor_observation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`reminder_interval_min` int,
	`reminder_email` boolean NOT NULL DEFAULT false,
	`escalation` json NOT NULL DEFAULT ('[]'),
	`incident_seq` int NOT NULL DEFAULT 0,
	CONSTRAINT `project_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `push_device` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`user_id` varchar(64) NOT NULL,
	`token` varchar(255) NOT NULL,
	`platform` varchar(32) NOT NULL DEFAULT 'ios',
	`environment` varchar(32) NOT NULL DEFAULT 'production',
	`locale` varchar(16),
	`name` varchar(255),
	`critical` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `push_device_id` PRIMARY KEY(`id`),
	CONSTRAINT `push_device_token_idx` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`key` varchar(512) NOT NULL,
	`window_start` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`count` int NOT NULL DEFAULT 0,
	CONSTRAINT `rate_limit_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `rdap_cache` (
	`key` varchar(255) NOT NULL,
	`value` json NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `rdap_cache_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `status_page` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`organization_id` varchar(64) NOT NULL,
	`project_id` varchar(36),
	`slug` varchar(255) NOT NULL,
	`title` varchar(255) NOT NULL,
	`custom_domain` varchar(255),
	`theme` varchar(16) NOT NULL DEFAULT 'light',
	`show_latency` boolean NOT NULL DEFAULT true,
	`external_url` varchar(512),
	`hide_branding` boolean NOT NULL DEFAULT false,
	`uptime_ok_pct` double NOT NULL DEFAULT 99.9,
	`uptime_warn_pct` double NOT NULL DEFAULT 98,
	`mcp_enabled` boolean NOT NULL DEFAULT true,
	`maintenance_reminder_hours` int NOT NULL DEFAULT 24,
	`custom_css` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `status_page_id` PRIMARY KEY(`id`),
	CONSTRAINT `status_page_slug_idx` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `status_page_component` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`status_page_id` varchar(36) NOT NULL,
	`monitor_id` varchar(36) NOT NULL,
	`group_name` varchar(255) NOT NULL DEFAULT 'Services',
	`position` int NOT NULL DEFAULT 0,
	`visible` boolean NOT NULL DEFAULT true,
	CONSTRAINT `status_page_component_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `status_subscriber` (
	`id` varchar(36) NOT NULL DEFAULT (uuid()),
	`status_page_id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`token` varchar(255) NOT NULL,
	`confirmed_at` datetime(3),
	`locale` varchar(16),
	`monitor_ids` json NOT NULL DEFAULT ('[]'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `status_subscriber_id` PRIMARY KEY(`id`),
	CONSTRAINT `status_subscriber_page_email_idx` UNIQUE(`status_page_id`,`email`),
	CONSTRAINT `status_subscriber_token_idx` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `workspace_setting` (
	`organization_id` varchar(64) NOT NULL,
	`alert_log_retention_days` int NOT NULL DEFAULT 30,
	`check_retention_days` int NOT NULL DEFAULT 90,
	`monthly_report` boolean NOT NULL DEFAULT false,
	`last_report_month` varchar(16),
	CONSTRAINT `workspace_setting_organization_id` PRIMARY KEY(`organization_id`)
);
--> statement-breakpoint
ALTER TABLE `account` ADD CONSTRAINT `account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitation` ADD CONSTRAINT `invitation_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitation` ADD CONSTRAINT `invitation_inviter_id_user_id_fk` FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `member` ADD CONSTRAINT `member_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `member` ADD CONSTRAINT `member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD CONSTRAINT `oauth_access_token_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD CONSTRAINT `oauth_access_token_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD CONSTRAINT `oauth_access_token_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD CONSTRAINT `oauth_access_token_refresh_id_oauth_refresh_token_id_fk` FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD CONSTRAINT `oauth_client_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_client_resource` ADD CONSTRAINT `oauth_client_resource_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_client_resource` ADD CONSTRAINT `oauth_client_resource_resource_id_oauth_resource_id_fk` FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD CONSTRAINT `oauth_consent_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD CONSTRAINT `oauth_consent_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD CONSTRAINT `oauth_refresh_token_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD CONSTRAINT `oauth_refresh_token_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD CONSTRAINT `oauth_refresh_token_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `two_factor` ADD CONSTRAINT `two_factor_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_channel` ADD CONSTRAINT `alert_channel_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_channel` ADD CONSTRAINT `alert_channel_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_delivery` ADD CONSTRAINT `alert_delivery_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `alert_delivery` ADD CONSTRAINT `alert_delivery_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `check_result` ADD CONSTRAINT `check_result_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `check_rollup` ADD CONSTRAINT `check_rollup_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident` ADD CONSTRAINT `incident_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident` ADD CONSTRAINT `incident_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident` ADD CONSTRAINT `incident_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident` ADD CONSTRAINT `incident_assignee_id_user_id_fk` FOREIGN KEY (`assignee_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident_update` ADD CONSTRAINT `incident_update_incident_id_incident_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incident`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `incident_update` ADD CONSTRAINT `incident_update_author_id_user_id_fk` FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `maintenance_reminder` ADD CONSTRAINT `maintenance_reminder_maintenance_id_maintenance_window_id_fk` FOREIGN KEY (`maintenance_id`) REFERENCES `maintenance_window`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `maintenance_reminder` ADD CONSTRAINT `maintenance_reminder_status_page_id_status_page_id_fk` FOREIGN KEY (`status_page_id`) REFERENCES `status_page`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `maintenance_window` ADD CONSTRAINT `maintenance_window_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `maintenance_window` ADD CONSTRAINT `maintenance_window_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mcp_alert_outbox` ADD CONSTRAINT `mcp_alert_outbox_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mcp_alert_outbox` ADD CONSTRAINT `mcp_alert_outbox_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mcp_alert_outbox` ADD CONSTRAINT `mcp_alert_outbox_delivery_id_alert_delivery_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `alert_delivery`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mcp_oauth_lease` ADD CONSTRAINT `mcp_oauth_lease_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitor` ADD CONSTRAINT `monitor_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitor` ADD CONSTRAINT `monitor_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitor` ADD CONSTRAINT `monitor_depends_on_monitor_id_monitor_id_fk` FOREIGN KEY (`depends_on_monitor_id`) REFERENCES `monitor`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `monitor_observation` ADD CONSTRAINT `monitor_observation_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project` ADD CONSTRAINT `project_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `push_device` ADD CONSTRAINT `push_device_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `status_page` ADD CONSTRAINT `status_page_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `status_page` ADD CONSTRAINT `status_page_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `status_page_component` ADD CONSTRAINT `status_page_component_status_page_id_status_page_id_fk` FOREIGN KEY (`status_page_id`) REFERENCES `status_page`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `status_page_component` ADD CONSTRAINT `status_page_component_monitor_id_monitor_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitor`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `status_subscriber` ADD CONSTRAINT `status_subscriber_status_page_id_status_page_id_fk` FOREIGN KEY (`status_page_id`) REFERENCES `status_page`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_setting` ADD CONSTRAINT `workspace_setting_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_user_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_user_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_consent_user_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_user_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `alert_delivery_org_time_idx` ON `alert_delivery` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alert_delivery_retry_idx` ON `alert_delivery` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `alert_delivery_status_idx` ON `alert_delivery` (`status`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `alert_delivery_incident_idx` ON `alert_delivery` (`incident_id`);--> statement-breakpoint
CREATE INDEX `check_result_monitor_time_idx` ON `check_result` (`monitor_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `incident_org_idx` ON `incident` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `incident_monitor_idx` ON `incident` (`monitor_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `incident_update_incident_idx` ON `incident_update` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `maintenance_org_idx` ON `maintenance_window` (`organization_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `maintenance_series_idx` ON `maintenance_window` (`organization_id`,`series_id`);--> statement-breakpoint
CREATE INDEX `mcp_alert_outbox_due_idx` ON `mcp_alert_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `mcp_alert_outbox_order_idx` ON `mcp_alert_outbox` (`monitor_id`,`recipient`,`sequence`);--> statement-breakpoint
CREATE INDEX `monitor_org_idx` ON `monitor` (`organization_id`);--> statement-breakpoint
CREATE INDEX `monitor_due_idx` ON `monitor` (`next_check_at`);--> statement-breakpoint
CREATE INDEX `monitor_observation_time_idx` ON `monitor_observation` (`monitor_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE INDEX `project_org_idx` ON `project` (`organization_id`);--> statement-breakpoint
CREATE INDEX `push_device_user_idx` ON `push_device` (`user_id`);--> statement-breakpoint
CREATE INDEX `rdap_cache_expiry_idx` ON `rdap_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_token_idx` ON `oauth_access_token` (`token`(191));--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_token_idx` ON `oauth_refresh_token` (`token`(191));
