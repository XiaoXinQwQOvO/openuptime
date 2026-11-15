import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  double,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  datetime,
  uniqueIndex,
  varchar,
  type AnyMySqlColumn,
} from "drizzle-orm/mysql-core";
import type { DomainExpiry, JsonAssertion, McpConfig, McpToolSchema, McpObservation, McpCheckDiagnostics, McpAlertEvent } from "@openuptime/repo";
import { organization, user } from "./auth-schema";

/** Milliseconds-precision UTC timestamp; MySQL stores it in the session time zone, which the driver pins to UTC. */
const ts = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const tsNow = (name: string) => ts(name).notNull().default(sql`CURRENT_TIMESTAMP(3)`);
/** Application-generated UUIDs. MySQL 8.0.13+ accepts the expression as a column default. */
const uuid = (name: string) => varchar(name, { length: 36 });
const uuidPk = () => uuid("id").primaryKey().default(sql`(uuid())`);
const uuidRef = (name: string) => uuid(name);

/** Grouped projects/monitors use the same id width as the auth tables they point at. */
const orgRef = (name: string) => varchar(name, { length: 64 });
const str = (name: string, length = 255) => varchar(name, { length });

export const monitorType = (name: string) => varchar(name, { length: 32 }).$type<"http" | "tcp" | "dns" | "heartbeat" | "postgres" | "mysql" | "redis" | "websocket" | "domain" | "mcp" | "evm" | "solana">();
export const monitorStatus = (name: string) => varchar(name, { length: 16 }).$type<"pending" | "up" | "degraded" | "down" | "paused">();
export const incidentStatus = (name: string) => varchar(name, { length: 16 }).$type<"investigating" | "identified" | "monitoring" | "resolved">();
export const incidentUpdateVisibility = (name: string) => varchar(name, { length: 16 }).$type<"public" | "internal">();
export const incidentSeverity = (name: string) => varchar(name, { length: 16 }).$type<"minor" | "major">();
export const channelType = (name: string) => varchar(name, { length: 32 }).$type<"email" | "slack" | "telegram" | "webhook" | "pagerduty" | "lark" | "push" | "discord" | "teams" | "ntfy" | "bark" | "apprise">();

/** A project groups monitors, status pages, channels and maintenance inside one workspace (organization). */
export const project = mysqlTable(
  "project",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: str("name").notNull(),
    createdAt: tsNow("created_at"),
    /** Repeat a push alert every N minutes until the incident is acknowledged or resolved; null = off. */
    reminderIntervalMin: int("reminder_interval_min"),
    /** Whether repeats also go to email channels (push channels always get them when repeats are on). */
    reminderEmail: boolean("reminder_email").notNull().default(false),
    /** Ordered escalation steps: [{ channelIds, escalateAfterMin }], minutes counted from the start of the incident. */
    escalation: json("escalation").$type<{ channelIds: string[]; escalateAfterMin: number }[]>().notNull().default([]),
    /** Last incident number handed out in this project; bumped atomically when an incident is created. */
    incidentSeq: int("incident_seq").notNull().default(0),
  },
  (t) => [index("project_org_idx").on(t.organizationId)],
);

const projectRef = () => uuidRef("project_id").references(() => project.id, { onDelete: "cascade" });

export const monitor = mysqlTable(
  "monitor",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    importSource: str("import_source", 128),
    importSourceId: str("import_source_id", 128),
    name: str("name").notNull(),
    type: monitorType("type").notNull().default("http"),
    /** URL for http, ws(s):// URL for websocket, host:port for tcp / postgres / mysql / redis, hostname for dns. */
    target: text("target").notNull(),
    method: str("method", 16).notNull().default("GET"),
    requestBody: text("request_body"),
    domainExpiryWarnDays: int("domain_expiry_warn_days").notNull().default(30),
    domainExpiry: json("domain_expiry").$type<DomainExpiry>(),
    mcpConfig: json("mcp_config").$type<McpConfig>(),
    mcpBaseline: json("mcp_baseline").$type<McpToolSchema[]>(),
    mcpObservation: json("mcp_observation").$type<McpObservation>(),
    mcpGeneration: int("mcp_generation").notNull().default(0),
    expectedStatus: int("expected_status").notNull().default(200),
    intervalSec: int("interval_sec").notNull().default(60),
    timeoutMs: int("timeout_ms").notNull().default(10000),
    /** consecutive failures before an incident is opened */
    failureThreshold: int("failure_threshold").notNull().default(3),
    recoveryThreshold: int("recovery_threshold").notNull().default(1),
    consecutiveSuccesses: int("consecutive_successes").notNull().default(0),
    regions: json("regions").$type<string[]>().notNull().default(["auto"]),
    status: monitorStatus("status").notNull().default("pending"),
    /** When `status` last changed: the start of the current streak, which bounds what counts as handled during it. */
    statusChangedAt: tsNow("status_changed_at"),
    consecutiveFailures: int("consecutive_failures").notNull().default(0),
    lastCheckedAt: ts("last_checked_at"),
    nextCheckAt: tsNow("next_check_at"),
    /** due time the claim of the run that started last had assigned; a redelivered queue message carries the same one */
    lastRunToken: ts("last_run_token"),
    /** Claim order is independent of the interval and heartbeat deadline. */
    runGeneration: int("run_generation").notNull().default(0),
    coverageRevision: int("coverage_revision").notNull().default(0),
    coverageGeneration: int("coverage_generation").notNull().default(0),
    coverageHeartbeatVersion: int("coverage_heartbeat_version").notNull().default(0),
    lastRunGeneration: int("last_run_generation").notNull().default(0),
    paused: boolean("paused").notNull().default(false),
    heartbeatToken: str("heartbeat_token", 255),
    /** http: response body must contain (or, with keywordMode "absent", must not contain) this text; websocket: the first message back */
    keyword: text("keyword"),
    keywordMode: str("keyword_mode", 32).notNull().default("contains"),
    /** http, with a redirect status expected: where the redirect must lead (absolute URL, or a path on the target's site) */
    expectedLocation: text("expected_location"),
    /** http: assertions on the JSON response body, all of which must hold */
    jsonAssertions: json("json_assertions").$type<JsonAssertion[]>().notNull().default([]),
    /** http: extra request headers (also used for bearer / basic auth) */
    headers: json("headers").$type<Record<string, string>>().notNull().default({}),
    /** websocket: text sent once the connection is open; a reply must then come back */
    wsMessage: text("ws_message"),
    dnsRecordType: str("dns_record_type", 16).$type<"A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS">().notNull().default("A"),
    dnsExpectedValue: text("dns_expected_value"),
    dnsMatchMode: str("dns_match_mode", 16).$type<"exact" | "contains">().notNull().default("exact"),
    /** heartbeat: how long after the expected ping we wait before declaring it missed */
    graceSec: int("grace_sec").notNull().default(0),
    /** alert only these channels; empty = every enabled channel in the org */
    channelIds: json("channel_ids").$type<string[]>().notNull().default([]),
    /** free-form labels for grouping and filtering */
    tags: json("tags").$type<string[]>().notNull().default([]),
    /** a successful check slower than this marks the monitor "degraded" */
    slowThresholdMs: int("slow_threshold_ms").notNull().default(1500),
    /** open a "slow" incident after this many consecutive slow checks; 0 = never alert on latency */
    slowAlertAfter: int("slow_alert_after").notNull().default(0),
    consecutiveSlow: int("consecutive_slow").notNull().default(0),
    /** while this monitor is down, a failure of this one opens no incident and sends no alert (same project, never a cycle) */
    dependsOnMonitorId: uuidRef("depends_on_monitor_id").references((): AnyMySqlColumn => monitor.id, { onDelete: "set null" }),
    /** several regions: this many must fail before the monitor goes down; 0 = a majority of the regions that answered */
    minRegionsFailing: int("min_regions_failing").notNull().default(0),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    index("monitor_org_idx").on(t.organizationId),
    index("monitor_due_idx").on(t.nextCheckAt),
    uniqueIndex("monitor_import_source_unique").on(t.organizationId, t.projectId, t.importSource, t.importSourceId),
  ],
);

/**
 * One OAuth refresh at a time per MCP monitor, without holding a database connection during the token request.
 * A row is a lease: whoever inserted it (or replaced an expired one) may refresh until `leaseUntil`.
 */
export const mcpOAuthLease = mysqlTable("mcp_oauth_lease", {
  monitorId: uuidRef("monitor_id").primaryKey().references(() => monitor.id, { onDelete: "cascade" }),
  leaseToken: uuid("lease_token").notNull(),
  leaseUntil: ts("lease_until").notNull(),
});

/** Append-only observations and configuration fences. No historical backfill from mutable status or incidents. */
export const monitorObservation = mysqlTable("monitor_observation", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  monitorId: uuidRef("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
  observedAt: tsNow("observed_at"),
  state: str("state", 16).$type<"up" | "down" | "degraded" | "paused" | "unknown">().notNull(),
  validUntil: ts("valid_until"),
  maintenanceUntil: ts("maintenance_until"),
  revision: int("revision").notNull(),
  generation: int("generation"),
  intervalSec: int("interval_sec"),
  graceSec: int("grace_sec"),
  timeoutMs: int("timeout_ms"),
}, (t) => [index("monitor_observation_time_idx").on(t.monitorId, t.observedAt, t.id)]);

export const rdapCache = mysqlTable("rdap_cache", { key: str("key").primaryKey(), value: json("value").$type<unknown>().notNull(), expiresAt: ts("expires_at").notNull() }, (t) => [index("rdap_cache_expiry_idx").on(t.expiresAt)]);

export const checkResult = mysqlTable(
  "check_result",
  {
    id: uuidPk(),
    monitorId: uuidRef("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
    region: str("region", 64).notNull().default("auto"),
    ok: boolean("ok").notNull(),
    statusCode: int("status_code"),
    latencyMs: int("latency_ms"),
    error: text("error"),
    mcp: json("mcp").$type<McpCheckDiagnostics>(),
    checkedAt: tsNow("checked_at"),
  },
  (t) => [index("check_result_monitor_time_idx").on(t.monitorId, t.checkedAt)],
);

/** Pre-aggregated check results per monitor and hour: uptime and latency stats read this instead of scanning check_result. */
export const checkRollup = mysqlTable(
  "check_rollup",
  {
    monitorId: uuidRef("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
    bucket: ts("bucket").notNull(),
    total: int("total").notNull().default(0),
    ok: int("ok").notNull().default(0),
    latencySum: bigint("latency_sum", { mode: "number" }).notNull().default(0),
    latencyN: int("latency_n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.bucket] })],
);

export const incident = mysqlTable(
  "incident",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    monitorId: uuidRef("monitor_id").references(() => monitor.id, { onDelete: "set null" }),
    /** The project the incident belongs to; it keeps it when its monitor is deleted. */
    projectId: projectRef(),
    /** Sequential number inside the project (INC-12). */
    number: int("number"),
    title: str("title").notNull(),
    status: incidentStatus("status").notNull().default("investigating"),
    severity: incidentSeverity("severity").notNull().default("major"),
    auto: boolean("auto").notNull().default(false),
    assigneeId: varchar("assignee_id", { length: 64 }).references(() => user.id, { onDelete: "set null" }),
    startedAt: tsNow("started_at"),
    acknowledgedAt: ts("acknowledged_at"),
    resolvedAt: ts("resolved_at"),
    /** short human-readable reason an automatic incident opened or was reopened ("3 of 3 regions failed") */
    evaluationNote: text("evaluation_note"),
    /** When the next repeat alert is due; null once acknowledged, resolved, capped or when repeats are off. */
    nextReminderAt: ts("next_reminder_at"),
    reminderCount: int("reminder_count").notNull().default(0),
    /** How many escalation steps have fired, and when the next one is due (null = none left). */
    escalationLevel: int("escalation_level").notNull().default(0),
    nextEscalationAt: ts("next_escalation_at"),
    /** Short cause, written once it is known. Public once the incident is resolved and the write-up is published. */
    rootCause: text("root_cause"),
    /** Longer write-up (markdown or plain text). Public once the incident is resolved and the write-up is published. */
    postmortem: text("postmortem"),
    /** When a person chose to show the root cause and postmortem on the status page; null keeps them private. */
    postmortemPublishedAt: ts("postmortem_published_at"),
  },
  (t) => [
    index("incident_org_idx").on(t.organizationId, t.startedAt),
    // the flap, reopen and "handled by a person" lookups all start from one monitor's recent incidents
    index("incident_monitor_idx").on(t.monitorId, t.startedAt),
    uniqueIndex("incident_project_number_idx").on(t.projectId, t.number),
  ],
);

export const incidentUpdate = mysqlTable(
  "incident_update",
  {
    id: uuidPk(),
    incidentId: uuidRef("incident_id").notNull().references(() => incident.id, { onDelete: "cascade" }),
    status: incidentStatus("status").notNull(),
    body: text("body").notNull(),
    /** "internal" updates are visible to the team only: never on status pages, feeds or subscriber emails. */
    visibility: incidentUpdateVisibility("visibility").notNull().default("public"),
    authorId: varchar("author_id", { length: 64 }).references(() => user.id, { onDelete: "set null" }),
    /** Written by a person (session, API key or agent), as opposed to the checks. Survives the author's account being deleted. */
    byPerson: boolean("by_person").notNull().default(false),
    createdAt: tsNow("created_at"),
  },
  (t) => [index("incident_update_incident_idx").on(t.incidentId, t.createdAt)],
);

export const alertChannel = mysqlTable("alert_channel", {
  id: uuidPk(),
  organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: projectRef(),
  type: channelType("type").notNull(),
  name: str("name").notNull(),
  config: json("config").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  /** New monitors (of the channel's project, or of every project for a workspace-wide channel) start out alerting this channel. */
  autoEnable: boolean("auto_enable").notNull().default(false),
  createdAt: tsNow("created_at"),
});

/** A phone registered for push alerts. Belongs to a user, not to a channel: a `push` channel reaches every member's devices. */
export const pushDevice = mysqlTable(
  "push_device",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 64 }).notNull().references(() => user.id, { onDelete: "cascade" }),
    /** the APNs device token (hex); one device is one row, whoever registered it last owns it */
    token: str("token").notNull(),
    platform: str("platform", 32).notNull().default("ios"),
    /** sandbox | production: which APNs host the token belongs to */
    environment: str("environment", 32).notNull().default("production"),
    locale: varchar("locale", { length: 16 }),
    name: varchar("name", { length: 255 }),
    /** opted in to critical alerts: a "down" push may break through Do Not Disturb */
    critical: boolean("critical").notNull().default(false),
    createdAt: tsNow("created_at"),
    lastSeenAt: tsNow("last_seen_at"),
  },
  (t) => [uniqueIndex("push_device_token_idx").on(t.token), index("push_device_user_idx").on(t.userId)],
);

/** One row per attempt to notify a channel (or the subscribers of a status page), kept for the workspace's retention window. */
export const alertDelivery = mysqlTable(
  "alert_delivery",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    /** no foreign key: the log outlives a removed channel, so the name and type are snapshotted */
    channelId: uuidRef("channel_id"),
    channelName: str("channel_name").notNull(),
    channelType: str("channel_type", 32).notNull(),
    /** incident.opened | incident.resolved | test | subscribers */
    kind: str("kind", 64).notNull(),
    incidentId: uuidRef("incident_id"),
    monitorName: str("monitor_name"),
    ok: boolean("ok").notNull(),
    error: text("error"),
    /** pending | sending | sent | failed | skipped; null on rows written before delivery states existed */
    status: str("status", 16).$type<"pending" | "sending" | "sent" | "failed" | "skipped">(),
    /** human reason shown next to the status, e.g. "failed: HTTP 500" or "skipped: channel disabled" */
    statusMessage: text("status_message"),
    /** set when a worker took the row (pending -> sending); a row stuck in sending is handed back after a few minutes */
    claimedAt: ts("claimed_at"),
    emailQuotaAttempted: boolean("email_quota_attempted").notNull().default(false),
    /** set when the incident was acknowledged after this alert went out */
    acknowledgedAt: ts("acknowledged_at"),
    attempts: int("attempts").notNull().default(1),
    /** set while a failed incident alert is waiting for another attempt */
    nextAttemptAt: ts("next_attempt_at"),
    createdAt: tsNow("created_at"),
  },
  (t) => [index("alert_delivery_org_time_idx").on(t.organizationId, t.createdAt), index("alert_delivery_retry_idx").on(t.nextAttemptAt), index("alert_delivery_status_idx").on(t.status, t.claimedAt), index("alert_delivery_incident_idx").on(t.incidentId)],
);

/** Persistent recipient-specific MCP notifications, committed with the incident transition. */
export const mcpAlertOutbox = mysqlTable("mcp_alert_outbox", {
  id: uuidPk(),
  sequence: bigint("sequence", { mode: "number", unsigned: true }).autoincrement().notNull(),
  eventKey: str("event_key", 128).notNull(),
  organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  monitorId: uuidRef("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
  deliveryId: uuidRef("delivery_id").notNull().references(() => alertDelivery.id, { onDelete: "cascade" }),
  recipient: str("recipient", 512).notNull(),
  channelId: uuidRef("channel_id"),
  event: json("event").$type<McpAlertEvent>().notNull(),
  status: str("status", 16).$type<"pending" | "leased" | "sent" | "skipped" | "failed">().notNull().default("pending"),
  attempts: int("attempts").notNull().default(0),
  quotaAttempted: boolean("quota_attempted").notNull().default(false),
  quotaDecision: str("quota_decision", 16).$type<"granted" | "denied">(),
  leaseToken: uuid("lease_token"),
  leaseUntil: ts("lease_until"),
  nextAttemptAt: tsNow("next_attempt_at"),
  error: text("error"),
  createdAt: tsNow("created_at"),
}, t => [uniqueIndex("mcp_alert_outbox_sequence_idx").on(t.sequence), uniqueIndex("mcp_alert_outbox_event_recipient_idx").on(t.eventKey, t.recipient), index("mcp_alert_outbox_due_idx").on(t.status, t.nextAttemptAt), index("mcp_alert_outbox_order_idx").on(t.monitorId, t.recipient, t.sequence)]);

/** Per-workspace preferences; a missing row means defaults. */
export const workspaceSetting = mysqlTable("workspace_setting", {
  organizationId: orgRef("organization_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  alertLogRetentionDays: int("alert_log_retention_days").notNull().default(30),
  /** raw check results older than this are deleted (hourly rollups are kept for a year regardless) */
  checkRetentionDays: int("check_retention_days").notNull().default(90),
  /** opt-in: email the owners a summary of the previous month on the first days of each month */
  monthlyReport: boolean("monthly_report").notNull().default(false),
  /** the month (YYYY-MM) a report was last claimed for, so each month is sent once */
  lastReportMonth: varchar("last_report_month", { length: 16 }),
});

/** While a window is active, monitors it covers keep being checked but open no incidents and send no alerts. */
export const maintenanceWindow = mysqlTable(
  "maintenance_window",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    name: str("name").notNull(),
    seriesId: uuid("series_id"),
    recurrence: json("recurrence").$type<import("@openuptime/repo").MaintenanceRecurrence>(),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    /** empty = all monitors in the org */
    monitorIds: json("monitor_ids").$type<string[]>().notNull().default([]),
    createdAt: tsNow("created_at"),
  },
  (t) => [index("maintenance_org_idx").on(t.organizationId, t.startsAt), index("maintenance_series_idx").on(t.organizationId, t.seriesId)],
);

export const statusPage = mysqlTable(
  "status_page",
  {
    id: uuidPk(),
    organizationId: orgRef("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    projectId: projectRef(),
    slug: str("slug").notNull(),
    title: str("title").notNull(),
    customDomain: str("custom_domain"),
    theme: str("theme", 16).notNull().default("light"),
    showLatency: boolean("show_latency").notNull().default(true),
    externalUrl: str("external_url", 512),
    hideBranding: boolean("hide_branding").notNull().default(false),
    /** uptime bars are green at or above this percentage, amber at or above `uptimeWarnPct`, red below */
    uptimeOkPct: double("uptime_ok_pct").notNull().default(99.9),
    uptimeWarnPct: double("uptime_warn_pct").notNull().default(98),
    /** whether the public MCP tools may serve this page */
    mcpEnabled: boolean("mcp_enabled").notNull().default(true),
    /** subscribers get a reminder this many hours before maintenance starts; 0 turns it off */
    maintenanceReminderHours: int("maintenance_reminder_hours").notNull().default(24),
    /** the owner's stylesheet for the public page, checked on save so it cannot load anything or leave its <style> */
    customCss: text("custom_css"),
    createdAt: tsNow("created_at"),
  },
  (t) => [uniqueIndex("status_page_slug_idx").on(t.slug)],
);

/** Fixed-window counters for public endpoints; shared across processes via MySQL. */
export const rateLimit = mysqlTable("rate_limit", {
  key: str("key", 512).primaryKey(),
  windowStart: tsNow("window_start"),
  count: int("count").notNull().default(0),
});

export const statusSubscriber = mysqlTable(
  "status_subscriber",
  {
    id: uuidPk(),
    statusPageId: uuidRef("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
    email: str("email").notNull(),
    /** doubles as the confirm and unsubscribe secret */
    token: str("token").notNull(),
    confirmedAt: ts("confirmed_at"),
    /** language of the subscribe request, used for the emails they get */
    locale: varchar("locale", { length: 16 }),
    /** components (monitors) the subscriber wants mail about; empty = all of the page */
    monitorIds: json("monitor_ids").$type<string[]>().notNull().default([]),
    createdAt: tsNow("created_at"),
  },
  (t) => [uniqueIndex("status_subscriber_page_email_idx").on(t.statusPageId, t.email), uniqueIndex("status_subscriber_token_idx").on(t.token)],
);

/** One row per maintenance window and status page whose subscribers were reminded; inserting it first is the claim. */
export const maintenanceReminder = mysqlTable(
  "maintenance_reminder",
  {
    maintenanceId: uuidRef("maintenance_id").notNull().references(() => maintenanceWindow.id, { onDelete: "cascade" }),
    statusPageId: uuidRef("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
    sentAt: tsNow("sent_at"),
  },
  (t) => [primaryKey({ columns: [t.maintenanceId, t.statusPageId] })],
);

export const statusPageComponent = mysqlTable("status_page_component", {
  id: uuidPk(),
  statusPageId: uuidRef("status_page_id").notNull().references(() => statusPage.id, { onDelete: "cascade" }),
  monitorId: uuidRef("monitor_id").notNull().references(() => monitor.id, { onDelete: "cascade" }),
  groupName: str("group_name").notNull().default("Services"),
  position: int("position").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
});

export const monitorRelations = relations(monitor, ({ many }) => ({
  results: many(checkResult),
  incidents: many(incident),
}));
export const checkResultRelations = relations(checkResult, ({ one }) => ({
  monitor: one(monitor, { fields: [checkResult.monitorId], references: [monitor.id] }),
}));
export const incidentRelations = relations(incident, ({ one, many }) => ({
  monitor: one(monitor, { fields: [incident.monitorId], references: [monitor.id] }),
  updates: many(incidentUpdate),
}));
export const incidentUpdateRelations = relations(incidentUpdate, ({ one }) => ({
  incident: one(incident, { fields: [incidentUpdate.incidentId], references: [incident.id] }),
}));
export const statusPageRelations = relations(statusPage, ({ many }) => ({ components: many(statusPageComponent) }));
export const statusPageComponentRelations = relations(statusPageComponent, ({ one }) => ({
  page: one(statusPage, { fields: [statusPageComponent.statusPageId], references: [statusPage.id] }),
  monitor: one(monitor, { fields: [statusPageComponent.monitorId], references: [monitor.id] }),
}));