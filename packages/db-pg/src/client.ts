import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

/**
 * One MySQL connection pool. Works in Node (self-hosted, `DATABASE_URL`) and anywhere mysql2 can reach the server.
 * All timestamps travel as UTC: `timezone: "Z"` makes the driver format and parse DATETIME values in UTC, so the
 * application clock and the database clock agree regardless of the server's time zone.
 */
export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = mysql.createPool({
    uri: connectionString,
    connectionLimit: opts.max ?? 5,
    timezone: "Z",
    dateStrings: false,
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    // Without FOUND_ROWS, affected rows only counts rows a statement actually changed, which is what the storage layer
    // relies on to tell "this caller claimed the row" from "another caller already had it".
    flags: ["-FOUND_ROWS"],
  });
  // Every statement (now(), CURRENT_TIMESTAMP, DATE_FORMAT, ...) runs in UTC, matching the driver's Date conversion.
  // READ COMMITTED matches Postgres' default and the storage layer's assumptions: locking reads see the latest
  // committed rows, and `skip locked` claims do not trip over the gap locks REPEATABLE READ would take.
  pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
    conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
  });
  return drizzle(pool, { schema, mode: "default" });
}
export type Db = ReturnType<typeof createDb>;

/** Query surface shared by a root Drizzle database and its transaction-bound executor. */
export type DbExecutor = Omit<Db, "$client">;