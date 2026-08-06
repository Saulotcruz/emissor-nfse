import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { pool } from '../db/pool.js';
import { resetDb, createTomador } from './helpers/db.js';
import { eventoFaturaPaga, assinarComoStripe } from './fixtures/stripe.js';
import { registrarEvento, processarFatura, resolverTomador } from '../services/stripe/processador.js';
import { aguardarProcessamento } from '../routes/stripe.js';
import { faturaPaga } from './fixtures/stripe.js';

const SEGREDO = 'whsec_teste_1234567890';
const app = createApp();

beforeEach(async () => {
  // O webhook responde antes de terminar de emitir; sem esperar, o trabalho de
  // um teste vazaria para o próximo.
  await aguardarProcessamento();
  await resetDb();
  process.env.STRIPE_WEBHOOK_SECRET = SEGREDO;
  // A BrasilAPI não é chamada nos testes: o tomador é criado a partir do que
  // vem da própria fatura.
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

function enviar(evento = eventoFaturaPaga(), { segredo = SEGREDO } = {}) {
  const { corpo, header } = assinarComoStripe(evento, segredo);
  // Envia a STRING, não um Buffer: com Content-Type json o supertest serializa
  // o Buffer como {"type":"Buffer","data":[…]} e a assinatura deixa de bater.
  return request(app)
    .post('/api/stripe/webhook')
    .set('stripe-signature', header)
    .set('Content-Type', 'application/json')
    .send(corpo);
}

describe('POST /api/stripe/webhook', () => {
  it('recusa requisição sem assinatura válida', async () => {
    const r = await enviar(eventoFaturaPaga(), { segredo: 'whsec_errado' });
    expect(r.status).toBe(400);
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM stripe_evento');
    expect(total).toBe(0);
  });

  it('recusa requisição sem o header', async () => {
    const r = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(r.status).toBe(400);
  });

  it('ignora eventos de outros tipos sem gravar nada', async () => {
    const r = await enviar(eventoFaturaPaga({ type: 'customer.created' }));
    expect(r.status).toBe(200);
    expect(r.body.ignorado).toBe('customer.created');
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM stripe_evento');
    expect(total).toBe(0);
  });

  it('aceita o evento e registra o payload bruto', async () => {
    const r = await enviar();
    expect(r.status).toBe(200);
    expect(r.body.recebido).toBe(true);

    await aguardarProcessamento();
    const [[ev]] = await pool.query('SELECT * FROM stripe_evento WHERE stripe_event_id = ?', ['evt_1TesteAbc']);
    expect(ev.tipo).toBe('invoice.payment_succeeded');
    expect(JSON.parse(ev.payload).data.object.id).toBe('in_1TesteAbc');
  });

  // A Stripe entrega "pelo menos uma vez": reentrega é rotina, não exceção.
  it('trata reentrega do mesmo evento como duplicado', async () => {
    await enviar();
    await aguardarProcessamento();
    const r = await enviar();
    expect(r.status).toBe(200);
    expect(r.body.duplicado).toBe(true);

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM stripe_evento');
    expect(total).toBe(1);
  });
});

describe('registrarEvento', () => {
  it('devolve novo=false na segunda vez, sem duplicar', async () => {
    const evento = eventoFaturaPaga();
    const a = await registrarEvento(evento);
    const b = await registrarEvento(evento);
    expect(a.novo).toBe(true);
    expect(b.novo).toBe(false);
    expect(b.id).toBe(a.id);
  });
});

describe('resolverTomador', () => {
  it('acha pelo stripe_customer_id', async () => {
    const t = await createTomador({ stripe_customer_id: 'cus_TesteAbc' });
    const achado = await resolverTomador({ stripeCustomerId: 'cus_TesteAbc', documento: '000' });
    expect(achado.id).toBe(t.id);
  });

  // Cliente cadastrado à mão antes de aparecer na Stripe: o vínculo é criado
  // na primeira fatura, sem duplicar cadastro.
  it('acha pelo documento e grava o stripe_customer_id que faltava', async () => {
    const t = await createTomador({ documento: '19131243000197' });
    const achado = await resolverTomador({
      stripeCustomerId: 'cus_Novo',
      documento: '19131243000197',
      tipoDocumento: 'cnpj',
    });
    expect(achado.id).toBe(t.id);

    const [[atualizado]] = await pool.query('SELECT stripe_customer_id FROM tomador WHERE id = ?', [t.id]);
    expect(atualizado.stripe_customer_id).toBe('cus_Novo');
  });

  it('cria o tomador com os dados da própria fatura quando é desconhecido', async () => {
    const criado = await resolverTomador({
      stripeCustomerId: 'cus_Outro',
      documento: '52998224725',
      tipoDocumento: 'cpf',
      razaoSocial: 'FULANO DE TAL',
      email: 'fulano@example.com',
    });
    expect(criado.razao_social).toBe('FULANO DE TAL');
    expect(criado.origem).toBe('stripe');
    expect(criado.tipo_doc).toBe('cpf');
  });

  // Duas faturas do mesmo cliente novo podem chegar juntas: as duas consultam,
  // nenhuma acha, e as duas tentam inserir. Só uma pode ganhar.
  it('não duplica nem estoura quando duas faturas do mesmo cliente novo chegam juntas', async () => {
    const dados = {
      stripeCustomerId: 'cus_Corrida',
      documento: '52998224725',
      tipoDocumento: 'cpf',
      razaoSocial: 'FULANO DE TAL',
    };
    const resultados = await Promise.all([
      resolverTomador(dados),
      resolverTomador(dados),
      resolverTomador(dados),
    ]);
    expect(new Set(resultados.map((t) => t.id)).size).toBe(1);

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM tomador WHERE documento = ?', [
      dados.documento,
    ]);
    expect(total).toBe(1);
  });

  it('exige razão social para não cadastrar tomador anônimo', async () => {
    await expect(
      resolverTomador({ stripeCustomerId: 'cus_X', documento: '52998224725', tipoDocumento: 'cpf' })
    ).rejects.toThrow(/razão social/);
  });
});

describe('processarFatura', () => {
  it('reserva a nota com os dados da fatura', async () => {
    await createTomador({ documento: '19131243000197', stripe_customer_id: 'cus_TesteAbc' });
    const r = await processarFatura(faturaPaga(), { emitir: false });

    expect(r.status).toBe('reservada');
    const [[nota]] = await pool.query('SELECT * FROM nota WHERE id = ?', [r.notaId]);
    expect(nota.origem).toBe('stripe');
    expect(nota.stripe_invoice_id).toBe('in_1TesteAbc');
    expect(nota.stripe_subscription_id).toBe('sub_TesteAbc');
    expect(Number(nota.valor_servico)).toBe(148.83);
    expect(nota.descricao_servico).toBe('GLink - Essential mensal');
  });

  // Última barreira: mesmo que dois eventos distintos tragam a mesma fatura.
  it('não gera segunda nota para a mesma fatura', async () => {
    await createTomador({ documento: '19131243000197', stripe_customer_id: 'cus_TesteAbc' });
    const a = await processarFatura(faturaPaga(), { emitir: false });
    const b = await processarFatura(faturaPaga(), { emitir: false });

    expect(b.status).toBe('ja_processada');
    expect(b.notaId).toBe(a.notaId);
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM nota');
    expect(total).toBe(1);
  });

  it('ignora trial e moeda estrangeira sem criar nota', async () => {
    expect((await processarFatura(faturaPaga({ amount_paid: 0 }))).status).toBe('ignorada');
    expect((await processarFatura(faturaPaga({ currency: 'usd' }))).status).toBe('ignorada');
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM nota');
    expect(total).toBe(0);
  });
});
