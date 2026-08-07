import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { requirePapel, exigirSenhaDefinitiva, PAPEIS } from '../middleware/auth.js';
import { createApp } from '../app.js';

function chamar(middleware, user) {
  const req = { session: user ? { user } : {} };
  let status = null;
  let corpo = null;
  const res = {
    status: (s) => { status = s; return res; },
    json: (c) => { corpo = c; return res; },
  };
  let passou = false;
  middleware(req, res, () => { passou = true; });
  return { passou, status, corpo };
}

describe('requirePapel', () => {
  // Cumulativo: quem pode mais pode menos. Se fosse comparação exata, toda
  // rota de emissão precisaria lembrar de listar o admin junto.
  it('deixa passar o papel exigido e os acima dele', () => {
    expect(chamar(requirePapel('visualizacao'), { papel: 'visualizacao' }).passou).toBe(true);
    expect(chamar(requirePapel('visualizacao'), { papel: 'emissao' }).passou).toBe(true);
    expect(chamar(requirePapel('visualizacao'), { papel: 'admin' }).passou).toBe(true);

    expect(chamar(requirePapel('emissao'), { papel: 'emissao' }).passou).toBe(true);
    expect(chamar(requirePapel('emissao'), { papel: 'admin' }).passou).toBe(true);

    expect(chamar(requirePapel('admin'), { papel: 'admin' }).passou).toBe(true);
  });

  it('barra os papéis abaixo, com 403', () => {
    const r = chamar(requirePapel('emissao'), { papel: 'visualizacao' });
    expect(r.passou).toBe(false);
    expect(r.status).toBe(403);

    expect(chamar(requirePapel('admin'), { papel: 'emissao' }).status).toBe(403);
    expect(chamar(requirePapel('admin'), { papel: 'visualizacao' }).status).toBe(403);
  });

  it('responde 401, não 403, quando não há sessão', () => {
    expect(chamar(requirePapel('visualizacao'), null).status).toBe(401);
  });

  // Papel corrompido ou removido do sistema não pode virar acesso liberado.
  it('nega papel desconhecido', () => {
    for (const lixo of ['root', '', null, undefined, 'ADMIN']) {
      expect(chamar(requirePapel('visualizacao'), { papel: lixo }).status).toBe(403);
    }
  });

  it('recusa ser construído com um papel que não existe', () => {
    expect(() => requirePapel('superusuario')).toThrow(/Papel desconhecido/);
  });

  it('conhece exatamente os três papéis', () => {
    expect(PAPEIS).toEqual(['visualizacao', 'emissao', 'admin']);
  });
});

describe('senha provisória', () => {
  // A barreira precisa ser do servidor: só na tela, qualquer chamada direta à
  // API passaria por cima.
  it('bloqueia quem ainda usa a senha definida pelo admin', () => {
    const r = chamar(exigirSenhaDefinitiva, { papel: 'admin', deveTrocarSenha: true });
    expect(r.passou).toBe(false);
    expect(r.status).toBe(403);
    expect(r.corpo.codigo).toBe('SENHA_PROVISORIA');
  });

  it('deixa passar quem já trocou', () => {
    expect(chamar(exigirSenhaDefinitiva, { papel: 'visualizacao', deveTrocarSenha: false }).passou).toBe(true);
    expect(chamar(exigirSenhaDefinitiva, { papel: 'visualizacao' }).passou).toBe(true);
  });
});

describe('rotas de usuários', () => {
  const app = createApp();

  it.each([
    ['get', '/api/usuarios'],
    ['post', '/api/usuarios'],
    ['put', '/api/usuarios/1'],
    ['put', '/api/usuarios/1/senha'],
    ['delete', '/api/usuarios/1/mfa'],
  ])('%s %s exige sessão', async (metodo, rota) => {
    expect((await request(app)[metodo](rota).send({})).status).toBe(401);
  });
});
