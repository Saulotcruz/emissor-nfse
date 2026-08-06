import { pool } from '../../db/pool.js';
import { mapearFatura, FaturaNaoEmiteNota } from './mapper.js';
import { consultarCnpj, CnpjNaoEncontradoError } from '../brasilapi.js';
import { carregarServicoPadrao, reservarNota, emitirNota } from '../nfse/client.js';

/**
 * Processa uma fatura paga: resolve o tomador, reserva a nota e emite.
 *
 * Roda fora do ciclo da requisição — a Stripe corta o webhook em poucos
 * segundos e uma emissão passa disso. O resultado, inclusive o erro, fica em
 * `stripe_evento` e em `nota`, então nada se perde por não ter sido respondido.
 */

export const EVENTO_SUPORTADO = 'invoice.payment_succeeded';

/**
 * Registra o evento bruto. O índice único em `stripe_event_id` é o que torna a
 * reentrega da Stripe inofensiva.
 * @returns {{id:number, novo:boolean}}
 */
export async function registrarEvento(evento) {
  try {
    const [r] = await pool.query(
      'INSERT INTO stripe_evento (stripe_event_id, tipo, payload) VALUES (?, ?, ?)',
      [evento.id, evento.type, JSON.stringify(evento).slice(0, 16_000_000)]
    );
    return { id: r.insertId, novo: true };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      const [[row]] = await pool.query('SELECT id FROM stripe_evento WHERE stripe_event_id = ?', [
        evento.id,
      ]);
      return { id: row.id, novo: false };
    }
    throw e;
  }
}

/**
 * Encontra ou cria o tomador (modo híbrido).
 * Ordem: `stripe_customer_id` → documento → cria a partir da BrasilAPI.
 */
export async function resolverTomador(dados) {
  if (dados.stripeCustomerId) {
    const [[porStripe]] = await pool.query('SELECT * FROM tomador WHERE stripe_customer_id = ?', [
      dados.stripeCustomerId,
    ]);
    if (porStripe) return porStripe;
  }

  const [[porDoc]] = await pool.query('SELECT * FROM tomador WHERE documento = ?', [dados.documento]);
  if (porDoc) {
    // Cadastro manual que ainda não conhecia o cliente da Stripe: liga os dois.
    if (dados.stripeCustomerId && !porDoc.stripe_customer_id) {
      await pool.query('UPDATE tomador SET stripe_customer_id = ? WHERE id = ?', [
        dados.stripeCustomerId,
        porDoc.id,
      ]);
    }
    return porDoc;
  }

  return criarTomador(dados);
}

async function criarTomador(dados) {
  let cadastro = {};
  if (dados.tipoDocumento === 'cnpj') {
    try {
      cadastro = await consultarCnpj(dados.documento);
    } catch (e) {
      // Sem os dados da Receita a nota ainda sai: o endereço do tomador é
      // opcional na DPS. Melhor emitir com o mínimo que ter fatura sem nota.
      if (!(e instanceof CnpjNaoEncontradoError)) console.warn(`BrasilAPI: ${e.message}`);
    }
  }

  const razao = cadastro.razao_social ?? dados.razaoSocial;
  if (!razao) {
    throw new Error(
      `Sem razão social para o tomador ${dados.documento}: preencha o nome do cliente na Stripe`
    );
  }

  const registro = {
    tipo_doc: dados.tipoDocumento,
    documento: dados.documento,
    razao_social: razao,
    nome_fantasia: cadastro.nome_fantasia ?? null,
    email: dados.email ?? cadastro.email ?? null,
    telefone: cadastro.telefone ?? null,
    logradouro: cadastro.logradouro ?? null,
    numero: cadastro.numero ?? null,
    complemento: cadastro.complemento ?? null,
    bairro: cadastro.bairro ?? null,
    cep: cadastro.cep ?? null,
    uf: cadastro.uf ?? null,
    stripe_customer_id: dados.stripeCustomerId,
    origem: 'stripe',
  };

  const cols = Object.keys(registro);
  try {
    const [r] = await pool.query(
      `INSERT INTO tomador (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => registro[c])
    );
    const [[criado]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [r.insertId]);
    return criado;
  } catch (e) {
    // Duas faturas do mesmo cliente novo chegando juntas: as duas passam pela
    // consulta sem achar nada e tentam inserir. O índice único decide, e quem
    // perdeu apenas relê o cadastro que a outra criou.
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[existente]] = await pool.query(
      'SELECT * FROM tomador WHERE documento = ? OR stripe_customer_id = ? LIMIT 1',
      [registro.documento, registro.stripe_customer_id]
    );
    if (!existente) throw e;
    return existente;
  }
}

/**
 * Fluxo completo de uma fatura paga.
 * @returns {{status:string, [notaId]:number, [motivo]:string}}
 */
export async function processarFatura(invoice, { emitir = true } = {}) {
  let dados;
  try {
    dados = mapearFatura(invoice);
  } catch (e) {
    if (e instanceof FaturaNaoEmiteNota) return { status: 'ignorada', motivo: e.message };
    throw e;
  }

  // Segunda barreira de idempotência: mesmo que o mesmo pagamento chegue por
  // dois eventos diferentes, a fatura só gera uma nota.
  const [[existente]] = await pool.query('SELECT id, status FROM nota WHERE stripe_invoice_id = ?', [
    dados.stripeInvoiceId,
  ]);
  if (existente) {
    return { status: 'ja_processada', notaId: existente.id, statusNota: existente.status };
  }

  const tomador = await resolverTomador(dados);
  const servico = await carregarServicoPadrao();

  const reserva = await reservarNota({
    tomadorId: tomador.id,
    servicoId: servico.id,
    valorServico: dados.valorServico,
    descricaoServico: dados.descricaoServico,
    competencia: dados.competencia,
    origem: 'stripe',
    stripeInvoiceId: dados.stripeInvoiceId,
    stripeSubscriptionId: dados.stripeSubscriptionId,
  });

  if (!emitir) return { status: 'reservada', notaId: reserva.id };

  const r = await emitirNota(reserva.id);
  return { status: 'emitida', notaId: reserva.id, chaveAcesso: r.chaveAcesso };
}

/** Marca o evento como processado, guardando o erro quando houver. */
export async function concluirEvento(eventoId, { erro = null } = {}) {
  await pool.query('UPDATE stripe_evento SET processado_em = NOW(), erro_mensagem = ? WHERE id = ?', [
    erro ? String(erro).slice(0, 2000) : null,
    eventoId,
  ]);
}
