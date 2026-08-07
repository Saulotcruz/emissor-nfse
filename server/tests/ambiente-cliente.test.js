import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { resetDb } from './helpers/db.js';
import { criarClienteSefin } from '../services/nfse/client.js';
import { BASE_URLS } from '../services/nfse/transport.js';
import { gerarPfxDeTeste } from './helpers/certificado.js';

let emitente;

beforeEach(async () => {
  await resetDb();
  const pfx = gerarPfxDeTeste();
  const caminho = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cert-')), 't.pfx');
  fs.writeFileSync(caminho, pfx.buffer);
  process.env.NFSE_CERT_PATH = caminho;
  process.env.NFSE_CERT_PASSWORD = pfx.senha;
  [[emitente]] = await pool.query('SELECT * FROM emitente LIMIT 1');
});

afterAll(async () => {
  await pool.end();
});

// Depois da virada, o emitente fica em produção mas as notas antigas continuam
// em produção restrita. Usar o endpoint do emitente falaria com o ambiente
// errado: a chave não existe lá, e a resposta seria um 404 enganoso.
describe('criarClienteSefin — ambiente por nota', () => {
  it('usa o ambiente do emitente quando nada é passado', () => {
    const { client } = criarClienteSefin({ ...emitente, ambiente: 'producao' });
    expect(client.baseUrl).toBe(BASE_URLS.producao);
  });

  it('respeita o ambiente da nota, não o do emitente', () => {
    const emProducao = { ...emitente, ambiente: 'producao' };
    const { client } = criarClienteSefin(emProducao, { ambiente: 'producao_restrita' });
    expect(client.baseUrl).toBe(BASE_URLS.producao_restrita);
  });

  it('vale nos dois sentidos', () => {
    const restrito = { ...emitente, ambiente: 'producao_restrita' };
    const { client } = criarClienteSefin(restrito, { ambiente: 'producao' });
    expect(client.baseUrl).toBe(BASE_URLS.producao);
  });
});
