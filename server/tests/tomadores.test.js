import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { resetDb, createUser, loginAgent, createTomador } from './helpers/db.js';

const app = createApp();
let agent;

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  const user = await createUser();
  agent = await loginAgent(app, user);
});

afterAll(async () => {
  await pool.end();
});

describe('autenticação', () => {
  it('bloqueia acesso sem sessão', async () => {
    const res = await request(app).get('/api/tomadores');
    expect(res.status).toBe(401);
  });

  it('recusa senha errada sem revelar se o e-mail existe', async () => {
    const res = await request(app).post('/api/login').send({ email: 'admin@test.local', senha: 'errada' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciais inválidas');
  });
});

describe('POST /api/tomadores', () => {
  it('cria um tomador limpando a máscara do documento', async () => {
    const res = await agent.post('/api/tomadores').send({
      documento: '19.131.243/0001-97',
      razao_social: 'OPEN KNOWLEDGE BRASIL',
      cep: '01311-902',
    });
    expect(res.status).toBe(201);
    expect(res.body.tomador.documento).toBe('19131243000197');
    expect(res.body.tomador.cep).toBe('01311902');
    expect(res.body.tomador.tipo_doc).toBe('cnpj');
    expect(res.body.tomador.origem).toBe('manual');
  });

  it('rejeita CNPJ com dígito verificador inválido', async () => {
    const res = await agent.post('/api/tomadores').send({
      documento: '19131243000198',
      razao_social: 'EMPRESA X',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido/i);
  });

  it('exige razão social', async () => {
    const res = await agent.post('/api/tomadores').send({ documento: '19131243000197' });
    expect(res.status).toBe(400);
  });

  it('devolve 409 e o id existente quando o documento já está cadastrado', async () => {
    const existente = await createTomador();
    const res = await agent.post('/api/tomadores').send({
      documento: existente.documento,
      razao_social: 'OUTRA RAZAO',
    });
    expect(res.status).toBe(409);
    expect(res.body.id).toBe(existente.id);
  });
});

describe('GET /api/tomadores', () => {
  it('filtra por razão social e por documento', async () => {
    await createTomador();
    await createTomador({ documento: '11222333000262', razao_social: 'SEGUNDA EMPRESA' });

    const porNome = await agent.get('/api/tomadores?busca=SEGUNDA');
    expect(porNome.body.tomadores).toHaveLength(1);

    const porDoc = await agent.get('/api/tomadores?busca=19.131.243/0001-97');
    expect(porDoc.body.tomadores).toHaveLength(1);
    expect(porDoc.body.tomadores[0].razao_social).toBe('OPEN KNOWLEDGE BRASIL');
  });
});

describe('DELETE /api/tomadores/:id', () => {
  it('inativa em vez de apagar, porque notas referenciam o tomador', async () => {
    const t = await createTomador();
    const res = await agent.delete(`/api/tomadores/${t.id}`);
    expect(res.status).toBe(200);

    const [[row]] = await pool.query('SELECT ativo FROM tomador WHERE id = ?', [t.id]);
    expect(row.ativo).toBe(0);
  });
});
