import { eq, inArray } from "drizzle-orm";
import type { Db } from "./client";

/**
 * MySQL inserts cannot return the written row. Tests use this wrapper where they used `.returning()` on Postgres:
 * it gives the row an id up front, writes it, and reads the rows back. Composite-key tables return nothing.
 */
export function insertInto(db: Db, table: any) {
  return {
    values(values: unknown) {
      const list = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
      const auto = String(table.id?.columnType ?? "").includes("BigInt");
      const withIds = table.id && !auto ? list.map((row) => ({ ...row })) : list;
      if (table.id && !auto) for (const row of withIds) row.id ??= crypto.randomUUID();
      const query = Promise.resolve(db.insert(table).values((withIds.length === 1 ? withIds[0] : withIds) as never) as PromiseLike<unknown>);
      const returning = async () => {
        const result = await query;
        if (table.id && auto) {
          const head = Array.isArray(result) && !Array.isArray((result as unknown[])[0]) ? (result as unknown[])[0] : result;
          const insertId = Number((head as { insertId?: number } | undefined)?.insertId ?? 0);
          return db.select().from(table).where(eq(table.id, insertId));
        }
        if (!table.id) return [];
        return db.select().from(table).where(inArray(table.id, withIds.map((row) => row.id)));
      };
      const wrapped: any = {
        returning,
        // MySQL has no ON CONFLICT: tests that used the Postgres spelling get the equivalent upsert.
        onConflictDoUpdate: (config: unknown) => (db.insert(table).values((withIds.length === 1 ? withIds[0] : withIds) as never) as any).onDuplicateKeyUpdate(config),
        onDuplicateKeyUpdate: (config: unknown) => (db.insert(table).values((withIds.length === 1 ? withIds[0] : withIds) as never) as any).onDuplicateKeyUpdate(config),
        ignore: () => (db.insert(table).values((withIds.length === 1 ? withIds[0] : withIds) as never) as any).ignore(),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => query.then(resolve, reject),
        catch: (reject: (e: unknown) => unknown) => query.catch(reject),
        finally: (done: () => void) => query.finally(done),
      };
      return wrapped;
    },
  };
}