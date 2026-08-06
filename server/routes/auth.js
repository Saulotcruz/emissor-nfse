import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });

  const [[user]] = await pool.query(
    'SELECT id, nome, email, senha_hash, papel, ativo FROM users WHERE email = ?',
    [String(email).trim().toLowerCase()]
  );
  // Mensagem genérica de propósito: não revela se o e-mail existe.
  if (!user || !user.ativo) return res.status(401).json({ error: 'Credenciais inválidas' });

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

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

export default router;
