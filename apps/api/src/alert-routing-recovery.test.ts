import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, createRepo, eq, inArray, migrate, schema } from "@openuptime/db-pg";
import { dispatchAlert, retryDeliveries } from "./alerts";
import { sendEmail } from "./email";
import { unmetered } from "./entitlements";

vi.mock("./email", async (original) => ({ ...await original<typeof import("./email")>(), sendEmail: vi.fn(async () => {}) }));
const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url, { max: 2 }) : undefined!;
const repo = url ? createRepo(db) : undefined!;
/** MySQL inserts cannot return the written row; tests give it an id and read it back. */
function insertInto(database: typeof db, table: any) {
  return { values(values: any) {
    const list = Array.isArray(values) ? values : [values];
    const withIds = table.id ? list.map((row: any) => ({ id: crypto.randomUUID(), ...row })) : list;
    const query = Promise.resolve(database.insert(table).values((withIds.length === 1 ? withIds[0] : withIds) as never) as PromiseLike<unknown>);
    const returning = async () => {
      const result = await query;
      if (!table.id) return [];
      if (String(table.id.columnType).includes("BigInt")) {
        const head = Array.isArray(result) && !Array.isArray((result as unknown[])[0]) ? (result as unknown[])[0] : result;
        return database.select().from(table).where(eq(table.id, Number((head as any)?.insertId ?? 0)));
      }
      return database.select().from(table).where(inArray(table.id, withIds.map((row: any) => row.id)));
    };
    return { returning, then: (a: any, b: any) => query.then(a, b), catch: (a: any) => query.catch(a), finally: (a: any) => query.finally(a) } as any;
  } };
}

const orgId = `routing-recovery-${crypto.randomUUID()}`;
const marker = "alert routing policy unavailable";
let projectId: string;
let channelId: string;
beforeEach(() => vi.mocked(sendEmail).mockClear());
afterAll(async () => { if (url) { await db.delete(schema.organization).where(eq(schema.organization.id, orgId)); await db.$client.end(); } });

describe.skipIf(!url)("routed email recovery with persisted quota attempts", () => {
  beforeAll(async () => {
    await migrate(db);
    await insertInto(db, schema.organization).values({ id: orgId, name: "Routing", slug: orgId, createdAt: new Date() });
    projectId = (await insertInto(db, schema.project).values({ organizationId: orgId, name: "Project" }).returning())[0].id;
    channelId = (await insertInto(db, schema.alertChannel).values({ organizationId: orgId, projectId, name: "Email", type: "email", config: { to: "fixture@example.com" } }).returning())[0].id;
  });
  async function event() {
    const monitor = (await insertInto(db, schema.monitor).values({ organizationId: orgId, projectId, name: "API", target: "https://example.com" }).returning())[0];
    const incident = (await insertInto(db, schema.incident).values({ organizationId: orgId, projectId, monitorId: monitor.id, title: "Down", severity: "major" }).returning())[0];
    return { kind: "incident.opened" as const, monitor, incident };
  }
  async function interrupted(stage: "before-save" | "before-spend" | "before-send") {
    const ev = await event();
    const [delivery] = await repo.queueDeliveries([{ organizationId: orgId, projectId, channelId, channelName: "Email", channelType: "email", kind: ev.kind, incidentId: ev.incident.id, ok: false, error: marker }]);
    const claimed = (await repo.claimDelivery(delivery.id))!;
    let balance = 1;
    const spend = vi.fn(async (_org: string, count: number) => { const granted = Math.min(balance, count); balance -= granted; return granted; });
    if (stage !== "before-save") expect(await repo.markDeliveryEmailQuotaAttempt(claimed.id, claimed.attempts)).toBe(true);
    if (stage === "before-send") await spend(orgId, 1);
    // The worker disappears here: no provider call and no finishDelivery. Recover the actual PostgreSQL row.
    await db.update(schema.alertDelivery).set({ claimedAt: new Date(Date.now() - 600_000) }).where(eq(schema.alertDelivery.id, delivery.id));
    await repo.sweepStuckDeliveries({ stuckSec: 300, maxAttempts: 3 });
    return { delivery, claimed, spend, balance: () => balance };
  }
  it.each(["before-save", "before-spend", "before-send"] as const)("recovers a crash %s without losing the last allowed email", async (stage) => {
    const t = await interrupted(stage);
    const policy = vi.fn(async () => true);
    await retryDeliveries(repo, 100, { ...unmetered, allowAlertChannel: policy, spendEmails: t.spend });
    expect(policy).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(t.spend).toHaveBeenCalledTimes(stage === "before-spend" ? 0 : 1);
    expect(t.balance()).toBe(stage === "before-spend" ? 1 : 0);
    const [saved] = await db.select().from(schema.alertDelivery).where(eq(schema.alertDelivery.id, t.delivery.id));
    expect(saved).toMatchObject({ status: "sent", emailQuotaAttempted: true });
  });
  it("rechecks routing even after quota was spent, and refuses a stale worker checkpoint", async () => {
    const t = await interrupted("before-send");
    expect(await repo.markDeliveryEmailQuotaAttempt(t.claimed.id, t.claimed.attempts)).toBe(false);
    const policy = vi.fn(async () => false);
    await retryDeliveries(repo, 100, { ...unmetered, allowAlertChannel: policy, spendEmails: t.spend });
    expect(policy).toHaveBeenCalledOnce();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(t.spend).toHaveBeenCalledOnce();
    expect((await db.select().from(schema.alertDelivery).where(eq(schema.alertDelivery.id, t.delivery.id)))[0].status).toBe("skipped");
  });
  it("persists the checkpoint before quota and delivery and keeps authorization pending if persistence fails", async () => {
    const ev = await event();
    const order: string[] = [];
    const checkpoint = vi.spyOn(repo, "markDeliveryEmailQuotaAttempt").mockRejectedValueOnce(new Error("database unavailable"));
    const spend = vi.fn(async () => { order.push("spend"); return 1; });
    const policy = vi.fn(async () => { order.push("authorize"); return true; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dispatchAlert(repo, orgId, ev, [channelId], { ...unmetered, allowAlertChannel: policy, spendEmails: spend });
      expect(spend).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled();
      const [pending] = await repo.incidentDeliveries(orgId, ev.incident.id);
      expect(pending).toMatchObject({ status: "pending", error: marker, emailQuotaAttempted: false });
      checkpoint.mockRestore();
      const mark = repo.markDeliveryEmailQuotaAttempt.bind(repo);
      vi.spyOn(repo, "markDeliveryEmailQuotaAttempt").mockImplementation(async (...args) => { const saved = await mark(...args); order.push("checkpoint"); return saved; });
      await db.update(schema.alertDelivery).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.alertDelivery.id, pending.id));
      await retryDeliveries(repo, 100, { ...unmetered, allowAlertChannel: policy, spendEmails: spend });
      expect(order).toEqual(["authorize", "authorize", "checkpoint", "spend"]);
      expect(sendEmail).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); log.mockRestore(); }
  });
});
