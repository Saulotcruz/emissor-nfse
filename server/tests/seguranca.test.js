import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { resetDb, createUser, loginAgent } from './helpers/db.js';
import { _zerar } from '../middleware/limite.js';

const app = createApp();
let user;

beforeEach(async () => {
  await resetDb();
  _zerar();
  user = await createUser({ senha: 'senhaDeTeste123' });
});

afterAll(async () => {
  await pool.end();
});

describe('SESSION_SECRET', () => {
  // Segredo fraco em produção equivale a não ter autenticação: quem o souber
  // forja um cookie e emite nota em nome da empresa.
  it('impede subir em produção sem segredo, ou com o de desenvolvimento', () => {
    const orig = { env: process.env.NODE_ENV, s: process.env.SESSION_SECRET };
    process.env.NODE_ENV = 'production';
    try {
      delete process.env.SESSION_SECRET;
      expect(() => createApp()).toThrow(/SESSION_SECRET não configurado/);

      process.env.SESSION_SECRET = 'dev-secret';
      expect(() => createApp()).toThrow(/SESSION_SECRET não configurado/);

      process.env.SESSION_SECRET = 'curto';
      expect(() => createApp()).toThrow(/curto demais/);

      process.env.SESSION_SECRET = 'a'.repeat(64);
      expect(() => createApp()).not.toThrow();
    } finally {
      process.env.NODE_ENV = orig.env;
      if (orig.s === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = orig.s;
    }
  });
});

describe('login', () => {
  it('não revela se o e-mail existe', async () => {
    const inexistente = await request(app).post('/api/login').send({ email: 'nao@existe.com', senha: 'x' });
    const senhaErrada = await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
    expect(inexistente.status).toBe(401);
    expect(senhaErrada.status).toBe(401);
    expect(inexistente.body.error).toBe(senhaErrada.body.error);
  });

  it('recusa usuário inativo', async () => {
    await pool.query('UPDATE users SET ativo = 0 WHERE id = ?', [user.id]);
    const res = await request(app).post('/api/login').send({ email: user.email, senha: user.senha });
    expect(res.status).toBe(401);
  });

  // O login é a única porta para emitir e cancelar nota em nome da empresa.
  it('bloqueia após tentativas seguidas', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
      expect(r.status).toBe(401);
    }
    const bloqueado = await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.headers['retry-after']).toBeDefined();

    // Bloqueia até com a senha certa: senão bastaria continuar tentando.
    const comSenhaCerta = await request(app).post('/api/login').send({ email: user.email, senha: user.senha });
    expect(comSenhaCerta.status).toBe(429);
  });

  it('o bloqueio é por e-mail, não derruba o login de outra pessoa', async () => {
    const outro = await createUser({ email: 'outro@test.local', senha: 'outraSenha123' });
    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
    }
    const res = await request(app).post('/api/login').send({ email: outro.email, senha: outro.senha });
    expect(res.status).toBe(200);
  });

  it('login bem-sucedido zera a contagem', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
    }
    expect((await request(app).post('/api/login').send({ email: user.email, senha: user.senha })).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/login').send({ email: user.email, senha: 'errada' });
    }
    // Se a contagem não tivesse zerado, já estaria bloqueado aqui.
    expect((await request(app).post('/api/login').send({ email: user.email, senha: 'errada' })).status).toBe(401);
  });
});

describe('PUT /api/me/senha', () => {
  it('exige sessão', async () => {
    const res = await request(app).put('/api/me/senha').send({ senhaAtual: 'a', novaSenha: 'b'.repeat(10) });
    expect(res.status).toBe(401);
  });

  it('exige a senha atual correta', async () => {
    const agent = await loginAgent(app, user);
    const res = await agent.put('/api/me/senha').send({ senhaAtual: 'errada', novaSenha: 'novaSenha12345' });
    expect(res.status).toBe(401);
  });

  it('recusa senha curta e senha igual à atual', async () => {
    const agent = await loginAgent(app, user);
    expect((await agent.put('/api/me/senha').send({ senhaAtual: user.senha, novaSenha: 'curta' })).status).toBe(400);
    expect((await agent.put('/api/me/senha').send({ senhaAtual: user.senha, novaSenha: user.senha })).status).toBe(400);
  });

  it('troca a senha e a nova passa a valer', async () => {
    const agent = await loginAgent(app, user);
    const res = await agent.put('/api/me/senha').send({ senhaAtual: user.senha, novaSenha: 'novaSenha12345' });
    expect(res.status).toBe(200);

    const [[atualizado]] = await pool.query('SELECT senha_hash FROM users WHERE id = ?', [user.id]);
    expect(await bcrypt.compare('novaSenha12345', atualizado.senha_hash)).toBe(true);
    expect(await bcrypt.compare(user.senha, atualizado.senha_hash)).toBe(false);
  });
});

describe('rotas protegidas', () => {
  // Uma rota nova que esqueça o requireAuth vira porta aberta para os dados
  // fiscais; este teste é a rede que pega isso.
  it('nenhuma rota de dados responde sem sessão', async () => {
    const rotas = [
      ['get', '/api/notas'],
      ['get', '/api/notas/1'],
      ['get', '/api/notas/1/xml'],
      ['post', '/api/notas/1/reemitir'],
      ['post', '/api/notas/1/cancelar'],
      ['post', '/api/notas/sincronizar'],
      ['get', '/api/tomadores'],
      ['post', '/api/tomadores'],
      ['get', '/api/config/emitente'],
      ['put', '/api/config/emitente'],
      ['get', '/api/config/servicos'],
      ['get', '/api/config/certificado'],
    ];
    for (const [metodo, rota] of rotas) {
      const res = await request(app)[metodo](rota).send({});
      expect(`${rota} → ${res.status}`).toBe(`${rota} → 401`);
    }
  });

  it('operador não altera configuração fiscal — só admin', async () => {
    const operador = await createUser({ email: 'op@test.local', papel: 'operador', senha: 'senhaOperador1' });
    const agent = await loginAgent(app, operador);
    expect((await agent.put('/api/config/emitente').send({ email: 'x@y.z' })).status).toBe(403);
    expect((await agent.post('/api/config/servicos').send({})).status).toBe(403);
    // Mas continua enxergando as notas.
    expect((await agent.get('/api/notas')).status).toBe(200);
  });
});
