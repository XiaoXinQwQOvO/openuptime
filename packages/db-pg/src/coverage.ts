import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Monitor, Scope, TimeCoverage } from "@openuptime/repo";
import type { DbExecutor as Db } from "./client";
import * as schema from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const rawRows = (r: unknown): unknown[] => (Array.isArray(r) && Array.isArray((r as unknown[])[0]) ? ((r as unknown[])[0] as unknown[]) : (r as unknown[]));

/**
 * Raw aggregate expressions (`max(observed_at)`, `now(3)`) come back as strings, not as the driver's UTC Date.
 * `new Date("2026-10-28 12:00:10.000")` would parse that text in the host time zone, so append the UTC designator.
 */
const asUtcDate = (value: Date | string): Date => {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[TZ]/.test(text) ? text : `${text.replace(" ", "T")}Z`);
};

/** Bound application clock skew by the database clock; repair impossible future events on the next write. */
export async function coverageTime(tx: Tx, monitorId: string, completedAt = new Date()): Promise<Date> {
  // The clock is read once, cut to milliseconds (the precision of the times written after it), then rows after the clock
  // move back to it: the latest observation afterwards is the earlier of the latest one before and the clock.
  const [clock] = rawRows(await tx.execute(sql`select now(3) as at`)) as { at: Date | string }[];
  const at = asUtcDate(clock.at);
  await tx.execute(sql`
    update monitor_observation
    set valid_until = case when valid_until is null then null
        else date_sub(valid_until, interval timestampdiff(microsecond, ${at}, observed_at) microsecond) end,
      observed_at = ${at}
    where monitor_id = ${monitorId} and observed_at > ${at}`);
  const [latest] = rawRows(await tx.execute(sql`select max(observed_at) as at from monitor_observation where monitor_id = ${monitorId}`)) as { at: Date | string | null }[];
  const last = latest?.at == null ? 0 : asUtcDate(latest.at).getTime();
  return new Date(Math.max(Math.min(completedAt.getTime(), at.getTime()), last));
}

export async function recordObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<boolean> {
  return !!(await appendObservation(db, snapshot, result, options));
}

/** A ping is evidence for the current configuration and renews its deadline in the same transaction. */
export function recordHeartbeatObservation(db: Db, snapshot: Monitor): Promise<Monitor | null> {
  return appendObservation(db, snapshot, { ok: true }, { heartbeatPing: true });
}

/** Store the configuration that actually produced the observation. Never re-interpret old data with today's config. */
async function appendObservation(db: Db, snapshot: Monitor, result: { ok: boolean; latencyMs?: number | null; degraded?: boolean }, options: { generation?: number; heartbeatPing?: boolean } = {}): Promise<Monitor | null> {
  // Capture completion before waiting on the lock: database congestion must not extend freshness.
  const completedAt = new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, snapshot.id)).for("update");
    if (!current || current.paused || (!options.heartbeatPing && current.coverageRevision !== (snapshot.coverageRevision ?? 0))) return null;
    if (options.heartbeatPing && current.type !== "heartbeat") return null;
    const generation = options.generation;
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0 || generation > current.runGeneration || generation <= current.coverageGeneration)) return null;
    const at = await coverageTime(tx, current.id, completedAt);
    // Only a failed scheduled heartbeat check compares itself with the last observation.
    const [last] = current.type === "heartbeat" && !options.heartbeatPing && !result.ok
      ? await tx.select().from(schema.monitorObservation).where(eq(schema.monitorObservation.monitorId, snapshot.id))
        .orderBy(desc(schema.monitorObservation.observedAt), desc(schema.monitorObservation.id)).limit(1)
      : [];
    // The ping fence is committed with the observation, not the later mutable lastCheckedAt/incident updates.
    if (current.type === "heartbeat" && !options.heartbeatPing && current.coverageHeartbeatVersion !== (snapshot.coverageHeartbeatVersion ?? 0)) return null;
    // A scheduler may load the new ping version before the ping handler updates nextCheckAt.
    // Check the committed observation under the same lock, not that mutable deadline.
    if (current.type === "heartbeat" && !options.heartbeatPing && !result.ok
      && last?.revision === current.coverageRevision && (last.state === "up" || last.state === "degraded")
      && last.validUntil && last.validUntil > at) return null;
    const durationMs = current.type === "heartbeat"
      ? (current.intervalSec + current.graceSec) * 1000
      : current.intervalSec * 1000 + current.timeoutMs + 60_000;
    const windows = await tx.select({ endsAt: schema.maintenanceWindow.endsAt }).from(schema.maintenanceWindow).where(and(
      eq(schema.maintenanceWindow.organizationId, current.organizationId),
      current.projectId ? or(isNull(schema.maintenanceWindow.projectId), eq(schema.maintenanceWindow.projectId, current.projectId)) : isNull(schema.maintenanceWindow.projectId),
      lte(schema.maintenanceWindow.startsAt, at), gt(schema.maintenanceWindow.endsAt, at),
      or(sql`json_length(${schema.maintenanceWindow.monitorIds}) = 0`, sql`json_contains(${schema.maintenanceWindow.monitorIds}, json_quote(${current.id}))`),
    ));
    const maintenanceUntil = windows.length ? new Date(Math.max(...windows.map((w) => w.endsAt.getTime()))) : null;
    await tx.insert(schema.monitorObservation).values({
      monitorId: current.id, observedAt: at,
      state: !result.ok ? "down" : result.degraded || (result.latencyMs != null && result.latencyMs > current.slowThresholdMs) ? "degraded" : "up",
      validUntil: new Date(at.getTime() + durationMs), maintenanceUntil,
      revision: current.coverageRevision, generation, intervalSec: current.intervalSec, graceSec: current.graceSec, timeoutMs: current.timeoutMs,
    });
    if (options.heartbeatPing) {
      await tx.update(schema.monitor).set({
        coverageHeartbeatVersion: current.coverageHeartbeatVersion + 1,
        consecutiveSuccesses: sql`least(${schema.monitor.consecutiveSuccesses} + 1, ${schema.monitor.recoveryThreshold})`,
        consecutiveFailures: 0, lastCheckedAt: at,
        nextCheckAt: sql`date_add(now(3), interval ${schema.monitor.intervalSec} + ${schema.monitor.graceSec} second)`,
        status: current.status === "down" ? "down" : "up",
        ...(current.status !== "down" && current.status !== "up" ? { statusChangedAt: at } : {}),
      }).where(eq(schema.monitor.id, current.id));
      const [updated] = await tx.select().from(schema.monitor).where(eq(schema.monitor.id, current.id));
      return updated;
    }
    if (generation !== undefined) await tx.update(schema.monitor).set({
      ...(generation !== undefined ? { coverageGeneration: generation } : {}),
    }).where(eq(schema.monitor.id, current.id));
    return current;
  });
}

/** Aggregate in MySQL, avoiding a month's raw observations in Worker memory. */
export async function timeCoverage(db: Db, orgId: string, monitorId: string, scope: Scope, days: 7 | 30, now = new Date()): Promise<TimeCoverage | null> {
  if (days !== 7 && days !== 30) throw new Error("Coverage window must be 7 or 30 days");
  const [m] = await db.select({ id: schema.monitor.id }).from(schema.monitor).where(and(eq(schema.monitor.id, monitorId), eq(schema.monitor.organizationId, orgId), scope ? inArray(schema.monitor.projectId, scope) : undefined));
  if (!m) return null;
  const from = new Date(now.getTime() - days * 86_400_000);
  const values = rawRows(await db.execute(sql`
    with events as (
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at < ${from} order by observed_at desc, id desc limit 1)
      union all
      (select * from monitor_observation where monitor_id = ${monitorId} and observed_at >= ${from} and observed_at < ${now})
    ), spans as (
      select state, maintenance_until, greatest(observed_at, ${from}) as lo,
        least(coalesce(lead(observed_at) over (order by observed_at, id), ${now}), coalesce(valid_until, ${now}), ${now}) as hi
      from events
    ) select state, coalesce(sum(greatest(0, timestampdiff(microsecond, lo, hi) / 1000)), 0) as ms,
      coalesce(sum(case when maintenance_until is not null then greatest(0, timestampdiff(microsecond, lo, least(hi, maintenance_until)) / 1000) else 0 end), 0) as maintenance_ms
      from spans group by state`)) as { state: string; ms: number; maintenance_ms: number }[];
  const totalMs = now.getTime() - from.getTime();
  const states = { up: 0, down: 0, degraded: 0, paused: 0, unknown: 0 };
  let observedMaintenanceMs = 0;
  for (const row of values) {
    const state = String(row.state);
    if (state === "up" || state === "down" || state === "degraded" || state === "paused") states[state] = Number(row.ms);
    observedMaintenanceMs += Number(row.maintenance_ms);
  }
  // Everything without a still-valid observation is unknown, including time before this feature was deployed.
  states.unknown = Math.max(0, totalMs - states.up - states.down - states.degraded - states.paused);
  return { from: from.toISOString(), to: now.toISOString(), totalMs, states, observedMaintenanceMs, policy: "bounded-observation-v1" };
}