import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const RECOVERABLE_DUPLICATE_CODES = new Set([
  'ER_TABLE_EXISTS_ERROR',
  'ER_DUP_FIELDNAME',
  'ER_DUP_KEYNAME',
  'ER_FK_DUP_NAME',
]);

export async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS _migrations (name VARCHAR(190) PRIMARY KEY, run_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  );
  const [rows] = await pool.query('SELECT name FROM _migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    // Limitação herdada do mini-crm: divide por ";" no fim de linha — migrações NÃO podem
    // conter ";" dentro de strings, triggers ou procedures. Se uma migração falhar no meio,
    // os statements já aplicados não são desfeitos (DDL não tem rollback no MySQL):
    // corrija para frente, nunca reexecute às cegas.
    const statements = sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (e) {
        if (!RECOVERABLE_DUPLICATE_CODES.has(e.code)) throw e;
        console.warn(`Migração ${file}: ignorando item já existente (${e.code})`);
      }
    }
    await pool.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
  }
}
