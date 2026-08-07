import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { resetDb, createUser, loginAgent, createTomador } from './helpers/db.js';

const app = createApp();
let agent;
let notaId;

beforeEach(async () => {
  await resetDb();
  agent = await loginAgent(app, await createUser());
  const tomador = await createTomador();
  const [[servico]] = await pool.query('SELECT id FROM servico LIMIT 1');
  const [r] = await pool.query(
    `INSERT INTO nota (tomador_id, servico_id, origem, serie, numero_dps, id_dps, competencia,
                       valor_servico, descricao_servico, status, nfse_xml, numero_nfse, chave_acesso)
     VALUES (?, ?, 'stripe', '1', 7, 'DPS000000000000000000000000000000000000000007', '2026-08-07',
             148.83, 'Plano mensal', 'autorizada', '<NFSe/>', '30', ?)`,
    [tomador.id, servico.id, '3'.repeat(50)]
  );
  notaId = r.insertId;
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/notas', () => {
  it('exige sessão', async () => {
    expect((await request(app).get('/api/notas')).status).toBe(401);
  });

  it('traz os campos que a tela usa', async () => {
    const res = await agent.get('/api/notas');
    expect(res.status).toBe(200);
    const nota = res.body.notas[0];
    expect(nota).toMatchObject({
      status: 'autorizada',
      numero_nfse: '30',
      serie: '1',
      origem: 'stripe',
      tomador_razao_social: 'OPEN KNOWLEDGE BRASIL',
    });
  });

  it('filtra por status e por competência', async () => {
    expect((await agent.get('/api/notas?status=erro')).body.notas).toHaveLength(0);
    expect((await agent.get('/api/notas?status=autorizada')).body.notas).toHaveLength(1);
    expect((await agent.get('/api/notas?de=2026-09-01')).body.notas).toHaveLength(0);
    expect((await agent.get('/api/notas?de=2026-08-01&ate=2026-08-31')).body.notas).toHaveLength(1);
  });
});

describe('GET /api/notas/:id', () => {
  it('devolve a nota com os eventos', async () => {
    const res = await agent.get(`/api/notas/${notaId}`);
    expect(res.status).toBe(200);
    expect(res.body.nota.id_dps).toMatch(/^DPS/);
    expect(res.body.eventos).toEqual([]);
  });

  it('404 para nota inexistente', async () => {
    expect((await agent.get('/api/notas/999999')).status).toBe(404);
  });
});

describe('GET /api/notas/:id/xml', () => {
  it('devolve o XML como anexo', async () => {
    const res = await agent.get(`/api/notas/${notaId}/xml`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.headers['content-disposition']).toContain('.xml');
    expect(res.text).toBe('<NFSe/>');
  });
});

describe('POST /api/notas/:id/cancelar', () => {
  it('exige sessão', async () => {
    const res = await request(app).post(`/api/notas/${notaId}/cancelar`).send({ motivo: 'x'.repeat(20) });
    expect(res.status).toBe(401);
  });

  // A regra de 15 caracteres é do schema da SEFIN; barrar aqui evita a viagem.
  it('recusa justificativa curta sem chamar a SEFIN', async () => {
    const res = await agent.post(`/api/notas/${notaId}/cancelar`).send({ motivo: 'curto' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entre 15 e 255/);
  });

  it('recusa cancelar nota que não está autorizada', async () => {
    await pool.query('UPDATE nota SET status = ? WHERE id = ?', ['erro', notaId]);
    const res = await agent.post(`/api/notas/${notaId}/cancelar`).send({ motivo: 'Justificativa suficiente aqui' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/autorizada/);
  });
});

describe('POST /api/notas/:id/reemitir', () => {
  it('exige sessão', async () => {
    expect((await request(app).post(`/api/notas/${notaId}/reemitir`)).status).toBe(401);
  });

  // Nota já autorizada não é reenviada: devolve o que já existe.
  it('não reenvia nota já autorizada', async () => {
    const res = await agent.post(`/api/notas/${notaId}/reemitir`);
    expect(res.status).toBe(200);
    expect(res.body.jaAutorizada).toBe(true);
  });
});
