import { pool } from '../db/pool.js';

/**
 * Trilha de auditoria: quem fez o quê, quando e de onde.
 *
 * A tabela é append-only por decisão — não existe rota que altere ou apague
 * linha dela. Trilha que o próprio sistema edita não serve como prova.
 *
 * Registrar **nunca** derruba a operação auditada. Se o INSERT falhar, o erro
 * vai para o log e a operação segue. O motivo é concreto: quando o cancelamento
 * de uma nota já foi aceito pela SEFIN, falhar aqui não desfaz nada lá — só
 * deixaria o sistema fora de sincronia com o fisco. Perder a linha da trilha é
 * ruim; recusar um ato fiscal já consumado é pior.
 */

export const ACOES = {
  LOGIN: 'login',
  LOGIN_FALHA: 'login_falha',
  LOGIN_MFA_FALHA: 'login_mfa_falha',
  LOGOUT: 'logout',
  SENHA_ALTERADA: 'senha_alterada',
  MFA_ATIVADO: 'mfa_ativado',
  MFA_DESATIVADO: 'mfa_desativado',
  MFA_BACKUP_USADO: 'mfa_backup_usado',
  NOTA_EMITIDA: 'nota_emitida',
  NOTA_REEMITIDA: 'nota_reemitida',
  NOTA_CANCELADA: 'nota_cancelada',
  NOTAS_SINCRONIZADAS: 'notas_sincronizadas',
  TOMADOR_CRIADO: 'tomador_criado',
  TOMADOR_ALTERADO: 'tomador_alterado',
  TOMADOR_EXCLUIDO: 'tomador_excluido',
  EMITENTE_ALTERADO: 'emitente_alterado',
  SERVICO_CRIADO: 'servico_criado',
  SERVICO_ALTERADO: 'servico_alterado',
  USUARIO_CRIADO: 'usuario_criado',
  USUARIO_ALTERADO: 'usuario_alterado',
  USUARIO_SENHA_REDEFINIDA: 'usuario_senha_redefinida',
};

/**
 * @param {import('express').Request} req  de onde saem usuário, IP e user-agent
 * @param {object} evento
 * @param {string} evento.acao      um valor de ACOES
 * @param {string} [evento.entidade]   'nota', 'tomador', ...
 * @param {string|number} [evento.entidadeId]
 * @param {object} [evento.detalhe]    contexto; **não** colocar segredo aqui
 * @param {object} [evento.usuario]    para o login, em que ainda não há sessão
 */
export async function registrar(req, { acao, entidade = null, entidadeId = null, detalhe = null, usuario = null }) {
  const quem = usuario ?? req?.session?.user ?? null;
  try {
    await pool.query(
      `INSERT INTO auditoria (user_id, usuario_email, acao, entidade, entidade_id, detalhe, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quem?.id ?? null,
        quem?.email ?? null,
        acao,
        entidade,
        entidadeId === null ? null : String(entidadeId),
        detalhe ? JSON.stringify(detalhe) : null,
        req?.ip ?? null,
        String(req?.get?.('user-agent') ?? '').slice(0, 255) || null,
      ]
    );
  } catch (e) {
    console.error(`Falha ao gravar auditoria (${acao}): ${e.message}`);
  }
}

/**
 * Consulta paginada, do mais recente para o mais antigo.
 * Só leitura — não há função de alteração neste módulo, de propósito.
 */
export async function listar({ acao, entidade, entidadeId, de, ate, limite = 100, offset = 0 } = {}) {
  const onde = [];
  const params = [];
  if (acao) { onde.push('acao = ?'); params.push(acao); }
  if (entidade) { onde.push('entidade = ?'); params.push(entidade); }
  if (entidadeId) { onde.push('entidade_id = ?'); params.push(String(entidadeId)); }
  if (de) { onde.push('created_at >= ?'); params.push(de); }
  if (ate) { onde.push('created_at < ?'); params.push(`${ate} 23:59:59`); }

  const filtro = onde.length ? `WHERE ${onde.join(' AND ')}` : '';
  // Limite preso a um teto: uma consulta sem freio na trilha inteira derrubaria
  // a memória do processo.
  const lim = Math.min(Number(limite) || 100, 500);

  const [linhas] = await pool.query(
    `SELECT id, user_id, usuario_email, acao, entidade, entidade_id, detalhe, ip, created_at
       FROM auditoria ${filtro}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [...params, lim, Number(offset) || 0]
  );
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM auditoria ${filtro}`, params);
  return { auditoria: linhas, total };
}
