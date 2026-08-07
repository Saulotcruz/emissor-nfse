import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { requireAuth, requireAdmin, PAPEIS } from '../middleware/auth.js';
import { registrar, ACOES } from '../services/auditoria.js';
import { SENHA_MINIMA } from './auth.js';

/**
 * Gestão de usuários. Só admin.
 *
 * Duas travas atravessam o arquivo inteiro, e existem pelo mesmo motivo:
 * ninguém pode deixar o sistema sem dono.
 *
 *  1. Não dá para rebaixar, inativar ou apagar **a si mesmo** — um clique
 *     errado tiraria seu próprio acesso e não haveria de onde desfazer.
 *  2. Não dá para deixar o sistema **sem nenhum admin ativo**. Sem isso, tirar
 *     o papel do último admin trancaria todo mundo para fora das alíquotas, dos
 *     usuários e da auditoria — só o banco resolveria.
 */

const router = Router();
router.use(requireAuth, requireAdmin);

const CAMPOS = 'id, nome, email, papel, ativo, deve_trocar_senha, mfa_ativo, ultimo_acesso_em, created_at';

router.get('/', async (_req, res) => {
  const [usuarios] = await pool.query(`SELECT ${CAMPOS} FROM users ORDER BY ativo DESC, nome`);
  res.json({ usuarios, papeis: PAPEIS });
});

router.post('/', async (req, res) => {
  const { nome, email, senha, papel = 'visualizacao' } = req.body ?? {};
  const erro = validar({ nome, email, senha, papel });
  if (erro) return res.status(400).json({ error: erro });

  const emailLimpo = String(email).trim().toLowerCase();
  const [[existe]] = await pool.query('SELECT id FROM users WHERE email = ?', [emailLimpo]);
  if (existe) return res.status(409).json({ error: 'Já existe um usuário com este e-mail' });

  const [r] = await pool.query(
    `INSERT INTO users (nome, email, senha_hash, papel, deve_trocar_senha, criado_por)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [String(nome).trim(), emailLimpo, await bcrypt.hash(senha, 12), papel, req.session.user.id]
  );

  await registrar(req, {
    acao: ACOES.USUARIO_CRIADO,
    entidade: 'usuario',
    entidadeId: r.insertId,
    detalhe: { email: emailLimpo, papel },
  });
  const [[usuario]] = await pool.query(`SELECT ${CAMPOS} FROM users WHERE id = ?`, [r.insertId]);
  res.status(201).json({ usuario });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const [[atual]] = await pool.query('SELECT id, nome, email, papel, ativo FROM users WHERE id = ?', [id]);
  if (!atual) return res.status(404).json({ error: 'Usuário não encontrado' });

  const { nome, papel, ativo } = req.body ?? {};
  if (papel !== undefined && !PAPEIS.includes(papel)) {
    return res.status(400).json({ error: 'Papel inválido' });
  }

  const proprio = id === req.session.user.id;
  if (proprio && papel !== undefined && papel !== atual.papel) {
    return res.status(400).json({ error: 'Você não pode alterar o próprio papel' });
  }
  if (proprio && ativo !== undefined && !Number(ativo)) {
    return res.status(400).json({ error: 'Você não pode desativar a própria conta' });
  }

  const perdeAdmin = atual.papel === 'admin' &&
    ((papel !== undefined && papel !== 'admin') || (ativo !== undefined && !Number(ativo)));
  if (perdeAdmin && !(await haveraOutroAdmin(id))) {
    return res.status(400).json({ error: 'É o último administrador ativo. Promova outro antes.' });
  }

  const campos = [];
  const valores = [];
  if (nome !== undefined) { campos.push('nome = ?'); valores.push(String(nome).trim()); }
  if (papel !== undefined) { campos.push('papel = ?'); valores.push(papel); }
  if (ativo !== undefined) { campos.push('ativo = ?'); valores.push(Number(ativo) ? 1 : 0); }
  if (!campos.length) return res.status(400).json({ error: 'Nada para atualizar' });

  await pool.query(`UPDATE users SET ${campos.join(', ')} WHERE id = ?`, [...valores, id]);

  await registrar(req, {
    acao: ACOES.USUARIO_ALTERADO,
    entidade: 'usuario',
    entidadeId: id,
    detalhe: { email: atual.email, de: { papel: atual.papel, ativo: atual.ativo }, para: { papel, ativo } },
  });
  const [[usuario]] = await pool.query(`SELECT ${CAMPOS} FROM users WHERE id = ?`, [id]);
  res.json({ usuario });
});

/**
 * Define uma senha nova para outro usuário — o "esqueci a senha" deste sistema,
 * já que não há envio de link por e-mail.
 *
 * Marca `deve_trocar_senha`: a senha que o admin digitou é conhecida por ele, e
 * enquanto for, a trilha não pode afirmar que foi o dono da conta quem agiu.
 */
router.put('/:id/senha', async (req, res) => {
  const id = Number(req.params.id);
  const { senha } = req.body ?? {};
  if (!senha || String(senha).length < SENHA_MINIMA) {
    return res.status(400).json({ error: `A senha precisa ter ao menos ${SENHA_MINIMA} caracteres` });
  }
  const [[alvo]] = await pool.query('SELECT id, email FROM users WHERE id = ?', [id]);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });

  await pool.query('UPDATE users SET senha_hash = ?, deve_trocar_senha = 1 WHERE id = ?', [
    await bcrypt.hash(senha, 12),
    id,
  ]);
  await registrar(req, {
    acao: ACOES.USUARIO_SENHA_REDEFINIDA,
    entidade: 'usuario',
    entidadeId: id,
    detalhe: { email: alvo.email },
  });
  res.json({ ok: true });
});

/**
 * Desliga o segundo fator de outro usuário — para quando alguém perde o celular
 * e já gastou os códigos de recuperação.
 *
 * Fica na trilha com destaque: é a única forma de reduzir a proteção de uma
 * conta sem saber a senha dela.
 */
router.delete('/:id/mfa', async (req, res) => {
  const id = Number(req.params.id);
  const [[alvo]] = await pool.query('SELECT id, email, mfa_ativo FROM users WHERE id = ?', [id]);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!alvo.mfa_ativo) return res.status(400).json({ error: 'Este usuário não tem MFA ativo' });

  await pool.query(
    'UPDATE users SET mfa_ativo = 0, mfa_segredo = NULL, mfa_confirmado_em = NULL, mfa_ultimo_contador = NULL WHERE id = ?',
    [id]
  );
  await pool.query('DELETE FROM mfa_codigo_backup WHERE user_id = ?', [id]);

  await registrar(req, {
    acao: ACOES.MFA_DESATIVADO,
    entidade: 'usuario',
    entidadeId: id,
    detalhe: { email: alvo.email, por: 'admin' },
  });
  res.json({ ok: true });
});

async function haveraOutroAdmin(excetoId) {
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM users WHERE papel = ? AND ativo = 1 AND id <> ?',
    ['admin', excetoId]
  );
  return total > 0;
}

function validar({ nome, email, senha, papel }) {
  if (!nome || !String(nome).trim()) return 'Nome é obrigatório';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) return 'E-mail inválido';
  if (!senha || String(senha).length < SENHA_MINIMA) {
    return `A senha precisa ter ao menos ${SENHA_MINIMA} caracteres`;
  }
  if (!PAPEIS.includes(papel)) return 'Papel inválido';
  return null;
}

export default router;
