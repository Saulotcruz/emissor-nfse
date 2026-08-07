import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

/**
 * Defesas que valem para toda a API, testadas sem banco: as rotas usadas aqui
 * respondem antes de qualquer consulta.
 */
const app = createApp();

describe('cabeçalhos de segurança', () => {
  it('manda os cabeçalhos em toda resposta', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('não anuncia a stack no x-powered-by', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  // HSTS em HTTP puro só atrapalharia o desenvolvimento local.
  it('só manda HSTS quando a requisição chegou por HTTPS', async () => {
    const semTls = await request(app).get('/api/health');
    expect(semTls.headers['strict-transport-security']).toBeUndefined();

    const comTls = await request(app).get('/api/health').set('x-forwarded-proto', 'https');
    expect(comTls.headers['strict-transport-security']).toContain('max-age=');
  });
});

describe('origem das requisições que mudam estado', () => {
  it('recusa POST vindo de outra origem', async () => {
    const r = await request(app)
      .post('/api/login')
      .set('Origin', 'https://site-do-atacante.example')
      .send({ email: 'a@b.c', senha: 'x' });
    expect(r.status).toBe(403);
  });

  it('recusa DELETE vindo de outra origem antes mesmo de checar a sessão', async () => {
    const r = await request(app)
      .delete('/api/tomadores/1')
      .set('Origin', 'https://site-do-atacante.example');
    expect(r.status).toBe(403);
  });

  // Sem Origin é cliente que não é navegador — e esses não carregam o cookie
  // de sessão de ninguém, que é justamente o que o CSRF explora. Passa pela
  // checagem de origem e cai na de sessão.
  it('deixa passar requisição sem Origin, que então esbarra na sessão', async () => {
    const r = await request(app).delete('/api/tomadores/1');
    expect(r.status).toBe(401);
  });

  it('não interfere em leitura', async () => {
    const r = await request(app).get('/api/notas').set('Origin', 'https://site-do-atacante.example');
    expect(r.status).toBe(401); // barrado pela sessão, não pela origem
  });

  // O webhook da Stripe é chamado por servidor, não por navegador: não manda
  // Origin. Se a checagem o barrasse, a emissão automática pararia.
  it('não barra o webhook da Stripe', async () => {
    const r = await request(app).post('/api/stripe/webhook').send({});
    expect(r.status).not.toBe(403);
  });
});
