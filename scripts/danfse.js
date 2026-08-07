#!/usr/bin/env node
/**
 * Baixa o DANFSe em PDF de uma nota.
 *
 *   npm run danfse -- --nota 3
 *   npm run danfse -- --nota 3 --saida /tmp/nota.pdf
 *
 * O PDF é montado aqui a partir do XML autorizado: a API oficial que gerava o
 * DANFSe foi desligada em 1º de julho de 2026 (NT SE/CGSN 008/2026).
 */
import fs from 'node:fs';
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { baixarDanfse } from '../server/services/nfse/client.js';
import { SefinError } from '../server/services/nfse/errors.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i];
}

try {
  if (!args.nota) {
    console.error('Informe --nota <id>. Ex.: npm run danfse -- --nota 3');
    process.exitCode = 1;
  } else {
    const { pdf, nota } = await baixarDanfse(Number(args.nota));
    const saida = args.saida ?? `danfse-${nota.numero_nfse ?? nota.id}.pdf`;
    fs.writeFileSync(saida, pdf);
    console.log(`✓ ${saida} (${(pdf.length / 1024).toFixed(1)} kB)`);

  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (e instanceof SefinError && e.status) console.error(`  HTTP ${e.status}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
