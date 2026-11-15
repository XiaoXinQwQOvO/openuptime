import { createHash } from "node:crypto";
import type { Db } from "./client";
import { validateMigrationHistory } from "./migration-history.mjs";
import { MIGRATIONS } from "./migrations.generated";

const LOCK = "openuptime:migrate";

/**
 * Applies the embedded migrations. MySQL commits DDL implicitly, so unlike the Postgres version this is not one
 * transaction: a named lock keeps instances that start together (or a second /internal/migrate call) from running the
 * same statements, and each migration is recorded only after all of its statements succeeded. `MIGRATIONS` are written
 * so the first migration is idempotent enough to be re-run after a crash.
 */
export async function migrate(db: Db, migrations = MIGRATIONS) {
  const pool = db.$client;
  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query("select get_lock(?, 60) as ok", [LOCK]);
    if (!(lockRows as { ok: number | null }[])[0]?.ok) throw new Error("could not acquire the migration lock");
    await conn.query(
      "create table if not exists __drizzle_migrations (id bigint unsigned not null auto_increment primary key, hash varchar(64) not null, created_at bigint)",
    );
    const [rows] = await conn.query("select created_at, hash from __drizzle_migrations order by id");
    const pending = validateMigrationHistory(migrations, rows as { created_at: string | number | null; hash: string }[]);
    const applied: string[] = [];
    for (const m of pending) {
      for (const stmt of m.sql.split("--> statement-breakpoint")) if (stmt.trim()) await conn.query(stmt);
      await conn.query("insert into __drizzle_migrations (hash, created_at) values (?, ?)", [
        createHash("sha256").update(m.sql).digest("hex"),
        m.when,
      ]);
      applied.push(m.tag);
    }
    return applied;
  } finally {
    await conn.query("select release_lock(?)", [LOCK]).catch(() => undefined);
    conn.release();
  }
}