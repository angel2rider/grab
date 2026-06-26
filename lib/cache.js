// SQLite-backed URL response cache.
// Every URL searched via /api/info is stored so repeated lookups return instantly.

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "cache.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    url      TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    kind     TEXT NOT NULL DEFAULT 'single',
    expires  INTEGER NOT NULL,
    size     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires);
`);

// --- prepared statements ---
const stmtGet = db.prepare("SELECT response FROM cache WHERE url = ? AND expires > ?");
const stmtUpsert = db.prepare(`
  INSERT INTO cache (url, response, platform, kind, expires, size)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    response = excluded.response,
    platform = excluded.platform,
    kind     = excluded.kind,
    expires  = excluded.expires,
    size     = excluded.size
`);
const stmtDelete = db.prepare("DELETE FROM cache WHERE url = ?");
const stmtClean = db.prepare("DELETE FROM cache WHERE expires <= ?");
const stmtCount = db.prepare("SELECT COUNT(*) AS cnt, SUM(size) AS totalSize FROM cache");



const FAR_FUTURE = 9e15; // ~year 287396 — effectively permanent

/**
 * Look up a cached response for `url`. Returns the parsed JSON object
 * if an entry exists, otherwise null. Entries never expire.
 */
export function cacheGet(url) {
  const row = stmtGet.get(url, Date.now());
  if (!row) return null;
  try {
    return JSON.parse(row.response);
  } catch {
    // corrupt entry — remove it
    stmtDelete.run(url);
    return null;
  }
}

/**
 * Store a response object in the cache with a given TTL.
 * @param {string} url  — key
 * @param {object} data — the full JSON response (will be serialised)
 * @param {object} opts — { ttl: number, platform: string, kind: string }
 */
export function cacheSet(url, data, opts = {}) {
  const expires = FAR_FUTURE;
  const json = JSON.stringify(data);
  const size = Buffer.byteLength(json, "utf8");
  stmtUpsert.run(url, json, opts.platform || "", opts.kind || "single", expires, size);
}

/**
 * Remove all expired entries. Called periodically.
 */
export function cacheClean() {
  const info = stmtClean.run(Date.now());
  if (info.changes > 0) {
    console.log(`  ▸ cache: expired ${info.changes} entry(s)`);
  }
}

/**
 * Return summary stats about the cache.
 */
export function cacheStats() {
  const row = stmtCount.get();
  return { entries: row.cnt, totalSize: row.totalSize };
}

// --- graceful shutdown ---
process.on("exit", () => { try { db.close(); } catch {} });
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => process.exit()));

// --- cache is permanent; cleanup only for legacy expired entries on startup ---
console.log(`  ▸ cache db:   ${DB_PATH} (${cacheStats().entries} entries)`);
cacheClean();
