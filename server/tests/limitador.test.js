import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { limitador, _zerar } from '../middleware/limite.js';
import { createApp } from '../app.js';

/**
 * O limitador é testado direto, sem banco: ele não consulta nada, e disparar
 * centenas de requisições HTTP só para contar seria lento e frágil.
 */
function chamar(limitar, { ip = '10.0.0.1', userId = null } = {}) {
  const req = { ip, session: userId ? { user: { id: userId } } : {} };
  let status = null;
  const cabecalhos = {};
  const res = {
    set: (k, v) => { cabecalhos[k] = v; return res; },
    status: (s) => { status = s; return res; },
    json: () => res,
  };
  let passou = false;
  limitar(req, res, () => { passou = true; });
  return { passou, status, cabecalhos };
}

beforeEach(() => _zerar());

describe('limitador', () => {
  it('deixa passar até o teto e barra depois', () => {
    const limitar = limitador({ maximo: 3, janelaMs: 60_000, nome: 't1' });
    expect(chamar(limitar).passou).toBe(true);
    expect(chamar(limitar).passou).toBe(true);
    expect(chamar(limitar).passou).toBe(true);

    const quarta = chamar(limitar);
    expect(quarta.passou).toBe(false);
    expect(quarta.status).toBe(429);
    expect(quarta.cabecalhos['Retry-After']).toBeDefined();
  });

  // Sem separar por balde, o limite de uma rota consumiria a cota de outra.
  it('conta cada rota no seu próprio balde', () => {
    const a = limitador({ maximo: 1, janelaMs: 60_000, nome: 'rota-a' });
    const b = limitador({ maximo: 1, janelaMs: 60_000, nome: 'rota-b' });
    expect(chamar(a).passou).toBe(true);
    expect(chamar(a).passou).toBe(false);
    expect(chamar(b).passou).toBe(true); // balde independente
  });

  // Dois usuários atrás do mesmo NAT dividiriam a cota se a chave fosse só o IP.
  it('conta por usuário quando há sessão', () => {
    const limitar = limitador({ maximo: 1, janelaMs: 60_000, nome: 't2' });
    expect(chamar(limitar, { ip: '10.0.0.9', userId: 1 }).passou).toBe(true);
    expect(chamar(limitar, { ip: '10.0.0.9', userId: 1 }).passou).toBe(false);
    expect(chamar(limitar, { ip: '10.0.0.9', userId: 2 }).passou).toBe(true);
  });

  it('conta por IP quando não há sessão', () => {
    const limitar = limitador({ maximo: 1, janelaMs: 60_000, nome: 't3' });
    expect(chamar(limitar, { ip: '10.0.0.1' }).passou).toBe(true);
    expect(chamar(limitar, { ip: '10.0.0.1' }).passou).toBe(false);
    expect(chamar(limitar, { ip: '10.0.0.2' }).passou).toBe(true);
  });

  it('libera quando a janela vira', async () => {
    const limitar = limitador({ maximo: 1, janelaMs: 20, nome: 't4' });
    expect(chamar(limitar).passou).toBe(true);
    expect(chamar(limitar).passou).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(chamar(limitar).passou).toBe(true);
  });
});

describe('quais rotas de nota são consideradas caras', () => {
  const app = createApp();

  // O limite estreito vale para o que fala com a SEFIN ou gera PDF. Se pegasse
  // a listagem junto, o painel travaria em uso normal.
  it.each([
    ['/api/notas/sincronizar', 'post'],
    ['/api/notas/7/reemitir', 'post'],
    ['/api/notas/7/cancelar', 'post'],
  ])('%s passa pelo limite estreito', async (rota, metodo) => {
    // 401 (sessão) e não 429: com uma chamada só, o limite ainda não disparou.
    const r = await request(app)[metodo](rota).send({});
    expect(r.status).toBe(401);
  });

  it('a listagem não é considerada cara', async () => {
    const r = await request(app).get('/api/notas');
    expect(r.status).toBe(401);
  });
});
