import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { limitarLogin, registrarFalha, limparTentativas } from '../middleware/limite.js';

const router = Router();

export const SENHA_MINIMA = 10;

/**
 * Hash de uma senha que ninguém tem, com o mesmo custo dos hashes reais.
 * Serve só para gastar o mesmo tempo quando o e-mail não existe.
 */
const HASH_DESCARTAVEL = bcrypt.hashSync('senha-que-nao-existe', 12);

router.post('/login', limitarLogin, async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });

  const [[user]] = await pool.query(
    'SELECT id, nome, email, senha_hash, papel, ativo FROM users WHERE email = ?',
    [String(email).trim().toLowerCase()]
  );
  // Mensagem genérica de propósito: não revela se o e-mail existe.
  //
  // O tempo de resposta também não pode revelar. Sem o `compare` contra um
  // hash descartável, e-mail inexistente responderia na hora e e-mail válido
  // demoraria os ~100ms do bcrypt — diferença suficiente para varrer uma lista
  // e descobrir quais contas existem antes de atacar a senha.
  if (!user || !user.ativo) {
    await bcrypt.compare(senha, HASH_DESCARTAVEL);
    registrarFalha(req);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    registrarFalha(req);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  limparTentativas(req);
  // Sessão nova a cada login: sem isto, um id de sessão obtido antes do login
  // continuaria válido depois dele (fixação de sessão).
  await new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve()))
  );
  req.session.user = { id: user.id, nome: user.nome, email: user.email, papel: user.papel };
  res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json({ user: req.session.user });
});

/**
 * Troca de senha. Sem isto não há como girar credencial: o único usuário nasce
 * no seed, e uma senha vazada ficaria válida para sempre.
 */
router.put('/me/senha', requireAuth, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body ?? {};
  if (!senhaAtual || !novaSenha) {
    return res.status(400).json({ error: 'Informe a senha atual e a nova senha' });
  }
  if (String(novaSenha).length < SENHA_MINIMA) {
    return res.status(400).json({ error: `A nova senha precisa ter ao menos ${SENHA_MINIMA} caracteres` });
  }
  if (senhaAtual === novaSenha) {
    return res.status(400).json({ error: 'A nova senha precisa ser diferente da atual' });
  }

  const [[user]] = await pool.query('SELECT id, senha_hash FROM users WHERE id = ?', [
    req.session.user.id,
  ]);
  if (!user || !(await bcrypt.compare(senhaAtual, user.senha_hash))) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }

  await pool.query('UPDATE users SET senha_hash = ? WHERE id = ?', [
    await bcrypt.hash(novaSenha, 12),
    user.id,
  ]);
  res.json({ ok: true });
});

export default router;
