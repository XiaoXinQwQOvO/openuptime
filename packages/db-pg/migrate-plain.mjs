// Applies the drizzle migrations from a shell (`pnpm db:migrate`). MySQL commits DDL implicitly, so this runs the
// statements one by one behind a named lock instead of inside one transaction.
// `--check` reads the applied history, validates it against this build and lists pending migrations without writing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { validateMigrationHistory } from "./src/migration-history.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
// --check: read-only dry run. Validates the applied history against this build and lists what would be
// applied, without creating tables or running any migration SQL.
const checkOnly = process.argv.includes("--check");
const conn = await mysql.createConnection(url);
const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8"));

const migrations = journal.entries.map((e) => ({ ...e, sql: readFileSync(`./drizzle/${e.tag}.sql`, "utf8") }));
try {
  if (checkOnly) {
    const [tables] = await conn.query(
      "select table_name from information_schema.tables where table_schema = database() and table_name = '__drizzle_migrations'",
    );
    const history = tables.length
      ? (await conn.query("select created_at, hash from __drizzle_migrations order by id"))[0]
      : [];
    for (const e of validateMigrationHistory(migrations, history)) console.log("would apply", e.tag);
    console.log("history ok");
    process.exit(0);
  }
  await conn.query("select get_lock(?, 60)", ["openuptime:migrate"]);
  await conn.query(
    "create table if not exists __drizzle_migrations (id bigint unsigned not null auto_increment primary key, hash varchar(64) not null, created_at bigint)",
  );
  const [history] = await conn.query("select created_at, hash from __drizzle_migrations order by id");
  const tags = [];
  for (const e of validateMigrationHistory(migrations, history)) {
    for (const stmt of e.sql.split("--> statement-breakpoint")) if (stmt.trim()) await conn.query(stmt);
    await conn.query("insert into __drizzle_migrations (hash, created_at) values (?, ?)", [createHash("sha256").update(e.sql).digest("hex"), e.when]);
    tags.push(e.tag);
  }
  await conn.query("select release_lock(?)", ["openuptime:migrate"]);
  for (const tag of tags) console.log("applied", tag);
  console.log("up to date");
} finally {
  await conn.end();
}