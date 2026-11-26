// سجل وصول التكامل في قاعدة منفصلة يكتبها خادم MCP، بينما يفتح قاعدة المكتب للقراءة فقط.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db } from '../db/db';

export function openAccessLog(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  db.exec(`CREATE TABLE IF NOT EXISTS access_log (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, token_id TEXT, token_name TEXT, tool TEXT NOT NULL, args TEXT, allowed INTEGER NOT NULL, result_count INTEGER, error TEXT
  )`);
  return db;
}

export function writeAccess(db: Db, e: { tokenId: string | null; tokenName: string | null; tool: string; args: unknown; allowed: boolean; resultCount?: number | null; error?: string | null }) {
  db.run('INSERT INTO access_log (id, at, token_id, token_name, tool, args, allowed, result_count, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    randomUUID(),
    new Date().toISOString(),
    e.tokenId,
    e.tokenName,
    e.tool,
    JSON.stringify(e.args ?? {}).slice(0, 1000),
    e.allowed ? 1 : 0,
    e.resultCount ?? null,
    e.error ?? null,
  ]);
}

export function readAccess(file: string, limit = 200) {
  if (!fs.existsSync(file)) return [];
  const db = new Db(file, { readOnly: true });
  try {
    return db
      .all<{ id: string; at: string; token_name: string | null; tool: string; args: string; allowed: number; result_count: number | null; error: string | null }>(
        'SELECT * FROM access_log ORDER BY at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({ id: r.id, at: r.at, tokenName: r.token_name, tool: r.tool, args: r.args, allowed: !!r.allowed, resultCount: r.result_count, error: r.error }));
  } finally {
    db.close();
  }
}
