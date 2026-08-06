import crypto from 'node:crypto';

/**
 * Fatura da Stripe no formato do webhook `invoice.payment_succeeded`,
 * reduzida aos campos que o mapper usa. CNPJ e ids são fictícios.
 */
export function faturaPaga(over = {}) {
  return {
    id: 'in_1TesteAbc',
    object: 'invoice',
    customer: 'cus_TesteAbc',
    customer_name: 'EMPRESA CLIENTE LTDA',
    customer_email: 'financeiro@example.com',
    customer_tax_ids: [{ type: 'br_cnpj', value: '19.131.243/0001-97' }],
    currency: 'brl',
    amount_paid: 14883,
    period_start: 1754352000,
    period_end: 1756944000,
    billing_reason: 'subscription_cycle',
    metadata: {},
    lines: {
      data: [{ description: 'GLink - Essential mensal', amount: 14883, period: { start: 1754352000, end: 1756944000 } }],
    },
    // Formato pré-Basil; o mapper também aceita parent.subscription_details.
    subscription: 'sub_TesteAbc',
    ...over,
  };
}

export function eventoFaturaPaga(over = {}, faturaOver = {}) {
  return {
    id: 'evt_1TesteAbc',
    object: 'event',
    type: 'invoice.payment_succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: faturaPaga(faturaOver) },
    ...over,
  };
}

/** Assina um corpo como a Stripe faria, para exercitar a verificação real. */
export function assinarComoStripe(corpo, segredo, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const payload = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  const assinatura = crypto
    .createHmac('sha256', segredo)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return { corpo: payload, header: `t=${timestamp},v1=${assinatura}` };
}
