import type { Database, OpenDatabase } from "@openuptime/repo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { createRepo } from "./repo";
import * as schema from "./schema";

export * from "drizzle-orm";
export { createDb, type Db } from "./client";
export { createRepo } from "./repo";
export { migrate } from "./migrate";
export * as schema from "./schema";

/**
 * Some raw SQL still uses Postgres spellings (`$1` placeholders, `::int` casts, double-quoted identifiers,
 * `now() - interval '1 second'`). Translate the unambiguous ones so a migrated install keeps working; anything
 * genuinely Postgres-only (RETURNING, jsonb_set path syntax) stays visible as an error.
 */
function mySqlText(text: string, params: unknown[]): { text: string; params: unknown[] } {
  let out = text
    .replace(/::\s*(?:int|integer|bigint|smallint|text|boolean|varchar)\b/gi, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "`$1`")
    .replace(/\b(now\(\)|current_timestamp(?:\(\d+\))?)\s*([-+])\s*interval\s*'([^']+)'/gi,
      (_match, clock: string, sign: string, span: string) => {
        // MySQL takes the singular unit: `interval 10 minute`, not `interval 10 minutes`.
        const unit = span.replace(/\b(seconds|minutes|hours|days|weeks|months|years)\b/gi, (u) => u.replace(/s$/i, ""));
        return `${sign === "-" ? "date_sub" : "date_add"}(${clock}, interval ${unit})`;
      });
  if (!/\$\d+/.test(out)) return { text: out, params };
  const ordered: unknown[] = [];
  out = out.replace(/\$(\d+)/g, (_match, n: string) => {
    ordered.push(params[Number(n) - 1]);
    return "?";
  });
  return { text: out, params: ordered };
}

/** The MySQL backend: opens one connection pool and exposes it as a `Database`. */
export const openDatabase: OpenDatabase = (connectionString, opts) => {
  const db = createDb(connectionString, opts);
  const database: Database = {
    repo: createRepo(db),
    authDatabase: drizzleAdapter(db, { provider: "mysql", schema }),
    migrate: () => migrate(db),
    query: async <T>(text: string, params: unknown[] = []) => {
      const converted = mySqlText(text, params);
      const [rows] = await db.$client.query(converted.text, converted.params);
      return rows as unknown as T[];
    },
    close: async () => {
      await db.$client.end();
    },
  };
  return database;
};