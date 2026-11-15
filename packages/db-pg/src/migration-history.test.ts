import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateMigrationHistory } from "./migration-history.mjs";
import { createDb } from "./client";
import { migrate } from "./migrate";
const first = { tag: "0000_first", when: 10, sql: "create table first_table(id integer)" };
const second = { tag: "0001_second", when: 20, sql: "create table second_table(id integer)" };
const history = (m: typeof first) => ({ created_at: String(m.when), hash: createHash("sha256").update(m.sql).digest("hex") });
describe("migration history identity", () => {
  it("accepts the exact applied prefix", () => {
    expect(validateMigrationHistory([first, second], [history(first)])).toEqual([second]);
    expect(validateMigrationHistory([first, second], [history(first), history(second)])).toEqual([]);
  });
  it("rejects older or duplicate timestamps and duplicate tags", () => {
    for (const m of [{ ...second, when: 9 }, { ...second, when: 10 }, { ...second, tag: first.tag }]) expect(() => validateMigrationHistory([first, m], [])).toThrow("Invalid migration order");
  });
  it("rejects another branch, changed SQL and a downgraded build", () => {
    expect(() => validateMigrationHistory([first, second], [history(second)])).toThrow("diverges");
    expect(() => validateMigrationHistory([first, second], [history({ ...first, sql: first.sql + ";" })])).toThrow("diverges");
    expect(() => validateMigrationHistory([first], [history(first), history(second)])).toThrow("ahead");
    expect(() => validateMigrationHistory([first], [{ ...history(first), created_at: null }])).toThrow("diverges");
  });
});
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("migration branch mismatch on MySQL", () => {
  it("rejects an older branch instead of silently skipping a missing table", async () => {
    const admin = createDb(url!, { max: 1 });
    const name = `migration_review_${randomUUID().replaceAll("-", "")}`;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await admin.$client.query(`create database \`${name}\``);
      const fresh = new URL(url!); fresh.pathname = `/${name}`;
      db = createDb(fresh.href, { max: 3 });
      const later = { tag: "0001_other", when: 30, sql: "create table later_table(id integer)" };
      await migrate(db, [first, later]);
      await expect(migrate(db, [first, second])).rejects.toThrow("diverges");
      const [tables] = await db.$client.query("select table_name from information_schema.tables where table_schema = database() and table_name = 'second_table'");
      expect((tables as unknown[]).length).toBe(0);
      expect(await migrate(db, [first, later])).toEqual([]);
      const next = { tag: "0002_regenerated", when: 40, sql: second.sql };
      await Promise.all([migrate(db, [first, later, next]), migrate(db, [first, later, next])]);
      const [counts] = await db.$client.query("select count(*) as n from __drizzle_migrations");
      expect(Number((counts as { n: number }[])[0].n)).toBe(3);
    } finally {
      await db?.$client.end();
      await admin.$client.query(`drop database if exists \`${name}\``);
      await admin.$client.end();
    }
  });
});
