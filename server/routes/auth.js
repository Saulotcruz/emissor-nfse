import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { limitarLogin, registrarFalha, limparTentativas } from '../middleware/limite.js';
import { registrar, ACOES } from '../services/auditoria.js';
import { verificarTotp, normalizarCodigoBackup } from '../services/mfa/totp.js';

const router = Router();

export const SENHA_MINIMA = 10;

/** Prazo para digitar o código depois de a senha ter sido aceita. */
const PRAZO_MFA_MS = 5 * 60_000;

/**
 * Hash de uma senha que ninguém tem, com o mesmo custo dos hashes reais.
 * Serve só para gastar o mesmo tempo quando o e-mail não existe.
 */
const HASH_DESCARTAVEL = bcrypt.hashSync('senha-que-nao-existe', 12);

router.post('/login', limitarLogin, async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });

  const [[user]] = await pool.query(
    'SELECT id, nome, email, senha_hash, papel, ativo, mfa_ativo, deve_trocar_senha FROM users WHERE email = ?',
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
    await registrar(req, { acao: ACOES.LOGIN_FALHA, detalhe: { email: String(email).trim().toLowerCase() } });
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    registrarFalha(req);
    await registrar(req, {
      acao: ACOES.LOGIN_FALHA,
      usuario: { id: user.id, email: user.email },
      detalhe: { motivo: 'senha' },
    });
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  limparTentativas(req);
  // Sessão nova a cada login: sem isto, um id de sessão obtido antes do login
  // continuaria válido depois dele (fixação de sessão).
  await regenerarSessao(req);

  // Com MFA ligado a senha certa não abre a sessão: ela só marca que o
  // primeiro fator passou. `req.session.user` continua vazio, então requireAuth
  // barra tudo até o segundo fator.
  if (user.mfa_ativo) {
    req.session.pendenteMfa = { id: user.id, expiraEm: Date.now() + PRAZO_MFA_MS };
    return res.json({ mfaRequerido: true });
  }

  await abrirSessao(req, user);
  await registrar(req, { acao: ACOES.LOGIN, detalhe: { mfa: false } });
  res.json({ user: req.session.user });
});

/**
 * Segundo fator. Aceita o código do aplicativo ou um código de recuperação.
 *
 * O limite de tentativas é o mesmo do login e conta na mesma chave: sem isso,
 * 6 dígitos seriam adivinháveis em algumas milhares de tentativas.
 */
router.post('/login/mfa', limitarLogin, async (req, res) => {
  const pendente = req.session?.pendenteMfa;
  if (!pendente || pendente.expiraEm < Date.now()) {
    delete req.session.pendenteMfa;
    return res.status(401).json({ error: 'Sessão de login expirada. Entre novamente.' });
  }

  const [[user]] = await pool.query(
    'SELECT id, nome, email, papel, ativo, deve_trocar_senha, mfa_segredo, mfa_ultimo_contador FROM users WHERE id = ?',
    [pendente.id]
  );
  // Sem segredo não há segundo fator a conferir. Não deveria acontecer — só se
  // chega aqui com mfa_ativo — mas conferir código contra segredo nulo seria
  // uma porta aberta disfarçada de verificação.
  if (!user || !user.ativo || !user.mfa_segredo) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const codigo = String(req.body?.codigo ?? '');
  const contador = verificarTotp(user.mfa_segredo, codigo, { contadorMinimo: user.mfa_ultimo_contador });

  let viaBackup = false;
  if (contador !== null) {
    // Guardar o contador é o que impede reapresentar o mesmo código dentro dos
    // 30 segundos em que ele ainda vale.
    await pool.query('UPDATE users SET mfa_ultimo_contador = ? WHERE id = ?', [contador, user.id]);
  } else {
    viaBackup = await consumirCodigoBackup(user.id, codigo);
    if (!viaBackup) {
      registrarFalha(req);
      await registrar(req, {
        acao: ACOES.LOGIN_MFA_FALHA,
        usuario: { id: user.id, email: user.email },
      });
      return res.status(401).json({ error: 'Código inválido' });
    }
  }

  limparTentativas(req);
  await regenerarSessao(req);
  await abrirSessao(req, user);

  await registrar(req, { acao: ACOES.LOGIN, detalhe: { mfa: true, via: viaBackup ? 'backup' : 'app' } });
  if (viaBackup) {
    await registrar(req, { acao: ACOES.MFA_BACKUP_USADO, entidade: 'usuario', entidadeId: user.id });
  }
  res.json({ user: req.session.user, usouCodigoBackup: viaBackup });
});

router.post('/logout', async (req, res) => {
  await registrar(req, { acao: ACOES.LOGOUT });
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

  await pool.query('UPDATE users SET senha_hash = ?, deve_trocar_senha = 0 WHERE id = ?', [
    await bcrypt.hash(novaSenha, 12),
    user.id,
  ]);
  req.session.user.deveTrocarSenha = false;
  await registrar(req, { acao: ACOES.SENHA_ALTERADA, entidade: 'usuario', entidadeId: user.id });
  res.json({ ok: true });
});

/**
 * O que vai para a sessão. Central para os dois caminhos de login não
 * divergirem — foi assim que `deveTrocarSenha` quase ficou de fora do caminho
 * com MFA.
 */
async function abrirSessao(req, user) {
  req.session.user = {
    id: user.id,
    nome: user.nome,
    email: user.email,
    papel: user.papel,
    deveTrocarSenha: Boolean(user.deve_trocar_senha),
  };
  await pool.query('UPDATE users SET ultimo_acesso_em = NOW() WHERE id = ?', [user.id]);
  return req.session.user;
}

function regenerarSessao(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}

/**
 * Gasta um código de recuperação, se o informado bater com algum não usado.
 *
 * Os códigos são guardados como hash, então não dá para procurar pelo valor:
 * é preciso comparar contra cada um dos que sobraram. São no máximo dez, e
 * quem chega aqui já passou pela senha e pelo limite de tentativas.
 */
async function consumirCodigoBackup(userId, informado) {
  const limpo = normalizarCodigoBackup(informado);
  if (limpo.length !== 8) return false;

  const [linhas] = await pool.query(
    'SELECT id, codigo_hash FROM mfa_codigo_backup WHERE user_id = ? AND usado_em IS NULL',
    [userId]
  );
  for (const linha of linhas) {
    if (await bcrypt.compare(limpo, linha.codigo_hash)) {
      // A condição `usado_em IS NULL` no UPDATE fecha a corrida de duas
      // requisições simultâneas com o mesmo código: só uma afeta linha.
      const [r] = await pool.query(
        'UPDATE mfa_codigo_backup SET usado_em = NOW() WHERE id = ? AND usado_em IS NULL',
        [linha.id]
      );
      return r.affectedRows === 1;
    }
  }
  return false;
}

export default router;
