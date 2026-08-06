import { Router } from 'express';
import { verificarEvento, AssinaturaStripeInvalida } from '../services/stripe/webhook.js';
import {
  EVENTO_SUPORTADO,
  registrarEvento,
  processarFatura,
  concluirEvento,
} from '../services/stripe/processador.js';

const router = Router();

/**
 * Promessas do processamento em background que ainda não terminaram.
 * Produção não usa; existe para os testes conseguirem esperar o trabalho
 * assíncrono em vez de dormir por um tempo arbitrário.
 */
const emAndamento = new Set();

export function aguardarProcessamento() {
  return Promise.allSettled([...emAndamento]);
}

/**
 * Webhook da Stripe.
 *
 * O corpo chega como Buffer (o `express.raw` está montado nesta rota em app.js,
 * antes do express.json global) porque a assinatura é calculada sobre os bytes
 * exatos — reserializar o JSON invalidaria a verificação.
 *
 * Responde 200 antes de emitir: a Stripe corta em poucos segundos e trataria o
 * atraso como falha, reenviando o evento. O processamento segue em background,
 * e o resultado fica em `stripe_evento` e em `nota`.
 */
router.post('/webhook', async (req, res) => {
  let evento;
  try {
    evento = verificarEvento(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    if (e instanceof AssinaturaStripeInvalida) {
      console.warn(`Webhook Stripe recusado: ${e.message}`);
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }

  if (evento.type !== EVENTO_SUPORTADO) {
    return res.json({ recebido: true, ignorado: evento.type });
  }

  const registro = await registrarEvento(evento);
  if (!registro.novo) {
    // Reentrega: a Stripe garante "pelo menos uma vez", então repetir é normal.
    return res.json({ recebido: true, duplicado: true });
  }

  res.json({ recebido: true });

  const trabalho = (async () => {
    try {
      const r = await processarFatura(evento.data.object);
      await concluirEvento(registro.id, { erro: r.status === 'ignorada' ? r.motivo : null });
      console.log(`Stripe ${evento.id}: ${r.status}${r.notaId ? ` (nota #${r.notaId})` : ''}`);
    } catch (e) {
      await concluirEvento(registro.id, { erro: e.message });
      console.error(`Stripe ${evento.id} falhou: ${e.message}`);
    } finally {
      emAndamento.delete(trabalho);
    }
  })();
  emAndamento.add(trabalho);
});

export default router;
