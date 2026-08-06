import crypto from 'node:crypto';

/**
 * Verificação da assinatura dos webhooks da Stripe.
 *
 * Implementado aqui em vez de trazer o SDK inteiro: o esquema é simples e
 * documentado, e assim o que roda em produção cabe num arquivo auditável.
 *
 * O header `stripe-signature` vem como `t=<unix>,v1=<hmac>[,v1=<hmac>...]`.
 * A carga assinada é `${t}.${corpoRaw}`, com HMAC-SHA256 sobre o webhook secret.
 */

export class AssinaturaStripeInvalida extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'AssinaturaStripeInvalida';
    this.status = 400;
  }
}

const TOLERANCIA_PADRAO_S = 300;

export function analisarHeader(header) {
  const partes = String(header ?? '').split(',');
  const t = partes.find((p) => p.startsWith('t='))?.slice(2);
  const v1 = partes.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return { timestamp: t ? Number(t) : null, assinaturas: v1 };
}

/**
 * @param {Buffer|string} corpoRaw  corpo EXATO da requisição, sem reserializar
 * @param {string} header           conteúdo de `stripe-signature`
 * @param {string} segredo          STRIPE_WEBHOOK_SECRET (whsec_…)
 * @returns {object} o evento já desserializado
 */
export function verificarEvento(corpoRaw, header, segredo, { toleranciaS = TOLERANCIA_PADRAO_S, agora = Date.now() } = {}) {
  if (!segredo) throw new AssinaturaStripeInvalida('STRIPE_WEBHOOK_SECRET não configurado');

  const { timestamp, assinaturas } = analisarHeader(header);
  if (!timestamp || !assinaturas.length) {
    throw new AssinaturaStripeInvalida('Header stripe-signature ausente ou malformado');
  }

  // Janela de tolerância: barra reenvio de uma requisição capturada antes.
  const idadeS = Math.abs(agora / 1000 - timestamp);
  if (idadeS > toleranciaS) {
    throw new AssinaturaStripeInvalida(`Timestamp fora da tolerância (${Math.round(idadeS)}s)`);
  }

  const corpo = Buffer.isBuffer(corpoRaw) ? corpoRaw : Buffer.from(String(corpoRaw), 'utf8');
  const esperado = crypto
    .createHmac('sha256', segredo)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), corpo]))
    .digest('hex');

  // Comparação em tempo constante: `===` vazaria informação pelo tempo de resposta.
  const confere = assinaturas.some((a) => {
    const A = Buffer.from(a, 'utf8');
    const B = Buffer.from(esperado, 'utf8');
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  });
  if (!confere) throw new AssinaturaStripeInvalida('Assinatura não confere');

  try {
    return JSON.parse(corpo.toString('utf8'));
  } catch {
    throw new AssinaturaStripeInvalida('Corpo do webhook não é JSON válido');
  }
}
