import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireEmissao } from '../middleware/auth.js';
import { registrar, ACOES } from '../services/auditoria.js';
import { listarContratos, emitirDoDia, competenciasPendentes } from '../services/contratos/emissao.js';
import { avaliar, hojeLocal } from '../services/contratos/calendario.js';

const router = Router();
router.use(requireAuth);

const CAMPOS = [
  'tomador_id', 'servico_id', 'descricao', 'valor',
  'dia_emissao', 'vigencia_inicio', 'vigencia_fim', 'observacao',
];

router.get('/', async (_req, res) => {
  const contratos = await listarContratos();
  const hoje = hojeLocal();
  res.json({
    // A previsão vem do mesmo `avaliar` que a cron usa. Se o painel tivesse a
    // própria conta, os dois divergiriam no primeiro caso de borda.
    contratos: contratos.map((c) => ({ ...c, previsao: avaliar(c, hoje) })),
    hoje,
  });
});

/** O que a próxima execução da cron faria — sem emitir nada. */
router.get('/previsao', async (_req, res) => {
  res.json({
    emitiriaAgora: await emitirDoDia({ simular: true }),
    pendentes: await competenciasPendentes(),
  });
});

router.post('/', requireEmissao, async (req, res) => {
  const dados = normalizar(req.body ?? {});
  const erro = await validar(dados);
  if (erro) return res.status(400).json({ error: erro });

  const cols = CAMPOS.filter((c) => dados[c] !== undefined);
  const [r] = await pool.query(
    `INSERT INTO contrato (${cols.join(', ')}, criado_por) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
    [...cols.map((c) => dados[c]), req.session.user.id]
  );

  await registrar(req, {
    acao: ACOES.CONTRATO_CRIADO,
    entidade: 'contrato',
    entidadeId: r.insertId,
    detalhe: { valor: dados.valor, dia: dados.dia_emissao, tomador_id: dados.tomador_id },
  });
  res.status(201).json({ contrato: await buscar(r.insertId) });
});

router.put('/:id', requireEmissao, async (req, res) => {
  const [[atual]] = await pool.query('SELECT * FROM contrato WHERE id = ?', [req.params.id]);
  if (!atual) return res.status(404).json({ error: 'Contrato não encontrado' });

  const dados = normalizar(req.body ?? {});
  if (req.body?.ativo !== undefined) dados.ativo = Number(req.body.ativo) ? 1 : 0;
  const erro = await validar({ ...atual, ...dados }, { parcial: true });
  if (erro) return res.status(400).json({ error: erro });

  const cols = [...CAMPOS, 'ativo'].filter((c) => dados[c] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nada para atualizar' });

  await pool.query(
    `UPDATE contrato SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => dados[c]), req.params.id]
  );

  // Valor e descrição saem em toda nota futura; a trilha guarda o que mudou.
  const mudou = cols.filter((c) => String(atual[c] ?? '') !== String(dados[c] ?? ''));
  await registrar(req, {
    acao: ACOES.CONTRATO_ALTERADO,
    entidade: 'contrato',
    entidadeId: req.params.id,
    detalhe: { campos: mudou, de: Object.fromEntries(mudou.map((c) => [c, atual[c]])) },
  });
  res.json({ contrato: await buscar(req.params.id) });
});

/**
 * Emite agora o que estiver vencido, sem esperar a cron.
 *
 * Não é um "emitir de novo": o índice único no banco continua valendo, então
 * chamar isto num contrato já emitido no mês não gera segunda nota.
 */
router.post('/emitir-agora', requireEmissao, async (req, res) => {
  const resultados = await emitirDoDia();
  await registrar(req, {
    acao: ACOES.CONTRATOS_EXECUTADOS,
    detalhe: { emitidas: resultados.filter((r) => r.status === 'emitida').length, total: resultados.length },
  });
  res.json({ resultados });
});

async function buscar(id) {
  const [[c]] = await pool.query(
    `SELECT c.*, t.razao_social AS tomador_nome, s.descricao AS servico_descricao
       FROM contrato c JOIN tomador t ON t.id = c.tomador_id JOIN servico s ON s.id = c.servico_id
      WHERE c.id = ?`,
    [id]
  );
  return c;
}

function normalizar(body) {
  const d = {};
  for (const c of CAMPOS) if (body[c] !== undefined) d[c] = body[c];
  if (d.valor !== undefined) d.valor = Number(String(d.valor).replace(',', '.'));
  if (d.dia_emissao !== undefined) d.dia_emissao = Number(d.dia_emissao);
  if (d.vigencia_fim === '') d.vigencia_fim = null;
  if (d.observacao === '') d.observacao = null;
  return d;
}

async function validar(d, { parcial = false } = {}) {
  if (!parcial) {
    for (const obrigatorio of ['tomador_id', 'servico_id', 'descricao', 'valor', 'dia_emissao', 'vigencia_inicio']) {
      if (d[obrigatorio] === undefined || d[obrigatorio] === null || d[obrigatorio] === '') {
        return `Campo obrigatório: ${obrigatorio}`;
      }
    }
  }
  if (d.valor !== undefined && (!Number.isFinite(d.valor) || d.valor <= 0)) {
    return 'Valor precisa ser maior que zero';
  }
  if (d.dia_emissao !== undefined && !(d.dia_emissao >= 1 && d.dia_emissao <= 31)) {
    return 'Dia de emissão precisa estar entre 1 e 31';
  }
  if (d.descricao !== undefined && String(d.descricao).trim().length < 3) {
    return 'Descrição do serviço é obrigatória';
  }
  if (d.tomador_id !== undefined) {
    const [[t]] = await pool.query('SELECT id FROM tomador WHERE id = ? AND ativo = 1', [d.tomador_id]);
    if (!t) return 'Tomador não encontrado ou inativo';
  }
  if (d.servico_id !== undefined) {
    const [[s]] = await pool.query('SELECT id FROM servico WHERE id = ? AND ativo = 1', [d.servico_id]);
    if (!s) return 'Serviço não encontrado ou inativo';
  }
  return null;
}

export default router;
