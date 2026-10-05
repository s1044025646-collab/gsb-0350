import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const DB_PATH = process.env.GEAR_DB ?? path.join(DATA_DIR, "gear.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      params_key TEXT NOT NULL,
      rb REAL NOT NULL,
      rp REAL NOT NULL,
      ra REAL NOT NULL,
      z INTEGER NOT NULL,
      samples INTEGER NOT NULL,
      algo_version TEXT NOT NULL,
      units TEXT NOT NULL,
      angle_convention TEXT NOT NULL,
      status TEXT NOT NULL,
      points_json TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(params_key, version)
    );
  `);
  return db;
}
