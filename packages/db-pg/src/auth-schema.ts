import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  int,
  json,
  mysqlTable,
  text,
  datetime,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** Milliseconds-precision UTC timestamp; MySQL stores it in the session time zone, which the driver pins to UTC. */
const ts = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const tsNow = (name: string) => ts(name).notNull().default(sql`CURRENT_TIMESTAMP(3)`);

const id = (name = "id") => varchar(name, { length: 64 });

export const user = mysqlTable("user", {
  id: id().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  /** preferred language for emails ("en" | "zh-CN"); null until the user picks or the app first loads */
  locale: varchar("locale", { length: 16 }),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at").$onUpdate(() => /* @__PURE__ */ new Date()),
});

export const session = mysqlTable(
  "session",
  {
    id: id().primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: varchar("token", { length: 255 }).notNull().unique(),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at").$onUpdate(() => /* @__PURE__ */ new Date()),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    userId: id("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: id("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = mysqlTable(
  "account",
  {
    id: id().primaryKey(),
    accountId: varchar("account_id", { length: 255 }).notNull(),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    userId: id("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at").$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = mysqlTable(
  "verification",
  {
    id: id().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at").$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = mysqlTable(
  "organization",
  {
    id: id().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    logo: text("logo"),
    createdAt: ts("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
);

export const member = mysqlTable(
  "member",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: id("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 64 }).default("member").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = mysqlTable(
  "invitation",
  {
    id: id().primaryKey(),
    organizationId: id("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 64 }),
    status: varchar("status", { length: 32 }).default("pending").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: tsNow("created_at"),
    inviterId: id("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const apikey = mysqlTable(
  "apikey",
  {
    id: id().primaryKey(),
    configId: varchar("config_id", { length: 255 }).default("default").notNull(),
    name: varchar("name", { length: 255 }),
    start: varchar("start", { length: 64 }),
    referenceId: varchar("reference_id", { length: 255 }).notNull(),
    prefix: varchar("prefix", { length: 64 }),
    key: varchar("key", { length: 255 }).notNull(),
    refillInterval: int("refill_interval"),
    refillAmount: int("refill_amount"),
    lastRefillAt: ts("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: int("rate_limit_time_window").default(86400000),
    rateLimitMax: int("rate_limit_max").default(10),
    requestCount: int("request_count").default(0),
    remaining: int("remaining"),
    lastRequest: ts("last_request"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_configId_idx").on(table.configId),
    index("apikey_referenceId_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

export const twoFactor = mysqlTable(
  "two_factor",
  {
    id: id().primaryKey(),
    secret: varchar("secret", { length: 255 }).notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: id("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: int("failed_verification_count").default(0),
    lockedUntil: ts("locked_until"),
  },
  (table) => [index("twoFactor_secret_idx").on(table.secret), index("twoFactor_userId_idx").on(table.userId)],
);

/* ---- OAuth 2.1 authorization server (agents / MCP clients) ---- */

export const jwks = mysqlTable("jwks", {
  id: id().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at"),
  alg: varchar("alg", { length: 32 }),
  crv: varchar("crv", { length: 32 }),
});

export const oauthClient = mysqlTable(
  "oauth_client",
  {
    id: id().primaryKey(),
    clientId: varchar("client_id", { length: 255 }).notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: varchar("client_discovery_id", { length: 255 }),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: varchar("subject_type", { length: 64 }),
    scopes: json("scopes").$type<string[]>(),
    clientCredentialsScopes: json("client_credentials_scopes").$type<string[]>(),
    userId: id("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    name: varchar("name", { length: 255 }),
    uri: text("uri"),
    icon: text("icon"),
    contacts: json("contacts").$type<string[]>(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: varchar("software_id", { length: 255 }),
    softwareVersion: varchar("software_version", { length: 64 }),
    softwareStatement: text("software_statement"),
    redirectUris: json("redirect_uris").$type<string[]>().notNull(),
    postLogoutRedirectUris: json("post_logout_redirect_uris").$type<string[]>(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", { length: 64 }),
    applicationType: varchar("application_type", { length: 64 }),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: json("grant_types").$type<string[]>(),
    responseTypes: json("response_types").$type<string[]>(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens"),
    referenceId: varchar("reference_id", { length: 255 }),
    metadata: json("metadata"),
  },
  (t) => [index("oauth_client_user_idx").on(t.userId)],
);

export const oauthResource = mysqlTable("oauth_resource", {
  id: id().primaryKey(),
  identifier: varchar("identifier", { length: 512 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  accessTokenTtl: int("access_token_ttl"),
  refreshTokenTtl: int("refresh_token_ttl"),
  signingAlgorithm: varchar("signing_algorithm", { length: 32 }),
  signingKeyId: varchar("signing_key_id", { length: 255 }),
  allowedScopes: json("allowed_scopes").$type<string[]>(),
  customClaims: json("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required"),
  disabled: boolean("disabled").default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
  policyVersion: int("policy_version"),
  metadata: json("metadata"),
});

export const oauthClientResource = mysqlTable("oauth_client_resource", {
  id: id().primaryKey(),
  clientId: varchar("client_id", { length: 255 })
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: id("resource_id")
    .notNull()
    .references(() => oauthResource.id, { onDelete: "cascade" }),
  metadata: json("metadata"),
  createdAt: ts("created_at"),
});

export const oauthRefreshToken = mysqlTable(
  "oauth_refresh_token",
  {
    id: id().primaryKey(),
    token: text("token").notNull(),
    clientId: varchar("client_id", { length: 255 })
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: id("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: id("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: varchar("reference_id", { length: 255 }),
    authorizationCodeId: varchar("authorization_code_id", { length: 255 }),
    resources: json("resources").$type<string[]>(),
    requestedUserInfoClaims: json("requested_user_info_claims").$type<string[]>(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    revoked: ts("revoked"),
    rotatedAt: ts("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: ts("rotation_replay_expires_at"),
    authTime: ts("auth_time"),
    confirmation: json("confirmation"),
    scopes: json("scopes").$type<string[]>().notNull(),
  },
  (t) => [index("oauth_refresh_token_user_idx").on(t.userId)],
);

export const oauthAccessToken = mysqlTable(
  "oauth_access_token",
  {
    id: id().primaryKey(),
    token: text("token").notNull(),
    clientId: varchar("client_id", { length: 255 })
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: id("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: id("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: varchar("reference_id", { length: 255 }),
    authorizationCodeId: varchar("authorization_code_id", { length: 255 }),
    resources: json("resources").$type<string[]>(),
    requestedUserInfoClaims: json("requested_user_info_claims").$type<string[]>(),
    refreshId: id("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    revoked: ts("revoked"),
    confirmation: json("confirmation"),
    scopes: json("scopes").$type<string[]>().notNull(),
  },
  (t) => [index("oauth_access_token_user_idx").on(t.userId)],
);

export const oauthConsent = mysqlTable(
  "oauth_consent",
  {
    id: id().primaryKey(),
    clientId: varchar("client_id", { length: 255 })
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: id("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: varchar("reference_id", { length: 255 }),
    resources: json("resources").$type<string[]>(),
    requestedUserInfoClaims: json("requested_user_info_claims").$type<string[]>(),
    scopes: json("scopes").$type<string[]>().notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("oauth_consent_user_idx").on(t.userId)],
);

export const oauthClientAssertion = mysqlTable("oauth_client_assertion", {
  id: id().primaryKey(),
  expiresAt: ts("expires_at").notNull(),
});