import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { resetDb, createUser, loginAgent } from './helpers/db.js';
import { EMITENTE_FIXTURE } from './fixtures/emitente.js';

const app = createApp();
let agent;

beforeEach(async () => {
  await resetDb();
  agent = await loginAgent(app, await createUser());
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/config/emitente', () => {
  it('devolve o emitente com os dados fiscais do seed', async () => {
    const res = await agent.get('/api/config/emitente');
    expect(res.status).toBe(200);
    expect(res.body.emitente).toMatchObject({
      cnpj: EMITENTE_FIXTURE.cnpj,
      codigo_municipio: EMITENTE_FIXTURE.codigo_municipio,
      regime_tributario: 'lucro_presumido',
      // Faixa 1-49999: emissão via webservice, sem colidir com o Portal Nacional.
      serie_dps: '1',
      ambiente: 'producao_restrita',
    });
  });

  it('começa a numeração da DPS em 1', async () => {
    const res = await agent.get('/api/config/emitente');
    expect(Number(res.body.emitente.proximo_numero_dps)).toBe(1);
  });
});

describe('GET /api/config/servicos', () => {
  it('traz o serviço com a tributação configurada', async () => {
    const res = await agent.get('/api/config/servicos');
    const servico = res.body.servicos.find((s) => s.codigo_tributacao_nacional === '010501');
    expect(Number(servico.aliquota_iss)).toBe(2);
    expect(Number(servico.aliquota_pis)).toBe(0.65);
    expect(Number(servico.aliquota_cofins)).toBe(3);
    expect(servico.situacao_pis_cofins).toBe('STANDARD_TAXABLE_OPERATION');
    // Retenções: nenhuma. PIS/COFINS informados são da operação própria, não retenção.
    expect(Number(servico.ret_pis)).toBe(0);
    expect(Number(servico.ret_cofins)).toBe(0);
    expect(servico.iss_retido).toBe(0);
  });
});

describe('PUT /api/config/emitente', () => {
  it('atualiza a inscrição municipal', async () => {
    const res = await agent.put('/api/config/emitente').send({ inscricao_municipal: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.emitente.inscricao_municipal).toBe('123456');
  });

  it('ignora CNPJ e numeração, que não são editáveis pelo painel', async () => {
    await agent.put('/api/config/emitente').send({
      cnpj: '00000000000000',
      proximo_numero_dps: 999,
      email: 'novo@example.com',
    });
    const [[emitente]] = await pool.query('SELECT * FROM emitente LIMIT 1');
    expect(emitente.cnpj).toBe(EMITENTE_FIXTURE.cnpj);
    expect(Number(emitente.proximo_numero_dps)).toBe(1);
    expect(emitente.email).toBe('novo@example.com');
  });

  it('exige papel admin', async () => {
    const operador = await createUser({ email: 'op@test.local', papel: 'operador' });
    const agentOp = await loginAgent(app, operador);
    const res = await agentOp.put('/api/config/emitente').send({ email: 'x@y.z' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/config/certificado', () => {
  it('reporta a configuração sem jamais devolver a senha', async () => {
    const res = await agent.get('/api/config/certificado');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('senha_configurada');
    expect(JSON.stringify(res.body)).not.toMatch(/NFSE_CERT_PASSWORD|senha"\s*:\s*"/);
  });
});
