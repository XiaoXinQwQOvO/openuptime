import {
  DEFAULT_ALERT_LOG_DAYS,
  PUSH_DEVICE_STALE_DAYS,
  DEFAULT_CHECK_RETENTION_DAYS,
  MAX_REMINDERS,
  ROLLUP_RETENTION_DAYS,
  type AlertDelivery,
  type DeliveryRetry,
  type EscalationDue,
  type ReminderDue,
  type IncidentWithUpdates,
  type PushDevice,
  type Repo,
  type ImportResult,
  type Scope,
  type McpAlertTask,
  type McpCheckHistory,
  type McpHistory,
  type McpObservation,
  type MaintenanceRecurrence,
} from "@openuptime/repo";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbExecutor } from "./client";
import * as schema from "./schema";
import { coverageTime, recordHeartbeatObservation, recordObservation, timeCoverage } from "./coverage";
import { publicMonitorStatus } from "./public-monitor-status";
import { mcpSchemaHash, completeMcpDiscovery, comparableMcpConfig, mcpTaskId } from "./mcp-data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `col in (scope)` for a limited API key, nothing otherwise; spread into `and(...)`. */
const inScope = (scope: Scope, col: Parameters<typeof inArray>[0]): SQL | undefined => (scope ? inArray(col, scope) : undefined);

/** True when the last "resolved" update of the incident was written by a person (not by the checks); survives the account being deleted. */
const resolvedByPerson = (incidentId: Parameters<typeof inArray>[0]): SQL =>
  sql`coalesce((select u.by_person from incident_update u where u.incident_id = ${incidentId} and u.status = 'resolved' order by u.created_at desc limit 1), 0)`;

/**
 * An alert_delivery row whose sending belongs to the MCP outbox. The generic sweep and retry worker must leave it alone,
 * or they resend through the old path. Outbox tasks share their delivery row's id (enqueueMcpAlerts), so this is a key lookup.
 */
const notMcpOutbox = sql`not exists (select 1 from mcp_alert_outbox q where q.id = ${schema.alertDelivery.id})`;

/** Seconds into its interval at which a monitor is checked: stable per monitor, spread evenly across monitors. */
const phaseSec = sql`mod(conv(substr(md5(${schema.monitor.id}), 1, 8), 16, 10), ${schema.monitor.intervalSec})`;

/** `now()` is the UTC session clock (the pool sets time_zone +00:00); `(3)` keeps milliseconds like the old timestamps. */
const now = sql`now(3)`;

/** mysql2 returns `[rows, fields]` from `execute`; DML returns `[ResultSetHeader, fields]`. */
const rawRows = (r: unknown): unknown[] => (Array.isArray(r) && Array.isArray((r as unknown[])[0]) ? ((r as unknown[])[0] as unknown[]) : (r as unknown[]));
const affected = (r: unknown): number => {
  const head = Array.isArray(r) && !Array.isArray((r as unknown[])[0]) ? (r as unknown[])[0] : r;
  return Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
};

/** MySQL has no RETURNING: the id is chosen here, or the row is read back inside the same transaction. */
const newId = () => crypto.randomUUID();

/** Postgres implementation of the storage contract, on drizzle + postgres.js. */
export function createRepo(db: DbExecutor): Repo {
  const rows = async <T>(q: PromiseLike<unknown>) => rawRows(await q) as T[];

  async function ensureDefaultProject(orgId: string) {
    return db.transaction(async (tx) => {
      // serialise first-use creation so parallel first requests end up with exactly one project
      await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, orgId)).for("update");
      const [first] = await tx.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, orgId)).orderBy(asc(schema.project.createdAt)).limit(1);
      if (first) return first.id;
      const created = { id: newId(), organizationId: orgId, name: "Default", createdAt: new Date(), reminderIntervalMin: null, reminderEmail: false, escalation: [], incidentSeq: 0 };
      await tx.insert(schema.project).values(created);
      return created.id;
    });
  }

  async function pageMonitorIds(pageId: string) {
    const r = await db
      .select({ id: schema.statusPageComponent.monitorId })
      .from(schema.statusPageComponent)
      .where(and(eq(schema.statusPageComponent.statusPageId, pageId), eq(schema.statusPageComponent.visible, true)));
    return r.map((x) => x.id);
  }

  /** The project a page belongs to; a page without one falls back to the workspace's oldest project, as incident numbering does. */
  async function pageProjectId(page: { organizationId: string; projectId: string | null }) {
    if (page.projectId) return page.projectId;
    const [p] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, page.organizationId)).orderBy(asc(schema.project.createdAt), asc(schema.project.id)).limit(1);
    return p?.id ?? null;
  }

  /** Incidents shown on a page: those of its own monitors, plus manual ones (no monitor) of the page's own project. */
  function pageScope(orgId: string, projectId: string | null, monitorIds: string[] | SQLWrapper) {
    // declared by hand for the whole project; an automatic incident whose monitor was deleted is not one
    const manual = and(isNull(schema.incident.monitorId), eq(schema.incident.auto, false), projectId ? eq(schema.incident.projectId, projectId) : isNull(schema.incident.projectId));
    const own = Array.isArray(monitorIds) ? (monitorIds.length ? inArray(schema.incident.monitorId, monitorIds) : undefined) : inArray(schema.incident.monitorId, monitorIds);
    return and(eq(schema.incident.organizationId, orgId), own ? or(manual, own) : manual);
  }

  async function withUpdates(list: (typeof schema.incident.$inferSelect)[]): Promise<IncidentWithUpdates[]> {
    const ids = list.map((i) => i.id);
    const updates = ids.length
      ? await db
          .select()
          .from(schema.incidentUpdate)
          // withUpdates feeds public pages, feeds and subscriber mail only: internal updates never go through here
          .where(and(inArray(schema.incidentUpdate.incidentId, ids), eq(schema.incidentUpdate.visibility, "public")))
          .orderBy(desc(schema.incidentUpdate.createdAt))
      : [];
    return list.map((i) => ({ ...i, updates: updates.filter((u) => u.incidentId === i.id) }));
  }

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /**
   * Hands out the next incident number of the incident's project. The counter row is locked and bumped inside the
   * caller's transaction, so concurrent creators queue on the row lock and never see the same number.
   */
  async function allocateNumber(tx: Tx, inc: { organizationId: string; monitorId?: string | null; projectId?: string | null }) {
    let projectId = inc.projectId ?? null;
    if (inc.monitorId) {
      const [m] = await tx.select({ projectId: schema.monitor.projectId }).from(schema.monitor).where(eq(schema.monitor.id, inc.monitorId));
      projectId = m?.projectId ?? projectId;
    }
    if (!projectId) {
      const [p] = await tx.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, inc.organizationId)).orderBy(asc(schema.project.createdAt), asc(schema.project.id)).limit(1);
      projectId = p?.id ?? null;
    }
    if (!projectId) return { projectId: null, number: null };
    const [p] = await tx
      .select({ n: schema.project.incidentSeq })
      .from(schema.project)
      .where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, inc.organizationId)))
      .for("update");
    if (!p) return { projectId: null, number: null };
    const number = p.n + 1;
    await tx.update(schema.project).set({ incidentSeq: number }).where(eq(schema.project.id, projectId));
    return { projectId, number };
  }

  /** Count one run in the monitor's hourly rollup. */
  async function foldIntoRollup(exec: DbExecutor, monitorId: string, ok: boolean, latencyMs: number | null) {
    const bucket = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await exec
      .insert(schema.checkRollup)
      .values({
        monitorId,
        bucket,
        total: 1,
        ok: ok ? 1 : 0,
        latencySum: latencyMs ?? 0,
        latencyN: latencyMs == null ? 0 : 1,
      })
      .onDuplicateKeyUpdate({
        set: {
          total: sql`${schema.checkRollup.total} + 1`,
          ok: sql`${schema.checkRollup.ok} + ${ok ? 1 : 0}`,
          latencySum: sql`${schema.checkRollup.latencySum} + ${latencyMs ?? 0}`,
          latencyN: sql`${schema.checkRollup.latencyN} + ${latencyMs == null ? 0 : 1}`,
        },
      });
  }

  /** One registry lookup per key per process: concurrent checks share the fill instead of racing the registry. */
  const rdapInflight = new Map<string, Promise<{ value: unknown; expiresAt: Date }>>();

  const repo: Repo = {
    // ── workspaces, users, projects ────────────────────────────────────────────
    async isMember(userId, orgId) {
      const [ok] = await db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)))
        .limit(1);
      return !!ok;
    },
    async hasPendingInvitation(email) {
      const [row] = await db
        .select({ id: schema.invitation.id })
        .from(schema.invitation)
        .where(and(sql`lower(${schema.invitation.email}) = ${email.trim().toLowerCase()}`, eq(schema.invitation.status, "pending"), gte(schema.invitation.expiresAt, new Date())))
        .limit(1);
      return !!row;
    },
    async memberRole(userId, orgId) {
      const [m] = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)))
        .limit(1);
      return m?.role ?? null;
    },
    async anyWorkspaceOf(userId) {
      // Deterministic fallback: a sign-up session may be created before the personal workspace exists, so the
      // session has no active organization yet. The oldest membership (the personal workspace) is the stable default;
      // without an ORDER BY MySQL could pick any membership the caller later joined.
      const [m] = await db.select({ id: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, userId))
        .orderBy(asc(schema.member.createdAt), asc(schema.member.organizationId)).limit(1);
      return m?.id ?? null;
    },
    async hasOAuthConsent(userId, clientId) {
      const [row] = await db
        .select({ id: schema.oauthConsent.id })
        .from(schema.oauthConsent)
        .where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)))
        .limit(1);
      return !!row;
    },
    async ensureOAuthResource(identifier, name, scopes) {
      const now = new Date();
      await db
        .insert(schema.oauthResource)
        .values({ id: newId(), identifier, name, allowedScopes: scopes, createdAt: now, updatedAt: now })
        .onDuplicateKeyUpdate({ set: { allowedScopes: scopes, updatedAt: now } });
    },
    async workspacesOf(userId) {
      return db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(eq(schema.member.userId, userId));
    },
    async organization(orgId) {
      const [o] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
      return o ?? null;
    },
    async userProfile(userId) {
      const [u] = await db
        .select({ name: schema.user.name, email: schema.user.email, locale: schema.user.locale, emailVerified: schema.user.emailVerified, twoFactorEnabled: schema.user.twoFactorEnabled })
        .from(schema.user)
        .where(eq(schema.user.id, userId));
      return u ?? null;
    },
    async setUserLocale(userId, locale) {
      await db.update(schema.user).set({ locale }).where(eq(schema.user.id, userId));
    },
    async localeByEmail(email) {
      const [u] = await db.select({ locale: schema.user.locale }).from(schema.user).where(eq(schema.user.email, email.toLowerCase())).limit(1);
      return u?.locale ?? null;
    },
    async ownerLocale(orgId) {
      const [r] = await db
        .select({ locale: schema.user.locale })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")))
        .limit(1);
      return r?.locale ?? null;
    },
    async exportAccount(uid) {
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, uid));
      const memberships = await db
        .select({ organizationId: schema.member.organizationId, role: schema.member.role, joinedAt: schema.member.createdAt, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(eq(schema.member.userId, uid));
      const admin = memberships.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.organizationId);
      const q = <T>(s: SQL) => rows<T>(db.execute(s));
      const workspaces: unknown[] = [];
      for (const m of memberships) {
        const base = { id: m.organizationId, name: m.name, role: m.role, joinedAt: m.joinedAt };
        if (!admin.includes(m.organizationId)) { workspaces.push(base); continue; }
        const id = m.organizationId;
        workspaces.push({
          ...base,
          projects: await q(sql`select id, name, created_at from project where organization_id = ${id}`),
          monitors: await q(sql`select id, project_id, name, type, target, method, expected_status, interval_sec, timeout_ms, failure_threshold, keyword, keyword_mode, expected_location, headers, request_body, ws_message, tags, slow_threshold_ms, slow_alert_after, created_at from monitor where organization_id = ${id}`),
          channels: await q(sql`select id, project_id, name, type, config, enabled, created_at from alert_channel where organization_id = ${id}`),
          incidents: await q(sql`select id, monitor_id, title, status, severity, auto, started_at, resolved_at from incident where organization_id = ${id}`),
          statusPages: await q(sql`select id, project_id, slug, title, theme, created_at from status_page where organization_id = ${id}`),
          maintenanceWindows: await q(sql`select id, name, starts_at, ends_at from maintenance_window where organization_id = ${id}`),
          members: await q(sql`select u.name, u.email, m.role, m.created_at from member m join \`user\` u on u.id = m.user_id where m.organization_id = ${id}`),
        });
      }
      const sessions = await q(sql`select ip_address, user_agent, created_at, expires_at from session where user_id = ${uid}`);
      return {
        user: u ? { id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, locale: u.locale, twoFactorEnabled: u.twoFactorEnabled, createdAt: u.createdAt } : null,
        sessions,
        workspaces,
      };
    },
    async counts(o, p) {
      const r = await rows<Record<string, number>>(db.execute(sql`select
        (select count(*) from monitor where organization_id = ${o} and project_id = ${p}) as monitors,
        (select count(*) from incident i left join monitor m on m.id = i.monitor_id
           where i.organization_id = ${o} and i.status <> 'resolved' and (m.project_id = ${p} or i.monitor_id is null)) as incidents,
        (select count(*) from status_page where organization_id = ${o} and project_id = ${p}) as \`status-pages\`,
        (select count(*) from alert_channel where organization_id = ${o} and (project_id = ${p} or project_id is null)) as alerting`));
      return r[0] as never;
    },

    async cachedRdap(key, load, refreshAheadMs = 0) {
      // A short read-through cache. One fill per key runs at a time; concurrent callers wait for it and read the
      // stored snapshot, so a burst of checks does not query the registry eight times.
      const [hit] = await db.select().from(schema.rdapCache).where(eq(schema.rdapCache.key, key));
      if (hit && hit.expiresAt.getTime() > Date.now() + ((hit.value as { error?: unknown })?.error ? 0 : refreshAheadMs)) return hit;
      const running = rdapInflight.get(key);
      if (running) {
        await running.catch(() => undefined);
        const [again] = await db.select().from(schema.rdapCache).where(eq(schema.rdapCache.key, key));
        if (again) return again;
      }
      const fill = (async () => {
        const fresh = await load();
        await db.insert(schema.rdapCache).values({ key, ...fresh }).onDuplicateKeyUpdate({ set: fresh });
        return fresh;
      })();
      rdapInflight.set(key, fill);
      try {
        return await fill;
      } finally {
        rdapInflight.delete(key);
      }
    },
    async activeMonitorCount(o) {
      const r = await rows<{ n: number }>(db.execute(sql`select count(*) as n from monitor where organization_id = ${o} and status <> 'paused'`));
      return Number(r[0]?.n ?? 0);
    },

    async ownedWorkspaces(userId) {
      const owned = await db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
        .where(and(eq(schema.member.userId, userId), eq(schema.member.role, "owner")));
      const out = [];
      for (const o of owned) {
        const [n] = await db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, o.id));
        out.push({ ...o, members: n.n });
      }
      return out;
    },
    async deleteWorkspaces(ids) {
      for (const id of ids) await db.delete(schema.organization).where(eq(schema.organization.id, id));
    },
    async createPersonalWorkspace(w) {
      await db.insert(schema.organization).values({ id: w.id, name: w.name, slug: w.slug, createdAt: new Date() });
      await db.insert(schema.member).values({ id: newId(), organizationId: w.id, userId: w.ownerId, role: "owner", createdAt: new Date() });
      await ensureDefaultProject(w.id);
    },
    async preferredWorkspace(userId) {
      const mine = await db
        .select({ organizationId: schema.member.organizationId })
        .from(schema.member)
        .where(eq(schema.member.userId, userId))
        .orderBy(desc(schema.member.createdAt));
      const [last] = await db
        .select({ organizationId: schema.session.activeOrganizationId })
        .from(schema.session)
        .where(eq(schema.session.userId, userId))
        .orderBy(desc(schema.session.createdAt))
        .limit(1);
      return (mine.find((x) => x.organizationId === last?.organizationId) ?? mine[0])?.organizationId ?? null;
    },

    listProjects: (orgId, scope) =>
      db
        .select({ id: schema.project.id, name: schema.project.name, createdAt: schema.project.createdAt })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, orgId), inScope(scope, schema.project.id)))
        .orderBy(asc(schema.project.createdAt)),
    async countProjects(orgId) {
      const [n] = await db.select({ n: count() }).from(schema.project).where(eq(schema.project.organizationId, orgId));
      return n.n;
    },
    async projectOverview(orgId, scope) {
      const list = await db
        .select({ id: schema.project.id, name: schema.project.name })
        .from(schema.project)
        .where(and(eq(schema.project.organizationId, orgId), inScope(scope, schema.project.id)))
        .orderBy(asc(schema.project.createdAt));
      if (!list.length) return [];
      const ids = sql.join(list.map((p) => sql`${p.id}`), sql`, `);
      const [mon, inc] = await Promise.all([
        rows<{ project_id: string; monitors: number; down: number }>(
          db.execute(sql`select project_id, count(*) as monitors, sum(status = 'down') as down
            from monitor where organization_id = ${orgId} and project_id in (${ids}) group by project_id`),
        ),
        // an incident belongs to the project that numbered it; one without falls back to its monitor's project
        rows<{ project_id: string; n: number }>(
          db.execute(sql`select coalesce(i.project_id, m.project_id) as project_id, count(*) as n
            from incident i left join monitor m on m.id = i.monitor_id
            where i.organization_id = ${orgId} and i.status <> 'resolved' and coalesce(i.project_id, m.project_id) in (${ids}) group by 1`),
        ),
      ]);
      return list.map((p) => {
        const m = mon.find((x) => x.project_id === p.id);
        return { id: p.id, name: p.name, monitors: Number(m?.monitors ?? 0), down: Number(m?.down ?? 0), openIncidents: Number(inc.find((x) => x.project_id === p.id)?.n ?? 0) };
      });
    },
    async createProject(orgId, name) {
      const row: typeof schema.project.$inferSelect = { id: newId(), organizationId: orgId, name, createdAt: new Date(), reminderIntervalMin: null, reminderEmail: false, escalation: [], incidentSeq: 0 };
      await db.insert(schema.project).values(row);
      return row;
    },
    async renameProject(orgId, id, name) {
      const where = and(eq(schema.project.id, id), eq(schema.project.organizationId, orgId));
      await db.update(schema.project).set({ name }).where(where);
      const [row] = await db.select().from(schema.project).where(where);
      return row ?? null;
    },
    async deleteProject(orgId, id) {
      await db.delete(schema.project).where(and(eq(schema.project.id, id), eq(schema.project.organizationId, orgId)));
    },
    async resolveProject(orgId, wanted) {
      if (wanted && UUID.test(wanted)) {
        const [p] = await db
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(and(eq(schema.project.id, wanted), eq(schema.project.organizationId, orgId)));
        if (p) return p.id;
      }
      const [first] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, orgId)).orderBy(asc(schema.project.createdAt)).limit(1);
      return first ? first.id : ensureDefaultProject(orgId);
    },
    ensureDefaultProject,

    // ── monitors ───────────────────────────────────────────────────────────────
    async listMonitors(orgId, projectId) {
      const ids = ([] as string[]).concat(projectId);
      if (!ids.length) return [];
      const since = new Date(Date.now() - 864e5);
      const [list, series] = await Promise.all([
        db
          .select({
            m: schema.monitor,
            total: sql<number>`coalesce(sum(${schema.checkRollup.total}), 0)`,
            okCount: sql<number>`coalesce(sum(${schema.checkRollup.ok}), 0)`,
            avgLatency: sql<number | null>`cast(round(sum(${schema.checkRollup.latencySum}) / nullif(sum(${schema.checkRollup.latencyN}), 0)) as signed)`,
          })
          .from(schema.monitor)
          .leftJoin(schema.checkRollup, and(eq(schema.checkRollup.monitorId, schema.monitor.id), gte(schema.checkRollup.bucket, since)))
          .where(and(eq(schema.monitor.organizationId, orgId), inArray(schema.monitor.projectId, ids)))
          .groupBy(schema.monitor.id)
          .orderBy(schema.monitor.name),
        // last 30 latency samples per monitor, for the list sparkline
        rows<{ monitor_id: string; latency_ms: number | null }>(
          db.execute(sql`
            select monitor_id, latency_ms from (
              select r.monitor_id, r.latency_ms, row_number() over (partition by r.monitor_id order by r.checked_at desc) rn
              from check_result r join monitor m on m.id = r.monitor_id
              where m.organization_id = ${orgId} and m.project_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and r.checked_at >= ${since}
            ) x where rn <= 30 order by monitor_id, rn desc`),
        ),
      ]);
      const spark = new Map<string, (number | null)[]>();
      for (const r of series) (spark.get(r.monitor_id) ?? spark.set(r.monitor_id, []).get(r.monitor_id)!).push(r.latency_ms);
      return list.map(({ m, total, okCount, avgLatency }) => ({
        ...m,
        uptime24h: Number(total) ? Math.round((Number(okCount) / Number(total)) * 10000) / 100 : null,
        avgLatency24h: avgLatency == null ? null : Number(avgLatency),
        spark: spark.get(m.id) ?? [],
      }));
    },
    exportMonitors: (orgId, projectId) =>
      db
        .select()
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.projectId, projectId)))
        .orderBy(schema.monitor.name),
    async getMonitor(orgId, id, scope) {
      const [m] = await db
        .select()
        .from(schema.monitor)
        .where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId)));
      return m ?? null;
    },
    async monitorDetail(monitorId) {
      const day = new Date(Date.now() - 864e5);
      const week = new Date(Date.now() - 7 * 864e5);
      const [results, statRows, p95Rows, incidents, regionRows] = await Promise.all([
        db.select().from(schema.checkResult).where(eq(schema.checkResult.monitorId, monitorId)).orderBy(desc(schema.checkResult.checkedAt)).limit(120),
        // uptime and averages come from the hourly rollup; only the p95 needs the raw rows of the last day
        rows<Record<string, number | null>>(
          db.execute(sql`select
            cast(coalesce(sum(case when bucket >= ${day} then total else 0 end), 0) as signed) as n24,
            cast(coalesce(sum(case when bucket >= ${day} then ok else 0 end), 0) as signed) as ok24,
            cast(coalesce(sum(total), 0) as signed) as n7,
            cast(coalesce(sum(ok), 0) as signed) as ok7,
            cast(round(sum(case when bucket >= ${day} then latency_sum else 0 end) / nullif(sum(case when bucket >= ${day} then latency_n else 0 end), 0)) as signed) as avg24
            from check_rollup where monitor_id = ${monitorId} and bucket >= ${week}`),
        ),
        rows<Record<string, number | null>>(
          db.execute(sql`select cast(round(latency_ms) as signed) as p95 from (
            select latency_ms, percent_rank() over (order by latency_ms) as pr
            from check_result where monitor_id = ${monitorId} and checked_at >= ${day}
          ) ranked where pr >= 0.95 order by pr limit 1`),
        ),
        db.select().from(schema.incident).where(eq(schema.incident.monitorId, monitorId)).orderBy(desc(schema.incident.startedAt)).limit(5),
        rows<{ region: string; n: number; ok_n: number; avg: number | null }>(
          db.execute(sql`select region, count(*) as n, sum(ok) as ok_n,
            cast(round(avg(case when ok then latency_ms end)) as signed) as avg
            from check_result where monitor_id = ${monitorId} and checked_at >= ${day} group by region order by region`),
        ),
      ]);
      const st = { ...(statRows[0] ?? {}), ...(p95Rows[0] ?? {}) };
      const pct = (ok: number | null, n: number | null) => (n ? Math.round(((ok ?? 0) / n) * 10000) / 100 : null);
      return {
        results,
        incidents,
        stats: { uptime24h: pct(st.ok24, st.n24), uptime7d: pct(st.ok7, st.n7), avg24h: st.avg24 ?? null, p95: st.p95 ?? null },
        regionStats: regionRows.map((r) => {
          // `results` is newest first, so the first row of a region is its latest
          const last = results.find((x) => x.region === r.region);
          return {
            region: r.region,
            checks24h: Number(r.n),
            uptime24h: pct(r.ok_n, r.n),
            avgLatency24h: r.avg ?? null,
            last: last ? { ok: last.ok, statusCode: last.statusCode, latencyMs: last.latencyMs, error: last.error, checkedAt: last.checkedAt } : null,
          };
        }),
      };
    },
    async createMonitor(orgId, projectId, input) {
      const id = newId();
      await db.insert(schema.monitor).values({ ...input, id, organizationId: orgId, projectId });
      const [row] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
      return row;
    },
    async createMonitors(orgId, projectId, inputs) {
      if (inputs.length) await db.insert(schema.monitor).values(inputs.map((v) => ({ ...v, id: newId(), organizationId: orgId, projectId })));
    },
    async importMonitors(orgId, projectId, inputs, options) {
      return db.transaction(async (tx) => {
        // A read-only preview never writes or reserves ids. Executions serialize within a workspace;
        // the unique index remains a second safeguard against duplicate source identities.
        if (!options.preview) await tx.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, orgId)).for("update");
        const existing = await tx.select({ id: schema.monitor.id, source: schema.monitor.importSource, sourceId: schema.monitor.importSourceId, name: schema.monitor.name, target: schema.monitor.target })
          .from(schema.monitor).where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.projectId, projectId)));
        const seen = new Map(existing.map((r) => [r.id as string, { name: r.name, target: r.target }]));
        // Normalize legacy rows too, so pre-fix padded identities remain deduplicated.
        const key = (source: string, sourceId: string) => JSON.stringify([source, sourceId.trim()]);
        const known = new Map(existing.map((r) => [key(r.source ?? "openuptime", r.sourceId ?? r.id), r.id as string | null]));
        const results: ImportResult[] = inputs.map((r) => {
          const k = key(r.source, r.sourceId);
          if (known.has(k)) return { source: r.source, sourceId: r.sourceId, status: "duplicate", monitorId: known.get(k)!, existing: seen.get(known.get(k)!) };
          known.set(k, null);
          return { source: r.source, sourceId: r.sourceId, status: "ready", monitorId: null };
        });
        const requested = results.filter((r) => r.status === "ready").length;
        if (options.maxActive !== null) {
          const [{ n }] = await tx.select({ n: count() }).from(schema.monitor).where(and(eq(schema.monitor.organizationId, orgId), sql`${schema.monitor.status} <> 'paused'`));
          if (requested && n + requested > options.maxActive) return { rows: results, limit: { active: n, max: options.maxActive, requested } };
        }
        if (!options.preview && requested) {
          const pending = inputs.flatMap((r, i) => results[i].status === "ready"
            ? [{ ...r.input, id: newId(), organizationId: orgId, projectId, importSource: r.source, importSourceId: r.sourceId }]
            : []);
          await tx.insert(schema.monitor).values(pending).onDuplicateKeyUpdate({ set: { paused: sql`paused` } });
          const current = await tx.select({ id: schema.monitor.id, source: schema.monitor.importSource, sourceId: schema.monitor.importSourceId })
            .from(schema.monitor).where(and(eq(schema.monitor.organizationId, orgId), eq(schema.monitor.projectId, projectId), isNotNull(schema.monitor.importSource)));
          const created = new Map(current.map((r) => [key(r.source!, r.sourceId!), r.id]));
          for (const [k, id] of created) known.set(k, id);
          for (const r of results) {
            const k = key(r.source, r.sourceId);
            if (r.status === "ready") r.status = pending.some((p) => p.importSource === r.source && p.importSourceId === r.sourceId && created.get(k) === p.id) ? "created" : "duplicate";
            r.monitorId = known.get(k) ?? null;
          }
        }
        return { rows: results, limit: null };
      });
    },
    async updateMonitor(orgId, id, scope, patch) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.monitor)
          .where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId))).for("update");
        if (!current) return null;
        // Only actual changes to measurement or freshness invalidate observation coverage.
        const changedPause = patch.paused !== undefined && patch.paused !== current.paused;
        const effective = { ...patch };
        if (patch.mcpConfig && patch.mcpConfig.oauth === undefined) {
          // Retain the locked current token: the form may predate an OAuth refresh rotation.
          effective.mcpConfig = { ...patch.mcpConfig, oauth: current.mcpConfig?.oauth ?? null };
        } else if (patch.mcpConfig?.oauth?.mode === "refresh_token" && !patch.mcpConfig.oauth.refreshToken) {
          // Clients never echo the rotating token back (a copy is stale after the next check): an omitted one means
          // "keep the stored token", read here under the row lock so a concurrent rotation is never overwritten.
          const stored = current.mcpConfig?.oauth;
          const { refreshToken: _omitted, ...oauth } = patch.mcpConfig.oauth;
          effective.mcpConfig = { ...patch.mcpConfig, oauth: stored?.mode === "refresh_token" && stored.refreshToken ? { ...oauth, refreshToken: stored.refreshToken } : oauth };
        }
        if (patch.paused !== undefined && !changedPause) {
          // The route derives these controls from paused; repeating the current value is not a resume.
          delete effective.status;
          delete effective.nextCheckAt;
        }
        const measured = ["paused", "target", "method", "expectedStatus", "intervalSec", "timeoutMs", "graceSec", "slowThresholdMs", "regions", "minRegionsFailing", "keyword", "keywordMode", "expectedLocation", "jsonAssertions", "headers", "wsMessage", "mcpConfig"];
        const comparable = (key: string, value: unknown) => JSON.stringify(
          key === "regions" && Array.isArray(value) ? [...value].sort()
            : key === "mcpConfig" ? comparableMcpConfig(value as import("@openuptime/repo").McpConfig | null | undefined) : value,
          (_name, part) => part && typeof part === "object" && !Array.isArray(part)
            ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part,
        );
        const changed = Object.entries(effective).some(([key, value]) => measured.includes(key)
          && comparable(key, value) !== comparable(key, current[key as keyof typeof current]));
        const resetExpiry = (effective.target !== undefined && effective.target !== current.target) || (effective.domainExpiryWarnDays !== undefined && effective.domainExpiryWarnDays !== current.domainExpiryWarnDays);
        // The baseline is approval of this server's contract, not of a probe's arguments or assertions.
        // Editing a check (including switching schema checks off/on) must not silently approve a changed schema.
        const resetMcpBaseline = current.type === "mcp" && Object.entries(effective).some(([key, value]) => ["target", "headers"].includes(key)
          && comparable(key, value) !== comparable(key, current[key as keyof typeof current]));
        const resetMcpObservation = resetMcpBaseline || (current.type === "mcp" && effective.mcpConfig !== undefined
          && comparable("mcpConfig", effective.mcpConfig) !== comparable("mcpConfig", current.mcpConfig));
        await tx.update(schema.monitor).set({ ...effective, ...(resetMcpBaseline ? { mcpBaseline: null } : {}), ...(resetMcpObservation ? { mcpObservation: null } : {}), ...(resetExpiry ? { domainExpiry: null } : {}), ...(changedPause ? { consecutiveSuccesses: 0 } : {}), ...(changed ? { coverageRevision: current.coverageRevision + 1 } : {}) })
          .where(eq(schema.monitor.id, id));
        const [row] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, id));
        if (changed) {
          const at = await coverageTime(tx, id);
          await tx.insert(schema.monitorObservation).values({
            monitorId: id, observedAt: at,
            state: row.paused ? "paused" : "unknown", revision: row.coverageRevision,
          });
        }
        return row;
      });
    },
    async deleteMonitor(orgId, id, scope) {
      const mine = and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId), inScope(scope, schema.monitor.projectId));
      await db.transaction(async (tx) => {
        // an outage of a monitor that no longer exists can never recover, so it is closed here rather than left open
        const owned = tx.select({ id: schema.monitor.id }).from(schema.monitor).where(mine);
        const closed = await tx.select({ id: schema.incident.id }).from(schema.incident)
          .where(and(inArray(schema.incident.monitorId, owned), isNull(schema.incident.resolvedAt)));
        if (closed.length) {
          await tx.update(schema.incident).set({ status: "resolved", resolvedAt: new Date() })
            .where(inArray(schema.incident.id, closed.map((c) => c.id)));
          // the timeline says why it ended, as it does when checks pass again
          await tx.insert(schema.incidentUpdate).values(closed.map((inc) => ({ incidentId: inc.id, status: "resolved" as const, body: "The monitor was deleted." })));
        }
        await tx.delete(schema.monitor).where(mine);
      });
    },
    async ownedMonitorIds(orgId, ids, scope) {
      if (!ids.length) return [];
      const r = await db
        .select({ id: schema.monitor.id })
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), inArray(schema.monitor.id, ids), inScope(scope, schema.monitor.projectId)));
      return r.map((m) => m.id);
    },
    async monitorByHeartbeatToken(token) {
      const [m] = await db.select().from(schema.monitor).where(eq(schema.monitor.heartbeatToken, token));
      return m ?? null;
    },

    async recordRecoveryProgress(m, ok) {
      // Write only when something changes: a failure clears a non-zero streak, a success counts while the outage lasts.
      // A healthy monitor's checks (nearly all of them) then cost a read instead of a row update.
      const res = await db.update(schema.monitor).set({
        consecutiveSuccesses: ok ? sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})` : 0,
      }).where(and(eq(schema.monitor.id, m.id), eq(schema.monitor.paused, false), ok ? eq(schema.monitor.status, "down") : ne(schema.monitor.consecutiveSuccesses, 0)));
      if (affected(res) > 0) {
        const [row] = await db.select({ successes: schema.monitor.consecutiveSuccesses, threshold: schema.monitor.recoveryThreshold }).from(schema.monitor).where(eq(schema.monitor.id, m.id));
        return row ? { successes: row.successes, ready: row.successes >= row.threshold } : null;
      }
      const [cur] = await db.select({ paused: schema.monitor.paused, successes: schema.monitor.consecutiveSuccesses, threshold: schema.monitor.recoveryThreshold })
        .from(schema.monitor).where(eq(schema.monitor.id, m.id));
      return !cur || cur.paused ? null : { successes: cur.successes, ready: cur.successes >= cur.threshold };
    },

    async completeRecovery(m, status, consecutiveSlow) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, m.id)).for("update");
        if (!current || current.paused || current.status !== "down" || current.consecutiveSuccesses < current.recoveryThreshold) return null;
        const at = new Date();
        const open = await tx.select().from(schema.incident)
          .where(and(eq(schema.incident.monitorId, m.id), isNull(schema.incident.resolvedAt), sql`not (${schema.incident.auto} and ${schema.incident.severity} = 'minor')`));
        if (open.length) {
          await tx.update(schema.incident)
            .set({ status: "resolved", resolvedAt: at, nextReminderAt: null, nextEscalationAt: null })
            .where(inArray(schema.incident.id, open.map((i) => i.id)));
          await tx.insert(schema.incidentUpdate).values(open.map((inc) => ({ incidentId: inc.id, status: "resolved" as const, body: "Checks are passing again." })));
        }
        await tx.update(schema.monitor).set({ status, consecutiveSlow, statusChangedAt: at }).where(eq(schema.monitor.id, m.id));
        return open.map((i) => ({ ...i, status: "resolved" as const, resolvedAt: at, nextReminderAt: null, nextEscalationAt: null }));
      });
    },

    async recordHeartbeatSuccess(id) {
      await db.transaction(async (tx) => {
        // Both CASE expressions below read the previous status. MySQL assigns SET columns left to right in schema
        // order, so move the timestamp while the old status is still present, then write the status itself.
        await tx.update(schema.monitor).set({
          statusChangedAt: sql`case when ${schema.monitor.status} not in ('down', 'up') then ${now} else ${schema.monitor.statusChangedAt} end`,
        }).where(and(eq(schema.monitor.id, id), eq(schema.monitor.paused, false)));
        await tx.update(schema.monitor).set({
          status: sql`case when ${schema.monitor.status} = 'down' then ${schema.monitor.status} else 'up' end`,
          consecutiveSuccesses: sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})`,
          consecutiveFailures: 0,
          lastCheckedAt: new Date(),
          nextCheckAt: sql`date_add(${now}, interval ${schema.monitor.intervalSec} + ${schema.monitor.graceSec} second)`,
        }).where(and(eq(schema.monitor.id, id), eq(schema.monitor.paused, false)));
      });
      const [row] = await db.select().from(schema.monitor).where(eq(schema.monitor.id, id));
      return row ?? null;
    },

    // ── checking ───────────────────────────────────────────────────────────────
    async claimDue(limit) {
      return db.transaction(async (tx) => {
        const due = await tx.select({ id: schema.monitor.id }).from(schema.monitor)
          .where(and(eq(schema.monitor.paused, false), lte(schema.monitor.nextCheckAt, now)))
          .orderBy(asc(schema.monitor.nextCheckAt)).limit(limit).for("update", { skipLocked: true });
        if (!due.length) return [];
        const ids = due.map((d) => d.id);
        await tx.update(schema.monitor).set({
          runGeneration: sql`${schema.monitor.runGeneration} + 1`,
          nextCheckAt: sql`case
            when ${schema.monitor.type} <> 'heartbeat' and ${schema.monitor.intervalSec} > 60
              then from_unixtime((floor((unix_timestamp(${now}) - ${phaseSec}) / ${schema.monitor.intervalSec}) + 1) * ${schema.monitor.intervalSec} + ${phaseSec})
            when date_add(${schema.monitor.nextCheckAt}, interval ${schema.monitor.intervalSec} second) > ${now}
              then date_add(${schema.monitor.nextCheckAt}, interval ${schema.monitor.intervalSec} second)
            else date_add(${now}, interval ${schema.monitor.intervalSec} second) end`,
        }).where(inArray(schema.monitor.id, ids));
        return tx.select().from(schema.monitor).where(inArray(schema.monitor.id, ids));
      });
    },
    async monitorsByIds(ids) {
      return ids.length ? db.select().from(schema.monitor).where(inArray(schema.monitor.id, ids)) : [];
    },
    async beginRuns(runs) {
      // The row lock serializes duplicate starts. Generations never move backwards when an interval is shortened.
      const started = await Promise.all(
        runs.map(async ({ id, token, generation }) => {
          if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0)) throw new Error("Invalid run generation");
          const newer = generation === undefined
            // Legacy messages can finish until this monitor starts using generation-based claims.
            ? and(eq(schema.monitor.lastRunGeneration, 0), or(isNull(schema.monitor.lastRunToken), lt(schema.monitor.lastRunToken, token)))
            : sql`${schema.monitor.lastRunGeneration} < ${generation} and ${schema.monitor.runGeneration} >= ${generation}`;
          const res = await db
            .update(schema.monitor)
            .set({ lastRunToken: token, ...(generation !== undefined ? { lastRunGeneration: generation } : {}) })
            .where(and(eq(schema.monitor.id, id), newer));
          return affected(res) > 0 ? id : null;
        }),
      );
      return started.filter((id): id is string => id !== null);
    },
    async releaseClaims(runs) {
      await Promise.all(
        runs.map(({ id, token }) =>
          db
            .update(schema.monitor)
            .set({ nextCheckAt: now })
            // timestamp(3) keeps milliseconds, and the token is a JS date with the same precision
            .where(and(eq(schema.monitor.id, id), eq(schema.monitor.nextCheckAt, token))),
        ),
      );
    },
    recordObservation: (m, result, options) => recordObservation(db, m, result, options),
    recordHeartbeatObservation: (m) => recordHeartbeatObservation(db, m),
    timeCoverage: (orgId, monitorId, scope, days, now) => timeCoverage(db, orgId, monitorId, scope, days, now),
    async recordCheck(r) {
      // the raw result and its hourly rollup together; a transaction keeps the pair consistent on failure
      const latency = r.latencyMs ?? null;
      await db.transaction(async (tx) => {
        await tx.insert(schema.checkResult).values({
          monitorId: r.monitorId, region: r.region ?? "auto", ok: r.ok,
          statusCode: r.statusCode ?? null, latencyMs: latency, error: r.error ?? null, mcp: r.mcp ?? null,
        });
        await foldIntoRollup(tx, r.monitorId, r.ok, latency);
      });
    },
    async recordRegionResults(monitorId, results, summary) {
      if (!results.length) return;
      await db.insert(schema.checkResult).values(
        results.map((r) => ({ monitorId, region: r.region, ok: r.ok, statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error })),
      );
      await foldIntoRollup(db, monitorId, summary.ok, summary.latencyMs ?? null);
    },
    async acceptDomainExpiry(snapshot, expiry) {
      // Conditional UPDATE is atomic with target/threshold edits and their metadata invalidation.
      const res = await db.update(schema.monitor).set({ domainExpiry: expiry }).where(and(
        eq(schema.monitor.id, snapshot.id), eq(schema.monitor.type, "domain"), eq(schema.monitor.paused, false),
        eq(schema.monitor.target, snapshot.target), eq(schema.monitor.domainExpiryWarnDays, snapshot.domainExpiryWarnDays ?? 30),
      ));
      return affected(res) === 1;
    },
    async withMcpOAuth(snapshot, apply) {
      // Serialize refreshes with a lease row instead of holding a connection during the token request: each statement
      // here is a short autocommit query. A live lease means another check is refreshing this monitor.
      const leaseToken = crypto.randomUUID();
      const leaseSec = Math.ceil(Math.min(Math.max(snapshot.timeoutMs ?? 30_000, 1_000), 30_000) / 1000) + 60;
      const t = schema.mcpOAuthLease;
      const until = new Date(Date.now() + leaseSec * 1000);
      const [existing] = await db.select().from(t).where(eq(t.monitorId, snapshot.id));
      if (existing) {
        const taken = await db.update(t).set({ leaseToken, leaseUntil: until })
          .where(and(eq(t.monitorId, snapshot.id), lte(t.leaseUntil, new Date())));
        if (affected(taken) === 0) return null;
      } else {
        try {
          await db.insert(t).values({ monitorId: snapshot.id, leaseToken, leaseUntil: until });
        } catch (error) {
          const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
          const code = (cause as { code?: string; errno?: number } | undefined);
          // The monitor was deleted meanwhile (foreign key violation) or another check won the insert.
          if (code?.code === "ER_NO_REFERENCED_ROW_2" || code?.code === "ER_DUP_ENTRY") return null;
          throw error;
        }
      }
      try {
        const [current] = await db.select().from(schema.monitor).where(and(eq(schema.monitor.id, snapshot.id),
          eq(schema.monitor.organizationId, snapshot.organizationId)));
        if (!current || current.type !== "mcp" || current.coverageRevision !== (snapshot.coverageRevision ?? 0)) return null;
        return await apply(createRepo(db), current);
      } finally {
        await db.delete(t).where(and(eq(t.monitorId, snapshot.id), eq(t.leaseToken, leaseToken)));
      }
    },
    async withMcpResult(snapshot, apply) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.monitor).where(and(eq(schema.monitor.id, snapshot.id),
          eq(schema.monitor.organizationId, snapshot.organizationId))).for("update");
        if (!current || current.type !== "mcp" || current.paused || current.coverageRevision !== (snapshot.coverageRevision ?? 0)
          || current.runGeneration !== (snapshot.runGeneration ?? 0)) return null;
        const comparable = (value: unknown) => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
          ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
        if (comparable(current.mcpBaseline) !== comparable(snapshot.mcpBaseline ?? null)) return null;
        // Every result/state/incident write in apply uses this same transaction and row lock.
        // The caller performs external notifications only after this promise commits.
        return apply(createRepo(tx), current);
      });
    },
    async acceptMcpObservation(snapshot, observation, options = {}) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
        if (!current || current.type !== "mcp" || current.paused || current.coverageRevision !== (snapshot.coverageRevision ?? 0)) return false;
        const generation = options.generation;
        if (generation !== undefined) {
          if (!Number.isSafeInteger(generation) || generation <= 0 || generation > current.runGeneration || generation <= current.mcpGeneration) return false;
        } else if (current.runGeneration !== (snapshot.runGeneration ?? 0) || current.mcpGeneration !== (snapshot.mcpGeneration ?? 0)) {
          // A manual check may not replace a scheduled result claimed/completed after it began.
          return false;
        }
        // A concurrent discovery must not evaluate against an absent or replaced baseline.
        const comparable = (value: unknown) => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
          ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
        if (comparable(current.mcpBaseline) !== comparable(snapshot.mcpBaseline ?? null)) return false;
        if (generation === undefined && comparable(current.mcpObservation) !== comparable(snapshot.mcpObservation ?? null)) return false;
        const canBaseline = options.ok === true && completeMcpDiscovery(observation) && current.mcpConfig?.schemaCheck && current.mcpBaseline === null
          && ["schema", "tools/call", "assertions", "complete"].includes(observation.stage);
        const saved: McpObservation = { ...observation, id: crypto.randomUUID(), schemaHash: await mcpSchemaHash(observation.tools), checkedAt: new Date().toISOString() };
        await tx.update(schema.monitor).set({
          mcpObservation: saved,
          ...(canBaseline ? { mcpBaseline: observation.tools } : {}),
          ...(generation !== undefined ? { mcpGeneration: generation } : {}),
        }).where(eq(schema.monitor.id, current.id));
        return true;
      });
    },
    async acceptMcpBaseline(orgId, id, scope, expected) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.monitor).where(and(eq(schema.monitor.id, id), eq(schema.monitor.organizationId, orgId),
          eq(schema.monitor.type, "mcp"), inScope(scope, schema.monitor.projectId))).for("update");
        if (!current) return { status: "not_found" as const };
        const seen = current.mcpObservation;
        if (!expected || !seen?.id || seen.id !== expected.observationId || seen.schemaHash !== expected.schemaHash) return { status: "stale" as const };
        if (!completeMcpDiscovery(seen)) return { status: "incomplete" as const };
        await tx.update(schema.monitor).set({ mcpBaseline: seen.tools,
          coverageRevision: current.coverageRevision + 1, nextCheckAt: now }).where(eq(schema.monitor.id, id));
        const [row] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, id));
        const at = await coverageTime(tx, id);
        await tx.insert(schema.monitorObservation).values({ monitorId: id, observedAt: at,
          state: row.paused ? "paused" : "unknown", revision: row.coverageRevision });
        return { status: "accepted" as const, monitor: row };
      });
    },
    async resetMcpBaseline(orgId, id, scope, expected) {
      const result = await createRepo(db).acceptMcpBaseline(orgId, id, scope, expected);
      return result.status === "accepted" ? result.monitor : null;
    },
    async rotateMcpRefreshToken(snapshot, oldToken, newToken) {
      if (!newToken || newToken.length > 16384) return false;
      const res = await db.update(schema.monitor).set({
        mcpConfig: sql`json_set(${schema.monitor.mcpConfig}, '$.oauth.refreshToken', ${newToken})`,
      }).where(and(eq(schema.monitor.id, snapshot.id), eq(schema.monitor.type, "mcp"),
        eq(schema.monitor.coverageRevision, snapshot.coverageRevision ?? 0),
        sql`json_unquote(json_extract(${schema.monitor.mcpConfig}, '$.oauth.refreshToken')) = ${oldToken}`));
      return affected(res) === 1;
    },
    async mcpHistory(orgId, id, scope, options = {}) {
      const [owned] = await db.select({ id: schema.monitor.id }).from(schema.monitor).where(and(eq(schema.monitor.id, id),
        eq(schema.monitor.organizationId, orgId), eq(schema.monitor.type, "mcp"), inScope(scope, schema.monitor.projectId)));
      if (!owned) return null;
      const days = options.days === 30 ? 30 : 7;
      const limit = Math.min(200, Math.max(1, options.limit ?? 50));
      const since = new Date(Date.now() - days * 864e5);
      const results = await db.select().from(schema.checkResult).where(and(eq(schema.checkResult.monitorId, id),
        isNotNull(schema.checkResult.mcp), gte(schema.checkResult.checkedAt, since),
        options.before ? lt(schema.checkResult.checkedAt, options.before) : undefined))
        .orderBy(desc(schema.checkResult.checkedAt), desc(schema.checkResult.id)).limit(limit);
      // Aggregations run in JS over the window: MySQL has no percentile_cont and no jsonb_each.
      const window = await db.select({ id: schema.checkResult.id, checkedAt: schema.checkResult.checkedAt, latencyMs: schema.checkResult.latencyMs, mcp: schema.checkResult.mcp })
        .from(schema.checkResult).where(and(eq(schema.checkResult.monitorId, id), isNotNull(schema.checkResult.mcp), gte(schema.checkResult.checkedAt, since)))
        .orderBy(asc(schema.checkResult.checkedAt), asc(schema.checkResult.id));
      const percentile = (values: number[], p: number) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        // PostgreSQL's percentile_cont interpolates between the two neighbouring samples; nearest-rank would round a
        // p95 up to the maximum and misreport the tail.
        if (sorted.length === 1) return sorted[0];
        const position = p * (sorted.length - 1);
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
      };
      const latencies = window.flatMap((r) => (r.latencyMs == null ? [] : [r.latencyMs]));
      const byStage = new Map<string, number[]>();
      for (const r of window) {
        const timings = (r.mcp as { timings?: Record<string, unknown> } | null)?.timings;
        if (!timings) continue;
        for (const [stage, value] of Object.entries(timings)) {
          if (typeof value !== "number") continue;
          (byStage.get(stage) ?? byStage.set(stage, []).get(stage)!).push(value);
        }
      }
      const totals = { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
      const stages = Object.fromEntries([...byStage].map(([stage, values]) => [stage, { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }]));
      const changed: { id: string; checkedAt: Date; mcp: import("@openuptime/repo").McpCheckDiagnostics }[] = [];
      let previous: string | null = null;
      for (const row of window) {
        const mcp = row.mcp as { changes?: unknown[]; drift?: unknown[] } | null;
        const fingerprint = JSON.stringify([mcp?.changes ?? [], mcp?.drift ?? []]);
        const has = (mcp?.changes?.length ?? 0) > 0 || (mcp?.drift?.length ?? 0) > 0;
        if (has && fingerprint !== previous) changed.push({ id: row.id, checkedAt: row.checkedAt, mcp: row.mcp as import("@openuptime/repo").McpCheckDiagnostics });
        previous = fingerprint;
      }
      const metrics = { ...totals, stages };
      return { results: results as McpCheckHistory[], metrics, changes: changed.slice(-100).reverse().map(row => ({ id: row.id, checkedAt: row.checkedAt,
        severity: row.mcp?.changes.length || row.mcp?.drift?.some(d => d.severity === "breaking") ? "breaking" : row.mcp?.drift?.some(d => d.severity === "warning") ? "warning" : "info",
        changes: row.mcp?.changes ?? [], drift: row.mcp?.drift ?? [] })) } satisfies McpHistory;
    },
    async enqueueMcpAlerts(tasks) {
      if (!tasks.length) return;
      // Deterministic IDs make retries idempotent without serializing thousands of subscriber inserts.
      const pending = await Promise.all(tasks.map(async task => ({ ...task, id: await mcpTaskId(task.eventKey, task.recipient) })));
      pending.sort((a, b) => a.id.localeCompare(b.id));
      const ids = [...new Set(tasks.flatMap(task => task.channelId ? [task.channelId] : []))];
      const channels = ids.length ? await db.select({ id: schema.alertChannel.id, orgId: schema.alertChannel.organizationId, name: schema.alertChannel.name, type: schema.alertChannel.type })
        .from(schema.alertChannel).where(inArray(schema.alertChannel.id, ids)) : [];
      const byId = new Map(channels.map(channel => [channel.id, channel]));
      await db.transaction(async tx => {
        for (let offset = 0; offset < pending.length; offset += 200) {
          const batch = pending.slice(offset, offset + 200);
          await tx.insert(schema.alertDelivery).values(batch.map(task => {
            const found = task.channelId ? byId.get(task.channelId) : undefined;
            const channel = found?.orgId === task.organizationId ? found : undefined;
            return { id: task.id, organizationId: task.organizationId, projectId: task.event.monitor.projectId, channelId: task.channelId,
              channelName: channel?.name ?? (task.channelId ? "Removed channel" : "Status page subscriber"), channelType: channel?.type ?? "email",
              kind: task.event.kind, incidentId: task.event.incident.id, monitorName: task.event.monitor.name, ok: false, status: "pending" as const, attempts: 0 };
          })).onDuplicateKeyUpdate({ set: { ok: sql`ok` } });
          await tx.insert(schema.mcpAlertOutbox).values(batch.map(task => ({ ...task, deliveryId: task.id })))
            .onDuplicateKeyUpdate({ set: { status: sql`status` } });
        }
      });
    },
    async claimMcpAlerts(limit, monitorId, options) {
      const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
      return db.transaction(async tx => {
        const t = schema.mcpAlertOutbox;
        const scope = monitorId ? eq(t.monitorId, monitorId) : undefined;
        const expired = sql`(${t.status} = 'leased' and ${t.leaseUntil} <= ${now})`;
        const kind = sql`json_unquote(json_extract(${t.event}, '$.kind'))`;
        const incidentId = sql`json_unquote(json_extract(${t.event}, '$.incident.id'))`;
        // A delayed retry of an obsolete "down" must not block the newer recovery for an hour.
        const obsolete = await tx.select({ id: t.id, deliveryId: t.deliveryId }).from(t).where(and(scope, sql`(${t.status} = 'pending' or ${expired})`,
          sql`exists (select 1 from incident i where i.id = ${incidentId}
            and ((${kind} = 'incident.opened' and i.resolved_at is not null)
              or (${kind} = 'incident.resolved' and i.resolved_at is null)))`)).for("update", { skipLocked: true });
        if (obsolete.length) {
          await tx.update(t).set({ status: "skipped", error: "skipped: incident changed before delivery", leaseToken: null, leaseUntil: null })
            .where(inArray(t.id, obsolete.map(row => row.id)));
          await tx.update(schema.alertDelivery).set({ status: "skipped", ok: false,
            error: "skipped: incident changed before delivery", statusMessage: "skipped: incident changed before delivery" })
            .where(inArray(schema.alertDelivery.id, obsolete.map(row => row.deliveryId)));
        }
        // An expired lease is an attempt whose worker died. Once that spends the budget the task fails for good.
        const exhausted = await tx.select({ id: t.id, deliveryId: t.deliveryId, attempts: t.attempts }).from(t)
          .where(and(scope, expired, sql`${t.attempts} + 1 >= ${maxAttempts}`)).for("update", { skipLocked: true });
        if (exhausted.length) {
          await tx.update(t).set({ status: "failed", attempts: sql`${t.attempts} + 1`, error: "MCP alert delivery unavailable", leaseToken: null, leaseUntil: null })
            .where(inArray(t.id, exhausted.map(row => row.id)));
          for (const row of exhausted) await tx.update(schema.alertDelivery).set({ status: "failed", ok: false, error: "MCP alert delivery unavailable",
            statusMessage: `failed: gave up after ${row.attempts + 1} attempts`, attempts: row.attempts + 1 }).where(eq(schema.alertDelivery.id, row.deliveryId));
        }
        const token = crypto.randomUUID();
        const candidates = await tx.select({ id: t.id }).from(t)
          .where(sql`((${t.status} = 'pending' and ${t.nextAttemptAt} <= ${now}) or (${t.status} = 'leased' and ${t.leaseUntil} <= ${now}))
            ${monitorId ? sql`and ${t.monitorId} = ${monitorId}` : sql``}
            and not exists (select 1 from mcp_alert_outbox prior where prior.monitor_id = ${t.monitorId} and prior.recipient = ${t.recipient}
              and prior.sequence < ${t.sequence} and prior.status in ('pending','leased'))`)
          .orderBy(asc(t.sequence)).limit(Math.min(100, Math.max(1, limit))).for("update", { skipLocked: true });
        if (!candidates.length) return [];
        const ids = candidates.map((c) => c.id);
        // MySQL assigns SET columns in schema order (`status` before `attempts`), so the attempt counter is written in
        // its own statement, where it still reads the previous status.
        await tx.update(t).set({ attempts: sql`case when ${t.status} = 'leased' then ${t.attempts} + 1 else ${t.attempts} end` })
          .where(inArray(t.id, ids));
        await tx.update(t).set({ status: "leased", leaseToken: token, leaseUntil: sql`date_add(${now}, interval 3 minute)` })
          .where(inArray(t.id, ids));
        return tx.select().from(t).where(inArray(t.id, ids)) as Promise<McpAlertTask[]>;
      });
    },
    async finishMcpAlert(id, leaseToken, result) {
      return db.transaction(async tx => {
        const t = schema.mcpAlertOutbox;
        const status = result.status === "retry" ? "pending" : result.status;
        const res = await tx.update(t).set({ status,
          attempts: sql`${t.attempts} + 1`, error: result.error ?? null, leaseToken: null, leaseUntil: null,
          nextAttemptAt: sql`date_add(${now}, interval ${Math.min(3600, Math.max(1, result.retryInSec ?? 60))} second)` })
          .where(and(eq(t.id, id), eq(t.status, "leased"), eq(t.leaseToken, leaseToken), gt(t.leaseUntil, now)));
        if (affected(res) === 0) return false;
        const [row] = await tx.select().from(t).where(eq(t.id, id));
        if (!row) return false;
        // The outbox owns this log row: it stays "pending" without next_attempt_at, which the generic retry worker skips.
        await tx.update(schema.alertDelivery).set({ status,
          ok: result.status === "sent", error: result.error ?? null,
          statusMessage: result.status === "retry" ? "failed: queued for retry" : result.status === "failed" ? `failed: gave up after ${row.attempts} attempts` : result.error ?? null,
          attempts: row.attempts }).where(eq(schema.alertDelivery.id, row.deliveryId));
        return true;
      });
    },
    async renewMcpAlertLease(id, leaseToken) {
      const res = await db.update(schema.mcpAlertOutbox).set({ leaseUntil: sql`date_add(${now}, interval 3 minute)` }).where(and(eq(schema.mcpAlertOutbox.id, id),
        eq(schema.mcpAlertOutbox.status, "leased"), eq(schema.mcpAlertOutbox.leaseToken, leaseToken), gt(schema.mcpAlertOutbox.leaseUntil, now)));
      return affected(res) === 1;
    },
    async settleMcpAlertQuota(id, leaseToken, decision) {
      const res = await db.update(schema.mcpAlertOutbox).set({ quotaDecision: decision }).where(and(eq(schema.mcpAlertOutbox.id, id),
        eq(schema.mcpAlertOutbox.status, "leased"), eq(schema.mcpAlertOutbox.leaseToken, leaseToken),
        gt(schema.mcpAlertOutbox.leaseUntil, now), isNull(schema.mcpAlertOutbox.quotaDecision)));
      return affected(res) === 1;
    },
    async markMcpAlertQuota(id, leaseToken) {
      const t = schema.mcpAlertOutbox;
      const held = and(eq(t.id, id), eq(t.status, "leased"), eq(t.leaseToken, leaseToken), gt(t.leaseUntil, now));
      const res = await db.update(t).set({ quotaAttempted: true }).where(held);
      if (affected(res) > 0) return true;
      // MySQL counts only changed rows: a checkpoint a crashed worker already wrote leaves this UPDATE untouched,
      // which is not a lost lease. Re-check ownership and report the existing checkpoint as this worker's own.
      const [row] = await db.select({ quotaAttempted: t.quotaAttempted }).from(t).where(held);
      return row?.quotaAttempted === true;
    },
    async setMonitorState(id, state) {
      // MySQL evaluates a single-table UPDATE's SET list left to right and drizzle emits columns in schema order
      // (`status` before `status_changed_at`), so the CASE would see the new status. Write the timestamp first, while
      // the old status is still in the row.
      const changed = state.status ? { statusChangedAt: sql`case when not (${schema.monitor.status} <=> ${state.status}) then ${now} else ${schema.monitor.statusChangedAt} end` } : null;
      await db.transaction(async (tx) => {
        if (changed) await tx.update(schema.monitor).set(changed).where(eq(schema.monitor.id, id));
        await tx.update(schema.monitor).set(state).where(eq(schema.monitor.id, id));
      });
    },
    async underMaintenance(m) {
      const at = new Date();
      const [w] = await db
        .select({ id: schema.maintenanceWindow.id })
        .from(schema.maintenanceWindow)
        .where(
          and(
            eq(schema.maintenanceWindow.organizationId, m.organizationId),
            // a window belongs to one project (null = the whole workspace); it never reaches another project's monitors
            m.projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, m.projectId)) : isNull(schema.maintenanceWindow.projectId),
            lte(schema.maintenanceWindow.startsAt, at),
            gte(schema.maintenanceWindow.endsAt, at),
            or(sql`json_length(${schema.maintenanceWindow.monitorIds}) = 0`, sql`json_contains(${schema.maintenanceWindow.monitorIds}, json_quote(${m.id}))`),
          ),
        )
        .limit(1);
      return !!w;
    },
    async purgeExpired() {
      // Keep one predecessor per monitor as the boundary anchor, including resume/unknown fences.
      await db.execute(sql`delete from monitor_observation where observed_at < date_sub(${now}, interval 35 day)
        and exists (select 1 from (select id, monitor_id, observed_at from monitor_observation) newer where newer.monitor_id = monitor_observation.monitor_id
          and newer.observed_at < date_sub(${now}, interval 35 day)
          and (newer.observed_at, newer.id) > (monitor_observation.observed_at, monitor_observation.id))`);
      await db.delete(schema.rdapCache).where(lte(schema.rdapCache.expiresAt, new Date(Date.now() - 7 * 864e5)));
      // raw results are kept per workspace for its configured number of days; hourly rollups far longer
      await db.execute(sql`delete r from check_result r join monitor m on m.id = r.monitor_id
        where r.checked_at < date_sub(${now}, interval coalesce((select s.check_retention_days from workspace_setting s where s.organization_id = m.organization_id), ${DEFAULT_CHECK_RETENTION_DAYS}) day)`);
      await db.delete(schema.checkRollup).where(lte(schema.checkRollup.bucket, new Date(Date.now() - ROLLUP_RETENTION_DAYS * 864e5)));
      // counters only matter within their window (the longest is an hour)
      await db.execute(sql`delete from rate_limit where window_start < date_sub(${now}, interval 1 day)`);
      await db.execute(sql`delete d from alert_delivery d
        where d.created_at < date_sub(${now}, interval coalesce((select s.alert_log_retention_days from workspace_setting s where s.organization_id = d.organization_id), ${DEFAULT_ALERT_LOG_DAYS}) day)
          and not exists (select 1 from mcp_alert_outbox q where q.delivery_id = d.id and q.status in ('pending', 'leased'))`);
      // a phone that has not opened the app (which re-registers on launch) for half a year is gone or has a stale token
      await db.delete(schema.pushDevice).where(lte(schema.pushDevice.lastSeenAt, new Date(Date.now() - PUSH_DEVICE_STALE_DAYS * 864e5)));
    },
    async withinLimit(key, limit, windowSec) {
      const t = schema.rateLimit;
      // Decide expiry in JS: MySQL writes SET columns in schema order, so a CASE that reads window_start would see the
      // value this same statement just wrote and never count the window as expired.
      const [current] = await db.select({ windowStart: t.windowStart }).from(t).where(eq(t.key, key));
      const expired = !current || current.windowStart.getTime() < Date.now() - windowSec * 1000;
      await db
        .insert(t)
        .values({ key, count: 1 })
        .onDuplicateKeyUpdate({
          set: expired ? { count: 1, windowStart: now } : { count: sql`${t.count} + 1` },
        });
      const [row] = await db.select({ count: t.count }).from(t).where(eq(t.key, key));
      // opportunistic cleanup keeps the table small without a separate job
      if (Math.random() < 0.01) await db.delete(t).where(sql`${t.windowStart} < date_sub(${now}, interval 1 day)`).catch(() => {});
      return Number(row?.count ?? 0) <= limit;
    },

    // ── incidents ──────────────────────────────────────────────────────────────
    async listIncidents(orgId, projectId) {
      const ids = ([] as string[]).concat(projectId);
      if (!ids.length) return [];
      const r = await db
        .select({ i: schema.incident, monitorName: schema.monitor.name })
        .from(schema.incident)
        .leftJoin(schema.monitor, eq(schema.monitor.id, schema.incident.monitorId))
        // an incident belongs to the project that numbered it; one without (it predates numbering) falls back to its monitor
        .where(and(eq(schema.incident.organizationId, orgId), or(inArray(schema.incident.projectId, ids), and(isNull(schema.incident.projectId), or(inArray(schema.monitor.projectId, ids), isNull(schema.incident.monitorId))))))
        .orderBy(desc(schema.incident.startedAt))
        .limit(100);
      return r.map((x) => ({ ...x.i, monitorName: x.monitorName }));
    },
    async incidentVisible(orgId, id, scope) {
      if (!scope) return true;
      const [row] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .leftJoin(schema.monitor, eq(schema.monitor.id, schema.incident.monitorId))
        .where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId), or(inArray(schema.incident.projectId, scope), and(isNull(schema.incident.projectId), or(inArray(schema.monitor.projectId, scope), isNull(schema.incident.monitorId))))));
      return !!row;
    },
    async incidentDetail(orgId, id) {
      const [inc] = await db.select().from(schema.incident).where(and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId)));
      if (!inc) return null;
      const [updates, monitor, assignee, checks] = await Promise.all([
        db.select().from(schema.incidentUpdate).where(eq(schema.incidentUpdate.incidentId, inc.id)).orderBy(asc(schema.incidentUpdate.createdAt)),
        inc.monitorId
          ? db.select({ id: schema.monitor.id, name: schema.monitor.name, status: schema.monitor.status, target: schema.monitor.target, type: schema.monitor.type })
              .from(schema.monitor).where(eq(schema.monitor.id, inc.monitorId)).then((r) => r[0] ?? null)
          : null,
        inc.assigneeId
          ? db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, inc.assigneeId)).then((r) => r[0] ?? null)
          : null,
        inc.monitorId
          ? db.select({ id: schema.checkResult.id, ok: schema.checkResult.ok, statusCode: schema.checkResult.statusCode, latencyMs: schema.checkResult.latencyMs, error: schema.checkResult.error, checkedAt: schema.checkResult.checkedAt })
              .from(schema.checkResult)
              .where(and(eq(schema.checkResult.monitorId, inc.monitorId), eq(schema.checkResult.ok, false), gte(schema.checkResult.checkedAt, inc.startedAt), inc.resolvedAt ? lte(schema.checkResult.checkedAt, inc.resolvedAt) : undefined))
              .orderBy(desc(schema.checkResult.checkedAt)).limit(8)
          : [],
      ]);
      return { incident: inc, updates, monitor, assignee, checks };
    },
    async deleteIncident(orgId, id) {
      return db.transaction(async (tx) => {
        const owned = and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId));
        // Notification history has no foreign key to the incident. Remove it first so a queued retry cannot outlive the
        // event it describes; deleting these rows also cascades to the MCP alert outbox.
        await tx.delete(schema.alertDelivery).where(and(eq(schema.alertDelivery.organizationId, orgId), eq(schema.alertDelivery.incidentId, id)));
        const res = await tx.delete(schema.incident).where(owned);
        return affected(res) > 0;
      });
    },
    async createIncident(inc, firstUpdate) {
      // the incident and its first update land together or not at all
      return db.transaction(async (tx) => {
        const { projectId, number } = await allocateNumber(tx, inc);
        const row = { id: newId(), organizationId: inc.organizationId, monitorId: inc.monitorId ?? null, projectId, number, title: inc.title, severity: inc.severity, auto: inc.auto, assigneeId: inc.assigneeId, evaluationNote: inc.evaluationNote };
        await tx.insert(schema.incident).values(row);
        const [saved] = await tx.select().from(schema.incident).where(eq(schema.incident.id, row.id));
        if (firstUpdate) await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: firstUpdate.status, body: firstUpdate.body, authorId: firstUpdate.authorId, byPerson: !!firstUpdate.authorId, visibility: firstUpdate.visibility });
        return saved;
      });
    },
    async openAutoIncident(inc, firstUpdate) {
      // MySQL has no partial unique index: the monitor row lock serializes the open-or-insert decision.
      return db.transaction(async (tx) => {
        const monitorId = inc.monitorId ?? null;
        // An omitted severity takes the column default; comparing against `undefined` would render `severity = NULL`,
        // which never matches and let every concurrent caller open its own incident.
        const severity = inc.severity ?? "major";
        if (monitorId) await tx.select({ id: schema.monitor.id }).from(schema.monitor).where(eq(schema.monitor.id, monitorId)).for("update");
        if (monitorId) {
          const [existing] = await tx.select({ id: schema.incident.id }).from(schema.incident).where(and(
            eq(schema.incident.monitorId, monitorId), eq(schema.incident.auto, true), eq(schema.incident.severity, severity), isNull(schema.incident.resolvedAt),
          )).limit(1);
          if (existing) return null;
        }
        const { projectId, number } = await allocateNumber(tx, inc);
        const row = { id: newId(), organizationId: inc.organizationId, monitorId: inc.monitorId ?? null, projectId, number, title: inc.title, severity, auto: true, assigneeId: inc.assigneeId, evaluationNote: inc.evaluationNote };
        await tx.insert(schema.incident).values(row);
        const [saved] = await tx.select().from(schema.incident).where(eq(schema.incident.id, row.id));
        await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: firstUpdate.status, body: firstUpdate.body, authorId: firstUpdate.authorId, byPerson: !!firstUpdate.authorId, visibility: firstUpdate.visibility });
        return saved;
      });
    },
    async postIncidentUpdate(orgId, id, u) {
      return db.transaction(async (tx) => {
        const where = and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId));
        // A postmortem published on a resolved incident is withdrawn when the update reopens it. MySQL writes SET
        // columns in schema order, so the CASE must run in its own statement, while resolved_at is still populated.
        if (u.status !== "resolved") {
          await tx.update(schema.incident)
            .set({ postmortemPublishedAt: sql`case when ${schema.incident.resolvedAt} is not null then null else ${schema.incident.postmortemPublishedAt} end` })
            .where(where);
        }
        const set: Partial<typeof schema.incident.$inferInsert> = { status: u.status, resolvedAt: u.status === "resolved" ? new Date() : null };
        if (u.status === "resolved") {
          set.nextReminderAt = null;
          set.nextEscalationAt = null;
        }
        await tx.update(schema.incident).set(set).where(where);
        const [incident] = await tx.select().from(schema.incident).where(where);
        if (!incident) return null;
        const updateId = newId();
        await tx.insert(schema.incidentUpdate).values({ id: updateId, incidentId: id, status: u.status, body: u.body, authorId: u.authorId, byPerson: !!u.authorId, visibility: u.visibility });
        const [update] = await tx.select().from(schema.incidentUpdate).where(eq(schema.incidentUpdate.id, updateId));
        return { incident, update };
      });
    },
    async updateIncidentWriteUp(orgId, id, w) {
      const set: Partial<typeof schema.incident.$inferInsert> = {};
      if (w.rootCause !== undefined) set.rootCause = w.rootCause;
      if (w.postmortem !== undefined) set.postmortem = w.postmortem;
      if (w.publish !== undefined) set.postmortemPublishedAt = w.publish ? new Date() : null;
      const where = and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId));
      if (!Object.keys(set).length) return db.select().from(schema.incident).where(where).then((r) => r[0] ?? null);
      await db.update(schema.incident).set(set).where(where);
      const [row] = await db.select().from(schema.incident).where(where);
      return row ?? null;
    },
    async acknowledgeIncident(orgId, id, userId) {
      const where = and(eq(schema.incident.id, id), eq(schema.incident.organizationId, orgId));
      await db
        .update(schema.incident)
        .set({ acknowledgedAt: new Date(), assigneeId: userId, nextReminderAt: null, nextEscalationAt: null })
        .where(where);
      const [inc] = await db.select().from(schema.incident).where(where);
      // the alerts that went out before the acknowledgement are marked as seen
      if (inc) await db.update(schema.alertDelivery).set({ acknowledgedAt: inc.acknowledgedAt }).where(and(eq(schema.alertDelivery.incidentId, id), isNull(schema.alertDelivery.acknowledgedAt), inArray(schema.alertDelivery.kind, ["incident.opened", "incident.reminder", "incident.escalated"])));
      return inc ?? null;
    },
    async hasOpenIncident(monitorId, slow) {
      // a latency incident is automatic and minor; every other open incident counts as an outage for deduplication
      const isSlow = sql`(${schema.incident.auto} and ${schema.incident.severity} = 'minor')`;
      const [r] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), slow ? isSlow : sql`not ${isSlow}`))
        .limit(1);
      return !!r;
    },
    async hadIncidentSince(monitorId, since) {
      const [r] = await db
        .select({ id: schema.incident.id })
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), gte(schema.incident.startedAt, since), sql`not (${schema.incident.auto} and ${schema.incident.severity} = 'minor')`, sql`not ${resolvedByPerson(schema.incident.id)}`))
        .limit(1);
      return !!r;
    },
    async reopenIncident(monitorId, since, body, evaluationNote) {
      return db.transaction(async (tx) => {
        // a person's resolution stands: only an incident the checks resolved themselves is reopened
        const byPerson = resolvedByPerson(schema.incident.id);
        const [last] = await tx
          .select({ id: schema.incident.id })
          .from(schema.incident)
          .where(and(eq(schema.incident.monitorId, monitorId), eq(schema.incident.auto, true), eq(schema.incident.severity, "major"), gte(schema.incident.resolvedAt, since), sql`not ${byPerson}`))
          .orderBy(desc(schema.incident.resolvedAt))
          .limit(1);
        if (!last) return null;
        // the monitor row lock serializes concurrent reopen/open for this monitor (no partial unique index in MySQL)
        await tx.select({ id: schema.monitor.id }).from(schema.monitor).where(eq(schema.monitor.id, monitorId)).for("update");
        const [open] = await tx.select({ id: schema.incident.id }).from(schema.incident).where(and(
          eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), eq(schema.incident.auto, true), eq(schema.incident.severity, "major"),
        )).limit(1);
        if (open) return null;
        const where = and(eq(schema.incident.id, last.id), isNotNull(schema.incident.resolvedAt));
        await tx
          .update(schema.incident)
          .set({ status: "investigating", resolvedAt: null, evaluationNote, acknowledgedAt: null, postmortemPublishedAt: null, reminderCount: 0, escalationLevel: 0, nextReminderAt: null, nextEscalationAt: null })
          .where(where);
        const [row] = await tx.select().from(schema.incident).where(eq(schema.incident.id, last.id));
        if (!row || row.resolvedAt) return null;
        await tx.insert(schema.incidentUpdate).values({ incidentId: row.id, status: "investigating", body });
        return row;
      });
    },
    async outageHandledByPerson(monitorId) {
      // The current failing streak started after the last passing run and after the monitor's last status change (a region that
      // fails for good means no run ever passes, so the status change is what keeps an old resolve from counting forever).
      const res = await rows<{ handled: number }>(db.execute(sql`
        select exists (
          select 1 from incident i
          where i.monitor_id = ${monitorId} and not (i.auto and i.severity = 'minor') and i.resolved_at is not null
            -- a run passed when none of its region rows failed (the rows of one run share a timestamp)
            and i.resolved_at > coalesce((select max(c.checked_at) from check_result c where c.monitor_id = ${monitorId} and c.ok
              and not exists (select 1 from check_result f where f.monitor_id = c.monitor_id and f.checked_at = c.checked_at and not f.ok)), '1970-01-01')
            and i.resolved_at > coalesce((select m.status_changed_at from monitor m where m.id = ${monitorId}), '1970-01-01')
            and coalesce((select u.by_person from incident_update u where u.incident_id = i.id and u.status = 'resolved' order by u.created_at desc limit 1), 0)
        ) as handled`));
      return !!res[0]?.handled;
    },
    openIncidents(monitorId, slow) {
      const isSlow = sql`(${schema.incident.auto} and ${schema.incident.severity} = 'minor')`;
      return db
        .select()
        .from(schema.incident)
        .where(and(eq(schema.incident.monitorId, monitorId), isNull(schema.incident.resolvedAt), slow ? isSlow : sql`not ${isSlow}`));
    },
    async resolveIncident(id, body) {
      // only the caller that flips it from open to resolved gets true (and so sends the recovery alert)
      const res = await db
        .update(schema.incident)
        .set({ status: "resolved", resolvedAt: new Date(), nextReminderAt: null, nextEscalationAt: null })
        .where(and(eq(schema.incident.id, id), isNull(schema.incident.resolvedAt)));
      if (affected(res) === 0) return false;
      await db.insert(schema.incidentUpdate).values({ incidentId: id, status: "resolved", body });
      return true;
    },
    async incidentMuted(id) {
      const [muted] = await db
        .select({ id: schema.alertDelivery.id })
        .from(schema.alertDelivery)
        .where(and(eq(schema.alertDelivery.incidentId, id), eq(schema.alertDelivery.kind, "incident.muted")))
        .limit(1);
      return !!muted;
    },

    // ── alerting ───────────────────────────────────────────────────────────────
    listChannels: (orgId, projectId) =>
      // the project's own channels plus the workspace-wide ones (no project)
      db.select().from(schema.alertChannel).where(and(eq(schema.alertChannel.organizationId, orgId), or(eq(schema.alertChannel.projectId, projectId), isNull(schema.alertChannel.projectId)))),
    async getChannel(orgId, id, scope) {
      const [ch] = await db
        .select()
        .from(schema.alertChannel)
        // a key limited to some projects still reaches the workspace-wide channels (to test them), but not to change them
        .where(and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), scope ? or(inArray(schema.alertChannel.projectId, scope), isNull(schema.alertChannel.projectId)) : undefined));
      return ch ?? null;
    },
    async createChannel(orgId, projectId, c) {
      const id = newId();
      await db.insert(schema.alertChannel).values({ ...c, id, organizationId: orgId, projectId });
      const [row] = await db.select().from(schema.alertChannel).where(eq(schema.alertChannel.id, id));
      return row;
    },
    async updateChannel(orgId, id, scope, patch) {
      const where = and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), inScope(scope, schema.alertChannel.projectId));
      await db.update(schema.alertChannel).set(patch).where(where);
      const [row] = await db.select().from(schema.alertChannel).where(where);
      return row ?? null;
    },
    async deleteChannel(orgId, id, scope) {
      await db
        .delete(schema.alertChannel)
        .where(and(eq(schema.alertChannel.id, id), eq(schema.alertChannel.organizationId, orgId), inScope(scope, schema.alertChannel.projectId)));
    },
    async autoEnabledChannelIds(orgId, projectId) {
      const rows = await db
        .select({ id: schema.alertChannel.id })
        .from(schema.alertChannel)
        .where(and(eq(schema.alertChannel.organizationId, orgId), or(eq(schema.alertChannel.projectId, projectId), isNull(schema.alertChannel.projectId)), eq(schema.alertChannel.autoEnable, true), eq(schema.alertChannel.enabled, true)));
      return rows.map((r) => r.id);
    },
    monitorsUsingChannel: (orgId, channelId) =>
      db
        .select({ id: schema.monitor.id, name: schema.monitor.name })
        .from(schema.monitor)
        .where(and(eq(schema.monitor.organizationId, orgId), sql`json_contains(${schema.monitor.channelIds}, json_quote(${channelId}))`)),
    async upsertPushDevice(userId, d) {
      const now = new Date();
      await db
        .insert(schema.pushDevice)
        .values({ userId, token: d.token, platform: d.platform, environment: d.environment, locale: d.locale ?? null, name: d.name ?? null, critical: d.critical ?? false, lastSeenAt: now })
        .onDuplicateKeyUpdate({
          set: { userId, platform: d.platform, environment: d.environment, locale: d.locale ?? null, name: d.name ?? null, ...(d.critical === undefined ? {} : { critical: d.critical }), lastSeenAt: now },
        });
      const [row] = await db.select().from(schema.pushDevice).where(eq(schema.pushDevice.token, d.token));
      return row as PushDevice;
    },
    async listPushDevices(userId) {
      return (await db.select().from(schema.pushDevice).where(eq(schema.pushDevice.userId, userId)).orderBy(asc(schema.pushDevice.createdAt))) as PushDevice[];
    },
    async deletePushDevice(userId, token) {
      const res = await db.delete(schema.pushDevice).where(and(eq(schema.pushDevice.userId, userId), eq(schema.pushDevice.token, token)));
      return affected(res) > 0;
    },
    async pushDevicesForOrganization(orgId) {
      const rows = await db
        .select({ d: schema.pushDevice })
        .from(schema.pushDevice)
        .innerJoin(schema.member, eq(schema.member.userId, schema.pushDevice.userId))
        .where(eq(schema.member.organizationId, orgId));
      return rows.map((r) => r.d) as PushDevice[];
    },
    async deletePushDeviceByToken(token) {
      await db.delete(schema.pushDevice).where(eq(schema.pushDevice.token, token));
    },
    async managedOrgsWithoutPushChannel(userId) {
      const rows = await db
        .select({ id: schema.member.organizationId })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.userId, userId),
            inArray(schema.member.role, ["owner", "admin"]),
            sql`not exists (select 1 from ${schema.alertChannel} where ${schema.alertChannel.organizationId} = ${schema.member.organizationId} and ${schema.alertChannel.type} = 'push')`,
          ),
        );
      return rows.map((r) => r.id);
    },
    channelsToAlert: (orgId, o) =>
      db
        .select()
        .from(schema.alertChannel)
        .where(
          and(
            eq(schema.alertChannel.organizationId, orgId),
            o.withDisabled ? undefined : eq(schema.alertChannel.enabled, true),
            o.channelIds.length ? inArray(schema.alertChannel.id, o.channelIds) : undefined,
            // without an explicit list, only the monitor's own project (plus any workspace-wide legacy channel) is alerted
            !o.channelIds.length && o.projectId ? or(eq(schema.alertChannel.projectId, o.projectId), isNull(schema.alertChannel.projectId)) : undefined,
          ),
        ),
    channelsByIds: (orgId, ids) =>
      ids.length ? db.select().from(schema.alertChannel).where(and(eq(schema.alertChannel.organizationId, orgId), inArray(schema.alertChannel.id, ids))) : Promise.resolve([]),
    async logDeliveries(list) {
      if (!list.length) return;
      // best effort: a failure to write the log must never break alerting
      const values = list.map((r) => ({ ...r, status: r.status ?? (r.ok ? ("sent" as const) : ("failed" as const)), nextAttemptAt: null }));
      await db.insert(schema.alertDelivery).values(values).catch((e) => console.error("alert log write failed", e));
    },
    async queueDeliveries(list) {
      if (!list.length) return [];
      const ids = list.map(() => newId());
      try {
        await db.insert(schema.alertDelivery).values(list.map((r, i) => ({ ...r, id: ids[i], ok: false, status: "pending" as const, attempts: 0 })));
        const saved = await db.select().from(schema.alertDelivery).where(inArray(schema.alertDelivery.id, ids));
        return saved as AlertDelivery[];
      } catch (e) {
        console.error("alert log write failed", e);
        return [];
      }
    },
    async claimDelivery(id) {
      const t = schema.alertDelivery;
      // a row that waits for a retry is claimable only once its time has come
      const res = await db
        .update(t)
        .set({ status: "sending", claimedAt: now })
        .where(and(eq(t.id, id), eq(t.status, "pending"), or(isNull(t.nextAttemptAt), lte(t.nextAttemptAt, now))));
      if (affected(res) === 0) return null;
      const [row] = await db.select().from(t).where(eq(t.id, id));
      return (row as AlertDelivery) ?? null;
    },
    async markDeliveryEmailQuotaAttempt(id, attempts) {
      const t = schema.alertDelivery;
      const res = await db.update(t).set({ emailQuotaAttempted: true })
        .where(and(eq(t.id, id), eq(t.status, "sending"), eq(t.attempts, attempts)));
      return affected(res) > 0;
    },
    async finishDelivery(id, r) {
      const t = schema.alertDelivery;
      const again = r.status === "failed" && r.retryInSec != null;
      await db
        .update(t)
        .set({
          status: again ? "pending" : r.status,
          ok: r.status === "sent",
          error: r.error,
          statusMessage: r.message,
          // a skip is not an attempt, and neither is a routing decision that could not be made
          attempts: r.status === "skipped" || r.keepAttempts ? sql`${t.attempts}` : sql`${t.attempts} + 1`,
          nextAttemptAt: again ? sql`date_add(${now}, interval ${r.retryInSec} second)` : null,
        })
        .where(and(eq(t.id, id), eq(t.status, "sending")));
    },
    async claimRetries(limit) {
      const t = schema.alertDelivery;
      // rows from before delivery states existed count as pending when they failed and wait for a retry
      const due = sql`(${t.status} = 'pending' or (${t.status} is null and ${t.ok} = false)) and ${t.nextAttemptAt} <= ${now} and ${notMcpOutbox}`;
      const claimed = await db.transaction(async (tx) => {
        // Read a wider window, then claim each row with a conditional UPDATE. MySQL counts the rows it scans (including
        // ones skipped as locked) against LIMIT, so `LIMIT n FOR UPDATE SKIP LOCKED` can return nothing while other due
        // rows remain. The conditional UPDATE is atomic and lets concurrent callers share the work.
        const candidates = await tx.select({ id: t.id }).from(t).where(due).orderBy(asc(t.nextAttemptAt)).limit(Math.max(limit * 8, 32));
        if (!candidates.length) return [];
        const ids: string[] = [];
        for (const c of candidates) {
          const res = await tx.update(t).set({ status: "sending", claimedAt: now, nextAttemptAt: null })
            .where(and(eq(t.id, c.id), due));
          if (affected(res) > 0) ids.push(c.id);
          if (ids.length >= limit) break;
        }
        return ids.length ? tx.select().from(t).where(inArray(t.id, ids)) : [];
      });
      const out: DeliveryRetry[] = [];
      for (const delivery of claimed as AlertDelivery[]) {
        const [incident] = delivery.incidentId ? await db.select().from(schema.incident).where(eq(schema.incident.id, delivery.incidentId)) : [];
        const [monitor] = incident?.monitorId ? await db.select().from(schema.monitor).where(eq(schema.monitor.id, incident.monitorId)) : [];
        const [channel] = delivery.channelId ? await db.select().from(schema.alertChannel).where(eq(schema.alertChannel.id, delivery.channelId)) : [];
        if (incident && monitor && channel?.enabled) out.push({ delivery, incident, monitor, channel });
        else {
          // nothing left to deliver: say why instead of leaving the row hanging
          const why = !incident || !monitor ? "skipped: the incident or monitor was removed" : !channel ? "skipped: the channel was removed" : "skipped: channel disabled";
          await db.update(t).set({ status: "skipped", ok: false, statusMessage: why, error: why }).where(and(eq(t.id, delivery.id), eq(t.status, "sending")));
        }
      }
      return out;
    },
    async pendingHousekeeping() {
      // Supersets of what the claim queries below select, each answered from an index, so an idle tick costs one round trip.
      const [row] = await rows<{ mcp_alerts: number; deliveries: number; follow_ups: number }>(db.execute(sql`select
        exists (select 1 from mcp_alert_outbox where status in ('pending', 'leased')) as mcp_alerts,
        (exists (select 1 from alert_delivery where status in ('pending', 'sending'))
          or exists (select 1 from alert_delivery where status is null and ok = false and next_attempt_at <= ${now})) as deliveries,
        exists (select 1 from incident where resolved_at is null and acknowledged_at is null
          and (next_reminder_at <= ${now} or next_escalation_at <= ${now})) as follow_ups`));
      return { mcpAlerts: !!row?.mcp_alerts, deliveries: !!row?.deliveries, followUps: !!row?.follow_ups };
    },
    async endStuckWork(o) {
      // MySQL cannot terminate a backend from SQL; find this user's old transactions in this database and KILL them here.
      let stuck: { id: number }[] = [];
      try {
        stuck = await rows<{ id: number }>(db.execute(sql`select t.trx_mysql_thread_id as id
          from information_schema.innodb_trx t
          join information_schema.processlist p on p.id = t.trx_mysql_thread_id
          where p.user = substring_index(current_user(), '@', 1) and p.db = database()
            -- TRX_STARTED is written with the OS clock while now(3)/sysdate(3) follow the server's time zone, so on a
            -- host where the two disagree a clock comparison is hours off. An idle connection's processlist time
            -- measures the same wait and never crosses zones.
            and p.command = 'Sleep' and p.time >= ${o.transactionSec}
            and t.trx_mysql_thread_id <> connection_id()`));

      } catch {
        // no PROCESS privilege: nothing to sweep
        stuck = [];
      }
      let ended = 0;
      // KILL is a management command: MySQL refuses it over the prepared-statement protocol drizzle uses, so run it
      // through the pool's text protocol.
      const pool = (db as unknown as { $client?: { query: (text: string) => Promise<unknown> } }).$client;
      for (const s of stuck) {
        const id = Number(s.id);
        if (!Number.isSafeInteger(id)) continue;
        try { await pool?.query(`kill ${id}`); ended++; } catch { /* already gone or no privilege */ }
      }
      let overdue = 0;
      try {
        const [row] = await rows<{ n: number }>(db.execute(sql`select count(*) as n from monitor where not paused and next_check_at < date_sub(${now}, interval ${o.overdueSec} second)`));
        overdue = Number(row?.n ?? 0);
      } catch {
        // a database that has not been migrated yet has no monitor table to report on
      }
      return { ended, overdue };
    },
    async sweepStuckDeliveries(o) {
      const t = schema.alertDelivery;
      const stuckBefore = new Date(Date.now() - o.stuckSec * 1000);
      // an interrupted attempt counts as an attempt: after the last one the row is failed for good
      const stuck = await db.select({ id: t.id, attempts: t.attempts, nextAttemptAt: t.nextAttemptAt, createdAt: t.createdAt }).from(t)
        .where(and(eq(t.status, "sending"), lt(t.claimedAt, stuckBefore)));
      let count = 0;
      for (const row of stuck) {
        if (row.attempts + 1 >= o.maxAttempts) {
          await db.update(t).set({ status: "failed", ok: false, attempts: row.attempts + 1, error: "The worker stopped before the alert was confirmed", statusMessage: "failed: the worker stopped before the alert was confirmed" })
            .where(and(eq(t.id, row.id), eq(t.status, "sending")));
        } else {
          await db.update(t).set({ status: "pending", attempts: row.attempts + 1, nextAttemptAt: now, statusMessage: "retrying: the worker stopped before the alert was confirmed" })
            .where(and(eq(t.id, row.id), eq(t.status, "sending")));
        }
        count++;
      }
      // rows queued but never claimed (the dispatcher died in between) become retries too
      const res = await db
        .update(t)
        .set({ nextAttemptAt: now })
        .where(and(eq(t.status, "pending"), isNull(t.nextAttemptAt), lt(t.createdAt, stuckBefore), notMcpOutbox));
      return count + affected(res);
    },
    incidentDeliveries: (orgId, incidentId) =>
      db
        .select()
        .from(schema.alertDelivery)
        .where(and(eq(schema.alertDelivery.organizationId, orgId), eq(schema.alertDelivery.incidentId, incidentId)))
        .orderBy(asc(schema.alertDelivery.createdAt)) as unknown as Promise<AlertDelivery[]>,

    async scheduleFollowUps(inc, projectId) {
      if (!projectId) return;
      const [p] = await db.select().from(schema.project).where(eq(schema.project.id, projectId));
      if (!p) return;
      const first = p.escalation[0];
      const set: Partial<typeof schema.incident.$inferInsert> = {};
      if (p.reminderIntervalMin) set.nextReminderAt = new Date(Date.now() + p.reminderIntervalMin * 60_000);
      if (first) set.nextEscalationAt = new Date(inc.startedAt.getTime() + first.escalateAfterMin * 60_000);
      if (Object.keys(set).length) await db.update(schema.incident).set(set).where(and(eq(schema.incident.id, inc.id), isNull(schema.incident.resolvedAt), isNull(schema.incident.acknowledgedAt)));
    },
    async claimReminders(limit, skip) {
      const i = schema.incident;
      const out: ReminderDue[] = [];
      // Monitors under maintenance are left out in SQL, so a pile of them cannot fill the pages ahead of the incidents that
      // are due. `skip` covers whatever else the caller wants held back; those rows stay due, so a page of candidates can
      // consist of them alone: keep paging past them until `limit` is filled or nothing is left. The answer is remembered
      // per monitor within the call.
      const underMaintenance = sql`exists (
        select 1 from maintenance_window w
        where w.organization_id = ${schema.monitor.organizationId}
          and (w.project_id is null or w.project_id = ${schema.monitor.projectId})
          and w.starts_at <= ${now} and w.ends_at >= ${now}
          and (json_length(w.monitor_ids) = 0 or json_contains(w.monitor_ids, json_quote(${schema.monitor.id})))
      )`;
      const skipped = new Map<string, boolean>();
      const seen: string[] = [];
      const pageSize = Math.max(limit, 20);
      try {
        for (let page = 0; page < 20 && out.length < limit; page++) {
          const candidates = await db
            .select({ incident: i, monitor: schema.monitor, project: schema.project })
            .from(i)
            .innerJoin(schema.monitor, eq(schema.monitor.id, i.monitorId))
            .innerJoin(schema.project, eq(schema.project.id, schema.monitor.projectId))
            .where(and(lte(i.nextReminderAt, now), isNull(i.acknowledgedAt), isNull(i.resolvedAt), sql`not ${underMaintenance}`, seen.length ? notInArray(i.id, seen) : undefined))
            .orderBy(asc(i.nextReminderAt))
            .limit(pageSize);
          for (const c of candidates) {
            if (out.length >= limit) break;
            seen.push(c.incident.id);
            if (skip) {
              if (!skipped.has(c.monitor.id)) {
                // a failing check of the skip rule must not hold the reminder back: when in doubt, send it
                skipped.set(c.monitor.id, await skip(c.monitor).catch((e) => (console.error("reminder skip check failed, not skipping", e), false)));
              }
              if (skipped.get(c.monitor.id)) continue;
            }
            const interval = c.project.reminderIntervalMin;
            const last = c.incident.reminderCount + 1 >= MAX_REMINDERS;
            // One conditional UPDATE decides who sends: it only matches the exact count and due time that were read, so a
            // second worker sees no row. The next repeat is counted from now, which folds any missed intervals into this one.
            const res = await db
              .update(i)
              .set(
                interval
                  ? { reminderCount: sql`${i.reminderCount} + 1`, nextReminderAt: last ? null : sql`date_add(${now}, interval ${interval} minute)` }
                  : { nextReminderAt: null },
              )
              .where(and(eq(i.id, c.incident.id), eq(i.reminderCount, c.incident.reminderCount), lte(i.nextReminderAt, now), isNull(i.acknowledgedAt), isNull(i.resolvedAt)));
            if (affected(res) === 0) continue;
            const [won] = await db.select().from(i).where(eq(i.id, c.incident.id));
            // repeats switched off since the incident opened: the clock is simply cleared
            if (won && interval) out.push({ incident: won, monitor: c.monitor, project: { reminderIntervalMin: interval, reminderEmail: c.project.reminderEmail, escalation: c.project.escalation }, number: won.reminderCount });
          }
          if (candidates.length < pageSize) break;
        }
      } catch (e) {
        // rows already claimed have used up their repeat: hand them back to be sent rather than lose them with the error
        console.error("claiming reminders stopped early", e);
      }
      return out as unknown as ReminderDue[];
    },
    async claimEscalations(limit) {
      const i = schema.incident;
      const candidates = await db
        .select({ incident: i, monitor: schema.monitor, project: schema.project })
        .from(i)
        .innerJoin(schema.monitor, eq(schema.monitor.id, i.monitorId))
        .innerJoin(schema.project, eq(schema.project.id, schema.monitor.projectId))
        .where(and(lte(i.nextEscalationAt, now), isNull(i.acknowledgedAt), isNull(i.resolvedAt)))
        .orderBy(asc(i.nextEscalationAt))
        .limit(limit);
      const out: EscalationDue[] = [];
      for (const c of candidates) {
        const steps = c.project.escalation;
        const step = steps[c.incident.escalationLevel];
        const after = steps[c.incident.escalationLevel + 1];
        const res = await db
          .update(i)
          .set({ escalationLevel: sql`${i.escalationLevel} + 1`, nextEscalationAt: after ? new Date(c.incident.startedAt.getTime() + after.escalateAfterMin * 60_000) : null })
          .where(and(eq(i.id, c.incident.id), eq(i.escalationLevel, c.incident.escalationLevel), lte(i.nextEscalationAt, now), isNull(i.acknowledgedAt), isNull(i.resolvedAt)));
        if (affected(res) === 0) continue;
        const [won] = await db.select().from(i).where(eq(i.id, c.incident.id));
        // the step list was shortened since: nothing to send, the clock is cleared above
        if (won && step) out.push({ incident: won, monitor: c.monitor, step, level: won.escalationLevel });
      }
      return out;
    },
    async getProjectAlerting(orgId, projectId) {
      const [p] = await db.select().from(schema.project).where(and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId)));
      return p ? { reminderIntervalMin: p.reminderIntervalMin, reminderEmail: p.reminderEmail, escalation: p.escalation } : null;
    },
    async saveProjectAlerting(orgId, projectId, v) {
      const where = and(eq(schema.project.id, projectId), eq(schema.project.organizationId, orgId));
      await db.update(schema.project).set(v).where(where);
      const [p] = await db.select().from(schema.project).where(where);
      return p ? { reminderIntervalMin: p.reminderIntervalMin, reminderEmail: p.reminderEmail, escalation: p.escalation } : null;
    },
    listDeliveries: (orgId, projectId, o) =>
      db
        .select()
        .from(schema.alertDelivery)
        .where(
          and(
            eq(schema.alertDelivery.organizationId, orgId),
            or(eq(schema.alertDelivery.projectId, projectId), isNull(schema.alertDelivery.projectId)),
            o.before ? lt(schema.alertDelivery.createdAt, o.before) : undefined,
          ),
        )
        .orderBy(desc(schema.alertDelivery.createdAt))
        .limit(o.limit),
    async subscribersFor(orgId, monitorId, projectId) {
      const base = db
        .select({ email: schema.statusSubscriber.email, locale: schema.statusSubscriber.locale, token: schema.statusSubscriber.token, slug: schema.statusPage.slug, title: schema.statusPage.title, hideBranding: schema.statusPage.hideBranding, monitorIds: schema.statusSubscriber.monitorIds })
        .from(schema.statusSubscriber)
        .innerJoin(schema.statusPage, eq(schema.statusPage.id, schema.statusSubscriber.statusPageId));
      // a manual incident has no monitor: it reaches only the pages of its own project (a page without one counts as the oldest project's)
      if (!monitorId) {
        const pid = projectId ?? null;
        const pageProject = sql`coalesce(${schema.statusPage.projectId}, (select p.id from project p where p.organization_id = ${schema.statusPage.organizationId} order by p.created_at, p.id limit 1))`;
        return base.where(and(eq(schema.statusPage.organizationId, orgId), isNotNull(schema.statusSubscriber.confirmedAt), sql`${pageProject} <=> ${pid}`));
      }
      return base
        .innerJoin(
          schema.statusPageComponent,
          and(eq(schema.statusPageComponent.statusPageId, schema.statusPage.id), eq(schema.statusPageComponent.monitorId, monitorId), eq(schema.statusPageComponent.visible, true)),
        )
        .where(
          and(
            isNotNull(schema.statusSubscriber.confirmedAt),
            // a subscriber who picked components only hears about those
            or(sql`json_length(${schema.statusSubscriber.monitorIds}) = 0`, sql`json_contains(${schema.statusSubscriber.monitorIds}, json_quote(${monitorId}))`),
          ),
        );
    },
    async getSettings(orgId) {
      const [row] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgId));
      return {
        alertLogRetentionDays: row?.alertLogRetentionDays ?? DEFAULT_ALERT_LOG_DAYS,
        checkRetentionDays: row?.checkRetentionDays ?? DEFAULT_CHECK_RETENTION_DAYS,
        monthlyReport: row?.monthlyReport ?? false,
      };
    },
    async saveSettings(orgId, patch) {
      await db
        .insert(schema.workspaceSetting)
        .values({ organizationId: orgId, ...patch })
        .onDuplicateKeyUpdate({ set: patch });
      const [row] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgId));
      return { alertLogRetentionDays: row.alertLogRetentionDays, checkRetentionDays: row.checkRetentionDays, monthlyReport: row.monthlyReport };
    },

    listMaintenance: (orgId, projectId) =>
      db.select().from(schema.maintenanceWindow)
        .where(and(eq(schema.maintenanceWindow.organizationId, orgId), eq(schema.maintenanceWindow.projectId, projectId)))
        .orderBy(sql`case when ${schema.maintenanceWindow.endsAt} >= ${now} then 0 else 1 end`, sql`abs(timestampdiff(second, ${now}, ${schema.maintenanceWindow.startsAt}))`)
        .limit(1000),
    async createMaintenance(orgId, projectId, w) {
      if (!w.recurrence) {
        const id = newId();
        await db.insert(schema.maintenanceWindow).values({ ...w, id, organizationId: orgId, projectId, createdAt: new Date() });
        const [row] = await db.select().from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.id, id));
        return row!;
      }
      const { frequency, timeZone, until } = w.recurrence;
      // Materialize the bounded series atomically: every occurrence has its own stable reminder/ICS identity.
      // MySQL installs usually have no timezone tables, so the local calendar walk runs in Node with Intl.
      const stepDays = frequency === "weekly" ? 7 : 1;
      const duration = w.endsAt.getTime() - w.startsAt.getTime();
      const zoneParts = (date: Date) => {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).formatToParts(date);
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
        return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
      };
      const offset = (date: Date) => {
        const p = zoneParts(date);
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
      };
      // A skipped local time keeps the pre-transition offset (moves forward); a repeated one picks the later instant.
      const fromZone = (year: number, month: number, day: number, hour: number, minute: number) => {
        const base = Date.UTC(year, month - 1, day, hour, minute, 0);
        // Probe a day either side of the wall clock so both offsets around a transition are known; one valid
        // instant per offset means a local time that happens twice has both candidates.
        const offsets = [...new Set([base - 86_400_000, base, base + 86_400_000].map((t) => offset(new Date(t))))];
        const candidates = offsets.map((off) => base - off);
        const valid = candidates.filter((at) => {
          const p = zoneParts(new Date(at));
          return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
        });
        // A local time that happens twice takes the later instant. A skipped one has no valid instant: keeping the
        // pre-transition (smaller) offset moves it forward past the gap.
        return new Date(valid.length ? Math.max(...valid) : base - Math.min(...offsets));
      };
      const first = zoneParts(w.startsAt);
      const untilMs = new Date(until).getTime();
      const starts: number[] = [w.startsAt.getTime()];
      for (let n = 1; n <= 366; n++) {
        const local = new Date(Date.UTC(first.year, first.month - 1, first.day + n * stepDays));
        const at = fromZone(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), first.hour, first.minute);
        if (at.getTime() > untilMs) break;
        starts.push(at.getTime());
      }
      const seriesId = crypto.randomUUID();
      const values = [...new Set(starts)].map((start) => ({ ...w, id: newId(), organizationId: orgId, projectId, seriesId, startsAt: new Date(start), endsAt: new Date(start + duration), createdAt: new Date() }));
      await db.insert(schema.maintenanceWindow).values(values);
      return values.sort((a, b) => +a.startsAt - +b.startsAt)[0]!;
    },
    async endMaintenance(orgId, id, scope) {
      // The database clock, not the application's: a worker whose clock is behind must not push the end into the past.
      await db.update(schema.maintenanceWindow).set({ endsAt: now })
        .where(and(eq(schema.maintenanceWindow.id, id), eq(schema.maintenanceWindow.organizationId, orgId), inScope(scope, schema.maintenanceWindow.projectId), lte(schema.maintenanceWindow.startsAt, now), gte(schema.maintenanceWindow.endsAt, now)));
    },
    async cancelMaintenanceSeries(orgId, seriesId, scope) {
      await db.transaction(async (tx) => {
        const owned = and(eq(schema.maintenanceWindow.organizationId, orgId), eq(schema.maintenanceWindow.seriesId, seriesId), inScope(scope, schema.maintenanceWindow.projectId));
        await tx.delete(schema.maintenanceWindow).where(and(owned, gte(schema.maintenanceWindow.startsAt, now)));
        await tx.update(schema.maintenanceWindow).set({ endsAt: now }).where(and(owned, lt(schema.maintenanceWindow.startsAt, now), gte(schema.maintenanceWindow.endsAt, now)));
      });
    },
    async deleteMaintenance(orgId, id, scope) {
      await db
        .delete(schema.maintenanceWindow)
        .where(and(eq(schema.maintenanceWindow.id, id), eq(schema.maintenanceWindow.organizationId, orgId), inScope(scope, schema.maintenanceWindow.projectId)));
    },

    // ── status pages ───────────────────────────────────────────────────────────
    listStatusPages: (orgId, projectId) =>
      db.select().from(schema.statusPage).where(and(eq(schema.statusPage.organizationId, orgId), eq(schema.statusPage.projectId, projectId))),
    async getStatusPage(orgId, id, scope) {
      const [page] = await db
        .select()
        .from(schema.statusPage)
        .where(and(eq(schema.statusPage.id, id), eq(schema.statusPage.organizationId, orgId), inScope(scope, schema.statusPage.projectId)));
      return page ?? null;
    },
    async slugTaken(slug) {
      const [t] = await db.select({ id: schema.statusPage.id }).from(schema.statusPage).where(eq(schema.statusPage.slug, slug));
      return !!t;
    },
    async createStatusPage(orgId, projectId, p) {
      const id = newId();
      await db.insert(schema.statusPage).values({ ...p, id, organizationId: orgId, projectId });
      const [page] = await db.select().from(schema.statusPage).where(eq(schema.statusPage.id, id));
      return page;
    },
    async updateStatusPage(id, patch) {
      if (Object.keys(patch).length) await db.update(schema.statusPage).set(patch).where(eq(schema.statusPage.id, id));
    },
    async deleteStatusPage(id) {
      await db.delete(schema.statusPage).where(eq(schema.statusPage.id, id));
    },
    pageComponents: (pageId) =>
      db
        .select({ monitorId: schema.statusPageComponent.monitorId, groupName: schema.statusPageComponent.groupName })
        .from(schema.statusPageComponent)
        .where(eq(schema.statusPageComponent.statusPageId, pageId))
        .orderBy(asc(schema.statusPageComponent.position)),
    async setPageComponents(pageId, orgId, comps, scope) {
      await db.delete(schema.statusPageComponent).where(eq(schema.statusPageComponent.statusPageId, pageId));
      if (!comps.length) return;
      const ok = new Set(await repo.ownedMonitorIds(orgId, comps.map((x) => x.monitorId), scope));
      const list = comps
        .filter((x) => ok.has(x.monitorId))
        .map((x, position) => ({ id: newId(), statusPageId: pageId, monitorId: x.monitorId, position, ...(x.groupName ? { groupName: x.groupName } : {}) }));
      if (list.length) await db.insert(schema.statusPageComponent).values(list);
    },
    listSubscribers: (pageId) =>
      db
        .select({ id: schema.statusSubscriber.id, email: schema.statusSubscriber.email, confirmedAt: schema.statusSubscriber.confirmedAt, createdAt: schema.statusSubscriber.createdAt })
        .from(schema.statusSubscriber)
        .where(eq(schema.statusSubscriber.statusPageId, pageId))
        .orderBy(desc(schema.statusSubscriber.createdAt))
        .limit(1000),
    async deleteSubscriber(pageId, subscriberId) {
      await db.delete(schema.statusSubscriber).where(and(eq(schema.statusSubscriber.id, subscriberId), eq(schema.statusSubscriber.statusPageId, pageId)));
    },

    async statusPageBySlug(slug) {
      const [page] = await db.select().from(schema.statusPage).where(eq(schema.statusPage.slug, slug));
      return page ?? null;
    },
    async statusBoard(page) {
      const projectId = await pageProjectId(page);
      // Everything below selects the page's monitors itself, so the reads run together instead of one after another.
      const shown = db
        .select({ id: schema.statusPageComponent.monitorId })
        .from(schema.statusPageComponent)
        .where(and(eq(schema.statusPageComponent.statusPageId, page.id), eq(schema.statusPageComponent.visible, true)));
      const mine = inArray(schema.checkRollup.monitorId, shown);

      // 90 buckets: daily for the last 90 days, or hourly while the history is still short
      // (otherwise one bad day at launch paints the whole bar red even after recovery)
      const series = (unit: "hour" | "day", since: Date) =>
        db
          .select({
            monitorId: schema.checkRollup.monitorId,
            day: sql<string>`date_format(${schema.checkRollup.bucket}, ${sql.raw(unit === "hour" ? `'%Y-%m-%dT%H'` : `'%Y-%m-%d'`)})`,
            total: sql<number>`cast(sum(${schema.checkRollup.total}) as signed)`,
            ok: sql<number>`cast(sum(${schema.checkRollup.ok}) as signed)`,
          })
          .from(schema.checkRollup)
          .where(and(mine, gte(schema.checkRollup.bucket, since)))
          .groupBy(schema.checkRollup.monitorId, sql`date_format(${schema.checkRollup.bucket}, ${sql.raw(unit === "hour" ? `'%Y-%m-%dT%H'` : `'%Y-%m-%d'`)})`)
          .orderBy(sql`date_format(${schema.checkRollup.bucket}, ${sql.raw(unit === "hour" ? `'%Y-%m-%dT%H'` : `'%Y-%m-%d'`)})`);
      const [comps, firstRows, hourlyDays, dailyDays, open] = await Promise.all([
        db
          .select({ c: schema.statusPageComponent, m: schema.monitor })
          .from(schema.statusPageComponent)
          .innerJoin(schema.monitor, eq(schema.monitor.id, schema.statusPageComponent.monitorId))
          .where(and(eq(schema.statusPageComponent.statusPageId, page.id), eq(schema.statusPageComponent.visible, true)))
          .orderBy(asc(schema.statusPageComponent.position)),
        db.select({ at: sql<string | null>`date_format(min(${schema.checkRollup.bucket}), '%Y-%m-%dT%H:%i:%sZ')` }).from(schema.checkRollup).where(mine),
        series("hour", new Date(Date.now() - 90 * 36e5)),
        series("day", new Date(Date.now() - 90 * 864e5)),
        db
          .select()
          .from(schema.incident)
          .where(and(pageScope(page.organizationId, projectId, shown), isNull(schema.incident.resolvedAt)))
          .orderBy(desc(schema.incident.startedAt)),
      ]);
      const first = firstRows[0]?.at;
      const hourly = !first || Date.now() - new Date(first).getTime() < 4 * 864e5;
      const unit = hourly ? "hour" : "day";
      const days = hourly ? hourlyDays : dailyDays;

      return {
        bucket: unit,
        components: comps.map(({ c, m }) => {
          const mine = days.filter((d) => d.monitorId === m.id);
          const total = mine.reduce((a, d) => a + Number(d.total), 0);
          const ok = mine.reduce((a, d) => a + Number(d.ok), 0);
          // the last n daily buckets, today included; hourly history is too short for these
          const recent = (n: number) => {
            if (hourly || m.type === "domain") return null;
            const since = new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10);
            const r = mine.filter((d) => d.day >= since);
            const t = r.reduce((a, d) => a + Number(d.total), 0);
            return t ? Math.round((r.reduce((a, d) => a + Number(d.ok), 0) / t) * 10000) / 100 : null;
          };
          return {
            id: m.id,
            name: m.name,
            group: c.groupName,
            status: publicMonitorStatus(m),
            // Registration checks are not service uptime samples.
            uptime90d: m.type === "domain" ? null : total ? Math.round((ok / total) * 10000) / 100 : null,
            uptime7d: recent(7),
            uptime30d: recent(30),
            days: m.type === "domain" ? [] : mine.map((d) => ({ day: d.day, uptime: Number(d.total) ? Number(d.ok) / Number(d.total) : 1 })),
          };
        }),
        incidents: await withUpdates(open),
      };
    },
    async pageIncidents(page, o) {
      const list = await db
        .select()
        .from(schema.incident)
        .where(
          and(
            pageScope(page.organizationId, await pageProjectId(page), await pageMonitorIds(page.id)),
            o.before ? lt(schema.incident.startedAt, o.before) : undefined,
            // open at some point in [from, to): started before its end and not resolved before its start
            o.overlapping ? and(lt(schema.incident.startedAt, o.overlapping.to), or(isNull(schema.incident.resolvedAt), gte(schema.incident.resolvedAt, o.overlapping.from))) : undefined,
          ),
        )
        .orderBy(desc(schema.incident.startedAt))
        .limit(o.limit);
      return withUpdates(list);
    },
    async subscriberCount(pageId) {
      const [r] = await db.select({ n: sql<number>`cast(count(*) as signed)` }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.statusPageId, pageId));
      return Number(r.n);
    },
    async addSubscriber(s) {
      const monitorIds = s.monitorIds ?? [];
      return db.transaction(async (tx) => {
        // INSERT ... ON DUPLICATE KEY UPDATE claims the row without a lost-insert race; affectedRows tells creation.
        const res = await tx.insert(schema.statusSubscriber)
          .values({ id: newId(), statusPageId: s.pageId, email: s.email, token: s.token, locale: s.locale, monitorIds })
          .onDuplicateKeyUpdate({ set: { email: sql`email` } });
        const [old] = await tx
          .select()
          .from(schema.statusSubscriber)
          .where(and(eq(schema.statusSubscriber.statusPageId, s.pageId), eq(schema.statusSubscriber.email, s.email)))
          .for("update");
        if (!old) throw new Error("subscriber insert disappeared");
        if (affected(res) > 0) return { locale: old.locale, token: old.token, confirmed: false, created: true };
        // A pending row takes the newest language and component choice: the confirmation mail is the consent, and the
        // person who asked again is the one holding the link. A confirmed row is never touched by a form anyone can submit.
        if (!old.confirmedAt) {
          await tx
            .update(schema.statusSubscriber)
            .set({ locale: s.locale, monitorIds })
            .where(and(eq(schema.statusSubscriber.id, old.id), isNull(schema.statusSubscriber.confirmedAt)));
          return { locale: s.locale, token: old.token, confirmed: false, created: false };
        }
        return { locale: old.locale, token: old.token, confirmed: true, created: false };
      });
    },
    async pageMaintenance(page, o) {
      const ids = await pageMonitorIds(page.id);
      const projectId = await pageProjectId(page);
      return db
        .select()
        .from(schema.maintenanceWindow)
        .where(
          and(
            eq(schema.maintenanceWindow.organizationId, page.organizationId),
            projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, projectId)) : isNull(schema.maintenanceWindow.projectId),
            o.since ? gte(schema.maintenanceWindow.endsAt, o.since) : undefined,
            ids.length
              ? or(sql`json_length(${schema.maintenanceWindow.monitorIds}) = 0`, or(...ids.map((id) => sql`json_contains(${schema.maintenanceWindow.monitorIds}, json_quote(${id}))`)))
              : sql`json_length(${schema.maintenanceWindow.monitorIds}) = 0`,
          ),
        )
        .orderBy(sql`case when ${schema.maintenanceWindow.endsAt} >= ${now} then 0 else 1 end`, sql`abs(timestampdiff(second, ${now}, ${schema.maintenanceWindow.startsAt}))`)
        .limit(o.limit);
    },
    async claimMaintenanceReminders(limit) {
      const at = new Date();
      const due = await db
        .select({ w: schema.maintenanceWindow, p: schema.statusPage })
        .from(schema.maintenanceWindow)
        .innerJoin(
          schema.statusPage,
          and(
            eq(schema.statusPage.organizationId, schema.maintenanceWindow.organizationId),
            or(
              isNull(schema.maintenanceWindow.projectId),
              // a page without a project belongs to the workspace's oldest one, as everywhere else
              eq(schema.maintenanceWindow.projectId, sql`coalesce(${schema.statusPage.projectId}, (select p.id from project p where p.organization_id = ${schema.statusPage.organizationId} order by p.created_at, p.id limit 1))`),
            ),
          ),
        )
        .where(
          and(
            sql`${schema.statusPage.maintenanceReminderHours} > 0`,
            gte(schema.maintenanceWindow.startsAt, at),
            sql`${schema.maintenanceWindow.startsAt} <= date_add(${now}, interval ${schema.statusPage.maintenanceReminderHours} hour)`,
            sql`not exists (select 1 from maintenance_reminder r where r.maintenance_id = ${schema.maintenanceWindow.id} and r.status_page_id = ${schema.statusPage.id})`,
            // nobody to remind: leave the window unclaimed, so a subscriber who joins later still hears about it. Tested here, not
            // after the limit, so windows nobody follows cannot crowd out ones somebody does.
            sql`exists (
              select 1 from status_subscriber s
              where s.status_page_id = ${schema.statusPage.id} and s.confirmed_at is not null
                and (json_length(s.monitor_ids) = 0 or exists (
                  select 1 from status_page_component c
                  where c.status_page_id = ${schema.statusPage.id} and c.visible and json_contains(s.monitor_ids, json_quote(c.monitor_id))
                    and (json_length(${schema.maintenanceWindow.monitorIds}) = 0 or json_contains(${schema.maintenanceWindow.monitorIds}, json_quote(c.monitor_id)))
                ))
            )`,
            or(
              sql`json_length(${schema.maintenanceWindow.monitorIds}) = 0`,
              sql`exists (select 1 from status_page_component c where c.status_page_id = ${schema.statusPage.id} and c.visible and json_contains(${schema.maintenanceWindow.monitorIds}, json_quote(c.monitor_id)))`,
            ),
          ),
        )
        .limit(limit);
      const out: Awaited<ReturnType<Repo["claimMaintenanceReminders"]>> = [];
      for (const { w, p } of due) {
        const affectedIds = w.monitorIds.length ? new Set(w.monitorIds) : null;
        const shown = new Set(await pageMonitorIds(p.id));
        const subs = await db
          .select()
          .from(schema.statusSubscriber)
          .where(and(eq(schema.statusSubscriber.statusPageId, p.id), isNotNull(schema.statusSubscriber.confirmedAt)));
        const subscribers = subs
          .filter((x) => !x.monitorIds.length || x.monitorIds.some((m) => shown.has(m) && (!affectedIds || affectedIds.has(m))))
          .map((x) => ({ email: x.email, locale: x.locale, token: x.token, slug: p.slug, title: p.title, hideBranding: p.hideBranding, monitorIds: x.monitorIds }));
        if (!subscribers.length) continue;
        // inserting the row is the claim: whoever gets it back sends, anyone else skips
        const res = await db.insert(schema.maintenanceReminder).values({ maintenanceId: w.id, statusPageId: p.id })
          .onDuplicateKeyUpdate({ set: { maintenanceId: sql`maintenance_id` } });
        if (affected(res) === 0) continue;
        out.push({ window: w, page: p, subscribers });
      }
      return out;
    },
    async releaseMaintenanceReminder(maintenanceId, statusPageId) {
      await db.delete(schema.maintenanceReminder).where(and(eq(schema.maintenanceReminder.maintenanceId, maintenanceId), eq(schema.maintenanceReminder.statusPageId, statusPageId)));
    },
    async claimMonthlyReports(month, limit) {
      return db.transaction(async (tx) => {
        const rows_ = await tx.select({ organizationId: schema.workspaceSetting.organizationId }).from(schema.workspaceSetting)
          .where(and(eq(schema.workspaceSetting.monthlyReport, true), sql`not (${schema.workspaceSetting.lastReportMonth} <=> ${month})`))
          .limit(limit).for("update", { skipLocked: true });
        if (!rows_.length) return [];
        await tx.update(schema.workspaceSetting).set({ lastReportMonth: month }).where(inArray(schema.workspaceSetting.organizationId, rows_.map((r) => r.organizationId)));
        return rows_.map((r) => r.organizationId);
      });
    },
    async monthlyReport(orgId, from, to) {
      const comps = await db.select().from(schema.monitor).where(eq(schema.monitor.organizationId, orgId)).orderBy(asc(schema.monitor.name));
      if (!comps.length) return [];
      const ids = comps.map((m) => m.id);
      const [sums, incs] = await Promise.all([
        db
          .select({ monitorId: schema.checkRollup.monitorId, total: sql<number>`cast(sum(${schema.checkRollup.total}) as signed)`, ok: sql<number>`cast(sum(${schema.checkRollup.ok}) as signed)` })
          .from(schema.checkRollup)
          .where(and(inArray(schema.checkRollup.monitorId, ids), gte(schema.checkRollup.bucket, from), lt(schema.checkRollup.bucket, to)))
          .groupBy(schema.checkRollup.monitorId),
        db
          .select()
          .from(schema.incident)
          .where(and(inArray(schema.incident.monitorId, ids), lt(schema.incident.startedAt, to), or(isNull(schema.incident.resolvedAt), gte(schema.incident.resolvedAt, from)))),
      ]);
      return comps
        .map((m) => {
          const s = sums.find((x) => x.monitorId === m.id);
          const mine = incs.filter((i) => i.monitorId === m.id);
          const downMs = mine.reduce((a, i) => a + Math.max(0, Math.min(i.resolvedAt?.getTime() ?? to.getTime(), to.getTime()) - Math.max(i.startedAt.getTime(), from.getTime())), 0);
          return { name: m.name, uptime: Number(s?.total) ? Math.round((Number(s?.ok ?? 0) / Number(s?.total ?? 1)) * 10000) / 100 : null, downtimeMinutes: Math.round(downMs / 60000), incidents: mine.length, checked: !!Number(s?.total) };
        })
        .filter((c) => c.checked || c.incidents > 0)
        .map(({ checked: _c, ...c }) => c);
    },
    async ownerContacts(orgId) {
      return db
        .select({ email: schema.user.email, locale: schema.user.locale })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    },
    async confirmSubscriber(token) {
      const res = await db
        .update(schema.statusSubscriber)
        .set({ confirmedAt: new Date() })
        .where(and(eq(schema.statusSubscriber.token, token), isNull(schema.statusSubscriber.confirmedAt)));
      const [r] = affected(res) > 0
        ? await db.select({ pageId: schema.statusSubscriber.statusPageId }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token))
        : [];
      const pageId =
        r?.pageId ?? (await db.select({ p: schema.statusSubscriber.statusPageId }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token)))[0]?.p;
      if (!pageId) return null;
      const [page] = await db.select({ slug: schema.statusPage.slug }).from(schema.statusPage).where(eq(schema.statusPage.id, pageId));
      return page?.slug ?? null;
    },
    async removeSubscriber(token) {
      const [found] = await db.select({ pageId: schema.statusSubscriber.statusPageId }).from(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token));
      if (!found) return null;
      await db.delete(schema.statusSubscriber).where(eq(schema.statusSubscriber.token, token));
      const [page] = await db.select({ slug: schema.statusPage.slug }).from(schema.statusPage).where(eq(schema.statusPage.id, found.pageId));
      return page?.slug ?? null;
    },
  };
  return repo;
}
