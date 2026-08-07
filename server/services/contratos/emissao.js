import { pool } from '../../db/pool.js';
import { reservarNota, emitirNota } from '../nfse/client.js';
import { registrar, ACOES } from '../auditoria.js';
import { avaliar, competenciasAnteriores, hojeLocal } from './calendario.js';

/**
 * Emissão dos contratos recorrentes.
 *
 * Roda pela cron, várias vezes ao dia. Ser chamada de novo no mesmo dia não
 * pode gerar segunda nota — quem garante isso é o índice único
 * `(contrato_id, competencia_ref)` no banco, não uma verificação em memória:
 * duas execuções simultâneas passariam pela verificação e só o banco as separa.
 */

export async function listarContratos({ ativo } = {}) {
  const onde = ativo === undefined ? '' : 'WHERE c.ativo = ?';
  const params = ativo === undefined ? [] : [Number(ativo) ? 1 : 0];
  const [linhas] = await pool.query(
    `SELECT c.*, t.razao_social AS tomador_nome, t.documento AS tomador_documento,
            s.descricao AS servico_descricao, s.aliquota_iss
       FROM contrato c
       JOIN tomador t ON t.id = c.tomador_id
       JOIN servico s ON s.id = c.servico_id
       ${onde}
      ORDER BY c.ativo DESC, c.dia_emissao, t.razao_social`,
    params
  );
  return linhas;
}

/** Contratos ativos, com o que já foi emitido em cada competência recente. */
async function contratosComHistorico() {
  const [contratos] = await pool.query('SELECT * FROM contrato WHERE ativo = 1');
  if (!contratos.length) return [];

  // Janela de 12 meses: o histórico só é consultado para saber o que já foi
  // emitido nas competências recentes, e carregar anos de notas a cada rodada
  // da cron seria desperdício crescente.
  const [notas] = await pool.query(
    `SELECT contrato_id, competencia_ref, id, status
       FROM nota
      WHERE contrato_id IS NOT NULL
        AND competencia_ref IS NOT NULL
        AND competencia_ref >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 12 MONTH), '%Y-%m')`
  );
  const porContrato = new Map();
  for (const n of notas) {
    if (!porContrato.has(n.contrato_id)) porContrato.set(n.contrato_id, new Map());
    porContrato.get(n.contrato_id).set(n.competencia_ref, n);
  }
  return contratos.map((c) => ({ contrato: c, emitidas: porContrato.get(c.id) ?? new Map() }));
}

/**
 * Emite o que vence hoje e ainda não foi emitido.
 *
 * @param {object} [opcoes]
 * @param {string} [opcoes.hoje]     AAAA-MM-DD, para teste
 * @param {boolean} [opcoes.simular] só relata o que faria
 */
export async function emitirDoDia({ hoje = hojeLocal(), simular = false } = {}) {
  const resultados = [];

  for (const { contrato, emitidas } of await contratosComHistorico()) {
    const decisao = avaliar(contrato, hoje);
    if (!decisao.emitir) continue;
    if (emitidas.has(decisao.competenciaRef)) continue;

    if (simular) {
      resultados.push({ contratoId: contrato.id, ...decisao, status: 'simulado' });
      continue;
    }
    resultados.push(await emitirCompetencia(contrato, decisao));
  }
  return resultados;
}

/**
 * Emite uma competência de um contrato.
 *
 * A corrida entre duas execuções da cron termina no índice único: a segunda
 * recebe ER_DUP_ENTRY na reserva e é tratada como "já emitida", não como erro.
 */
export async function emitirCompetencia(contrato, decisao) {
  const base = {
    contratoId: contrato.id,
    competenciaRef: decisao.competenciaRef,
    dataEmissao: decisao.dataEmissao,
  };

  let reserva;
  try {
    reserva = await reservarNota({
      tomadorId: contrato.tomador_id,
      servicoId: contrato.servico_id,
      valorServico: contrato.valor,
      descricaoServico: contrato.descricao,
      // A competência fiscal é a data de emissão do contrato naquele mês, e não
      // a data de hoje: uma emissão atrasada não pode mudar o mês de referência.
      competencia: decisao.dataEmissao,
      origem: 'contrato',
      contratoId: contrato.id,
      competenciaRef: decisao.competenciaRef,
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return { ...base, status: 'ja_emitida' };
    }
    throw e;
  }

  try {
    const r = await emitirNota(reserva.id);
    await registrar(null, {
      acao: ACOES.NOTA_EMITIDA,
      entidade: 'nota',
      entidadeId: reserva.id,
      detalhe: {
        origem: 'contrato',
        contratoId: contrato.id,
        competencia: decisao.competenciaRef,
        chaveAcesso: r.chaveAcesso ?? null,
      },
    });
    return { ...base, status: 'emitida', notaId: reserva.id, chaveAcesso: r.chaveAcesso };
  } catch (e) {
    // A nota fica gravada como `erro` e reemitível pelo painel, com o mesmo
    // número de DPS. Falhar aqui não pode derrubar os outros contratos do dia.
    return { ...base, status: 'erro', notaId: reserva.id, erro: e.message };
  }
}

/**
 * Competências passadas sem nota — o que a emissão automática não cobre.
 *
 * Um mês inteiro perdido (servidor fora do ar por semanas) não é emitido
 * sozinho de propósito: uma nota que faltou se resolve à mão, mas uma nota
 * inesperada de competência passada já é documento fiscal no mundo. Então vira
 * alerta, e a decisão é de quem opera.
 */
export async function competenciasPendentes({ hoje = hojeLocal(), meses = 3 } = {}) {
  const pendentes = [];
  for (const { contrato, emitidas } of await contratosComHistorico()) {
    for (const c of competenciasAnteriores(contrato, hoje, meses)) {
      if (!emitidas.has(c.competenciaRef)) {
        pendentes.push({
          contratoId: contrato.id,
          competenciaRef: c.competenciaRef,
          dataEmissao: c.dataEmissao,
        });
      }
    }
  }
  return pendentes;
}
