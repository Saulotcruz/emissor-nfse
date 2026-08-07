import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { _zerar } from '../middleware/limite.js';

/**
 * As garantias do fluxo de MFA que dá para provar sem banco: quem ainda não
 * passou pelo segundo fator não entra em lugar nenhum.
 *
 * O caminho feliz (ativar, confirmar, entrar) depende de MySQL e vive em
 * mfa.test.js.
 */
const app = createApp();

beforeEach(() => _zerar());

describe('rotas de MFA exigem sessão', () => {
  it.each([
    ['get', '/api/mfa'],
    ['post', '/api/mfa/iniciar'],
    ['post', '/api/mfa/confirmar'],
    ['post', '/api/mfa/desativar'],
  ])('%s %s responde 401 sem sessão', async (metodo, rota) => {
    const r = await request(app)[metodo](rota).send({ codigo: '123456' });
    expect(r.status).toBe(401);
  });
});

describe('segundo fator do login', () => {
  // Sem o passo da senha não existe login pendente: mandar código direto não
  // pode virar um atalho.
  it('recusa código sem ter passado pela senha', async () => {
    const r = await request(app).post('/api/login/mfa').send({ codigo: '123456' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/expirada|inválid/i);
  });

  it('não abre sessão: /me continua 401', async () => {
    const agente = request.agent(app);
    await agente.post('/api/login/mfa').send({ codigo: '123456' });
    expect((await agente.get('/api/me')).status).toBe(401);
  });
});

describe('trilha de auditoria', () => {
  it.each([
    ['get', '/api/auditoria'],
    ['get', '/api/auditoria/acoes'],
  ])('%s %s exige sessão', async (metodo, rota) => {
    expect((await request(app)[metodo](rota)).status).toBe(401);
  });

  // Append-only: não existe rota que altere ou apague linha da trilha.
  it.each(['post', 'put', 'patch', 'delete'])('não expõe %s', async (metodo) => {
    const r = await request(app)[metodo]('/api/auditoria/1').send({});
    expect([401, 404]).toContain(r.status);
  });
});
