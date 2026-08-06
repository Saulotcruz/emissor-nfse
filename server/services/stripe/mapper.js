import { apenasDigitos, tipoDocumento } from '../documento.js';

/**
 * Traduz uma fatura da Stripe no que a emissão precisa.
 *
 * O documento do tomador sai de `customer_tax_ids`, que a Stripe grava na
 * própria fatura a partir do Tax ID do cliente — então não precisa de metadata
 * nem de chamada extra à API. O metadata continua como alternativa, para
 * clientes cadastrados antes do Tax ID.
 */

export const CAMPO_METADATA_DOC = 'auto_invoice.cnpj';
export const CAMPO_METADATA_EMAIL = 'auto_invoice.email';

export class FaturaNaoEmiteNota extends Error {
  constructor(motivo) {
    super(motivo);
    this.name = 'FaturaNaoEmiteNota';
  }
}

/**
 * Id da assinatura, tolerando os dois formatos de payload.
 * A API `2025-03-31.basil` removeu `invoice.subscription` e passou o dado para
 * `invoice.parent.subscription_details.subscription`.
 */
export function extrairSubscriptionId(invoice) {
  return invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
}

export function extrairCustomerId(invoice) {
  return typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
}

/**
 * Documento do tomador. Ordem: Tax ID da fatura → metadata da fatura →
 * metadata do cliente (quando o objeto vier expandido).
 * @returns {{documento: string, tipo: 'cnpj'|'cpf', origem: string}|null}
 */
export function extrairDocumento(invoice, { metadataExtra = {} } = {}) {
  const taxIds = invoice.customer_tax_ids ?? [];
  for (const t of taxIds) {
    if (!['br_cnpj', 'br_cpf'].includes(t.type)) continue;
    const doc = apenasDigitos(t.value);
    const tipo = tipoDocumento(doc);
    if (tipo) return { documento: doc, tipo, origem: `tax_id:${t.type}` };
  }

  const metadata = { ...(invoice.metadata ?? {}), ...metadataExtra };
  const doMetadata = apenasDigitos(metadata[CAMPO_METADATA_DOC]);
  if (doMetadata) {
    const tipo = tipoDocumento(doMetadata);
    if (tipo) return { documento: doMetadata, tipo, origem: 'metadata' };
  }

  return null;
}

/**
 * Descrição do serviço na nota, montada a partir dos itens da fatura.
 * Na NFS-e real da LS Tech esse campo trazia o nome do plano
 * ("GLink - Essential mensal"), não um texto fixo.
 */
export function montarDescricao(invoice, { padrao = 'Prestação de serviços' } = {}) {
  const itens = (invoice.lines?.data ?? [])
    .map((l) => String(l.description ?? '').trim())
    .filter(Boolean);
  if (!itens.length) return padrao;
  // Sem duplicar quando a fatura repete o mesmo item.
  return [...new Set(itens)].join(' | ').slice(0, 2000);
}

/**
 * Converte a fatura no payload de emissão.
 * Lança FaturaNaoEmiteNota quando a fatura não deve gerar nota — é decisão de
 * negócio, não erro: trial, valor zero ou moeda diferente de BRL.
 */
export function mapearFatura(invoice, { metadataExtra = {}, emailFallback = null } = {}) {
  const amount = Number(invoice.amount_paid ?? 0);
  if (amount <= 0) {
    throw new FaturaNaoEmiteNota('Fatura sem valor pago (trial ou cortesia)');
  }

  const moeda = String(invoice.currency ?? 'brl').toLowerCase();
  if (moeda !== 'brl') {
    throw new FaturaNaoEmiteNota(`Fatura em ${moeda.toUpperCase()}: só emitimos NFS-e para BRL`);
  }

  const doc = extrairDocumento(invoice, { metadataExtra });
  if (!doc) {
    throw new FaturaNaoEmiteNota(
      'Sem CNPJ/CPF do tomador: preencha o Tax ID do cliente na Stripe ou o metadata ' +
        CAMPO_METADATA_DOC
    );
  }

  const metadata = { ...(invoice.metadata ?? {}), ...metadataExtra };

  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: extrairCustomerId(invoice),
    stripeSubscriptionId: extrairSubscriptionId(invoice),
    documento: doc.documento,
    tipoDocumento: doc.tipo,
    origemDocumento: doc.origem,
    razaoSocial: invoice.customer_name ?? null,
    email: metadata[CAMPO_METADATA_EMAIL] ?? invoice.customer_email ?? emailFallback,
    valorServico: amount / 100,
    descricaoServico: montarDescricao(invoice),
    competencia: invoice.period_end ? isoData(invoice.period_end) : null,
  };
}

function isoData(unix) {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}
