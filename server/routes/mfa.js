import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { limitador } from '../middleware/limite.js';
import { registrar, ACOES } from '../services/auditoria.js';
import {
  gerarSegredo,
  uriOtpauth,
  verificarTotp,
  gerarCodigosBackup,
  normalizarCodigoBackup,
} from '../services/mfa/totp.js';

const router = Router();
router.use(requireAuth);

// Conferir código é operação de adivinhação: 6 dígitos são 1 em um milhão por
// tentativa, o que só é forte se o número de tentativas for pequeno.
const limiteCodigo = limitador({ maximo: 10, janelaMs: 5 * 60_000, nome: 'mfa-codigo' });

router.get('/', async (req, res) => {
  const [[u]] = await pool.query(
    'SELECT mfa_ativo, mfa_confirmado_em FROM users WHERE id = ?',
    [req.session.user.id]
  );
  const [[{ restantes }]] = await pool.query(
    'SELECT COUNT(*) AS restantes FROM mfa_codigo_backup WHERE user_id = ? AND usado_em IS NULL',
    [req.session.user.id]
  );
  res.json({
    ativo: Boolean(u?.mfa_ativo),
    confirmado_em: u?.mfa_confirmado_em ?? null,
    codigos_backup_restantes: restantes,
  });
});

/**
 * Passo 1: gera o segredo e devolve o QR.
 *
 * O segredo fica gravado mas com `mfa_ativo = 0`. Ativar antes da confirmação
 * trancaria para fora quem não conseguiu ler o QR — e não há "esqueci minha
 * senha" neste sistema.
 */
router.post('/iniciar', async (req, res) => {
  const { id, email } = req.session.user;
  const [[u]] = await pool.query('SELECT mfa_ativo FROM users WHERE id = ?', [id]);
  if (u?.mfa_ativo) {
    return res.status(409).json({ error: 'MFA já está ativo. Desative antes de gerar um novo segredo.' });
  }

  const segredo = gerarSegredo();
  await pool.query('UPDATE users SET mfa_segredo = ?, mfa_ultimo_contador = NULL WHERE id = ?', [segredo, id]);

  const uri = uriOtpauth({ segredo, conta: email });
  res.json({
    // O segredo em texto é para quem não consegue ler o QR e vai digitar à mão.
    segredo,
    uri,
    qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }),
  });
});

/**
 * Passo 2: confirma que o aplicativo está gerando os códigos certos e ativa.
 * Devolve os códigos de recuperação — a única vez que eles aparecem.
 */
router.post('/confirmar', limiteCodigo, async (req, res) => {
  const { id } = req.session.user;
  const [[u]] = await pool.query('SELECT mfa_segredo, mfa_ativo FROM users WHERE id = ?', [id]);
  if (!u?.mfa_segredo) return res.status(400).json({ error: 'Comece pelo passo de gerar o QR Code.' });
  if (u.mfa_ativo) return res.status(409).json({ error: 'MFA já está ativo.' });

  const contador = verificarTotp(u.mfa_segredo, req.body?.codigo);
  if (contador === null) return res.status(401).json({ error: 'Código inválido.' });

  const codigos = gerarCodigosBackup();
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    await conexao.query(
      'UPDATE users SET mfa_ativo = 1, mfa_confirmado_em = NOW(), mfa_ultimo_contador = ? WHERE id = ?',
      [contador, id]
    );
    // Troca de segredo invalida códigos antigos: eles pertenciam ao anterior.
    await conexao.query('DELETE FROM mfa_codigo_backup WHERE user_id = ?', [id]);
    for (const codigo of codigos) {
      // Guardado na forma normalizada (sem hífen, minúsculo) — é assim que a
      // conferência no login procura, e é o que deixa o usuário digitar do
      // jeito que quiser.
      await conexao.query('INSERT INTO mfa_codigo_backup (user_id, codigo_hash) VALUES (?, ?)', [
        id,
        await bcrypt.hash(normalizarCodigoBackup(codigo), 10),
      ]);
    }
    await conexao.commit();
  } catch (e) {
    await conexao.rollback();
    throw e;
  } finally {
    conexao.release();
  }

  await registrar(req, { acao: ACOES.MFA_ATIVADO, entidade: 'usuario', entidadeId: id });
  res.json({ ativo: true, codigos_backup: codigos });
});

/**
 * Desativa. Exige senha **e** código: só a sessão não basta, senão uma sessão
 * roubada desligaria justamente a proteção contra sessão roubada.
 */
router.post('/desativar', limiteCodigo, async (req, res) => {
  const { id } = req.session.user;
  const [[u]] = await pool.query('SELECT senha_hash, mfa_segredo, mfa_ativo, mfa_ultimo_contador FROM users WHERE id = ?', [id]);
  if (!u?.mfa_ativo) return res.status(400).json({ error: 'MFA não está ativo.' });

  if (!(await bcrypt.compare(String(req.body?.senha ?? ''), u.senha_hash))) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  if (verificarTotp(u.mfa_segredo, req.body?.codigo, { contadorMinimo: u.mfa_ultimo_contador }) === null) {
    return res.status(401).json({ error: 'Código inválido.' });
  }

  await pool.query(
    'UPDATE users SET mfa_ativo = 0, mfa_segredo = NULL, mfa_confirmado_em = NULL, mfa_ultimo_contador = NULL WHERE id = ?',
    [id]
  );
  await pool.query('DELETE FROM mfa_codigo_backup WHERE user_id = ?', [id]);

  await registrar(req, { acao: ACOES.MFA_DESATIVADO, entidade: 'usuario', entidadeId: id });
  res.json({ ativo: false });
});

export default router;
