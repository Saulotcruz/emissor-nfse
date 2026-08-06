import { describe, it, expect } from 'vitest';
import {
  mapearFatura,
  extrairDocumento,
  extrairSubscriptionId,
  montarDescricao,
  FaturaNaoEmiteNota,
  CAMPO_METADATA_DOC,
} from '../services/stripe/mapper.js';
import { verificarEvento, analisarHeader, AssinaturaStripeInvalida } from '../services/stripe/webhook.js';
import { faturaPaga, eventoFaturaPaga, assinarComoStripe } from './fixtures/stripe.js';

const SEGREDO = 'whsec_teste_1234567890';

describe('extrairDocumento', () => {
  it('lê o CNPJ do Tax ID da fatura, limpando a máscara', () => {
    const d = extrairDocumento(faturaPaga());
    expect(d).toEqual({ documento: '19131243000197', tipo: 'cnpj', origem: 'tax_id:br_cnpj' });
  });

  it('aceita CPF (br_cpf) para tomador pessoa física', () => {
    const d = extrairDocumento(faturaPaga({ customer_tax_ids: [{ type: 'br_cpf', value: '529.982.247-25' }] }));
    expect(d).toMatchObject({ documento: '52998224725', tipo: 'cpf' });
  });

  it('ignora Tax ID estrangeiro e cai no metadata', () => {
    const d = extrairDocumento(
      faturaPaga({
        customer_tax_ids: [{ type: 'eu_vat', value: 'DE123456789' }],
        metadata: { [CAMPO_METADATA_DOC]: '19131243000197' },
      })
    );
    expect(d).toMatchObject({ documento: '19131243000197', origem: 'metadata' });
  });

  // Um Tax ID digitado errado não pode virar nota: melhor falhar aqui.
  it('descarta documento com dígito verificador inválido', () => {
    expect(extrairDocumento(faturaPaga({ customer_tax_ids: [{ type: 'br_cnpj', value: '19131243000198' }] }))).toBeNull();
  });

  it('devolve null quando não há Tax ID nem metadata', () => {
    expect(extrairDocumento(faturaPaga({ customer_tax_ids: [] }))).toBeNull();
  });
});

describe('extrairSubscriptionId', () => {
  it('aceita o formato antigo e o da API Basil', () => {
    expect(extrairSubscriptionId(faturaPaga())).toBe('sub_TesteAbc');
    expect(
      extrairSubscriptionId(
        faturaPaga({ subscription: undefined, parent: { subscription_details: { subscription: 'sub_Basil' } } })
      )
    ).toBe('sub_Basil');
  });

  it('devolve null em cobrança avulsa', () => {
    expect(extrairSubscriptionId(faturaPaga({ subscription: undefined }))).toBeNull();
  });
});

describe('montarDescricao', () => {
  it('usa a descrição dos itens da fatura', () => {
    expect(montarDescricao(faturaPaga())).toBe('GLink - Essential mensal');
  });

  it('junta itens distintos e não repete iguais', () => {
    const lines = { data: [{ description: 'Plano A' }, { description: 'Plano A' }, { description: 'Adicional' }] };
    expect(montarDescricao(faturaPaga({ lines }))).toBe('Plano A | Adicional');
  });

  it('cai no texto padrão quando não há itens', () => {
    expect(montarDescricao(faturaPaga({ lines: { data: [] } }))).toBe('Prestação de serviços');
  });
});

describe('mapearFatura', () => {
  it('converte a fatura no payload de emissão', () => {
    expect(mapearFatura(faturaPaga())).toMatchObject({
      stripeInvoiceId: 'in_1TesteAbc',
      stripeCustomerId: 'cus_TesteAbc',
      stripeSubscriptionId: 'sub_TesteAbc',
      documento: '19131243000197',
      tipoDocumento: 'cnpj',
      razaoSocial: 'EMPRESA CLIENTE LTDA',
      valorServico: 148.83,
      descricaoServico: 'GLink - Essential mensal',
    });
  });

  // Recusas de negócio, não erros: o webhook responde 200 e segue a vida.
  it('não emite para fatura de valor zero (trial)', () => {
    expect(() => mapearFatura(faturaPaga({ amount_paid: 0 }))).toThrow(FaturaNaoEmiteNota);
  });

  it('não emite para moeda diferente de BRL', () => {
    expect(() => mapearFatura(faturaPaga({ currency: 'usd' }))).toThrow(/USD/);
  });

  it('não emite sem documento do tomador, dizendo onde preencher', () => {
    expect(() => mapearFatura(faturaPaga({ customer_tax_ids: [] }))).toThrow(/Tax ID/);
  });
});

describe('verificarEvento', () => {
  it('aceita assinatura válida e devolve o evento', () => {
    const { corpo, header } = assinarComoStripe(eventoFaturaPaga(), SEGREDO);
    expect(verificarEvento(Buffer.from(corpo), header, SEGREDO).type).toBe('invoice.payment_succeeded');
  });

  it('recusa assinatura de outro segredo', () => {
    const { corpo, header } = assinarComoStripe(eventoFaturaPaga(), 'whsec_outro');
    expect(() => verificarEvento(Buffer.from(corpo), header, SEGREDO)).toThrow(/não confere/);
  });

  // Se o corpo for reserializado antes da conferência, a assinatura quebra.
  it('recusa corpo alterado depois de assinado', () => {
    const { corpo, header } = assinarComoStripe(eventoFaturaPaga(), SEGREDO);
    const adulterado = corpo.replace('14883', '99999');
    expect(() => verificarEvento(Buffer.from(adulterado), header, SEGREDO)).toThrow(/não confere/);
  });

  it('recusa evento antigo, o que barra reenvio de requisição capturada', () => {
    const antigo = Math.floor(Date.now() / 1000) - 3600;
    const { corpo, header } = assinarComoStripe(eventoFaturaPaga(), SEGREDO, { timestamp: antigo });
    expect(() => verificarEvento(Buffer.from(corpo), header, SEGREDO)).toThrow(/tolerância/);
  });

  it('recusa header ausente ou malformado e segredo não configurado', () => {
    const { corpo, header } = assinarComoStripe(eventoFaturaPaga(), SEGREDO);
    expect(() => verificarEvento(Buffer.from(corpo), '', SEGREDO)).toThrow(AssinaturaStripeInvalida);
    expect(() => verificarEvento(Buffer.from(corpo), 'lixo', SEGREDO)).toThrow(/malformado/);
    expect(() => verificarEvento(Buffer.from(corpo), header, '')).toThrow(/não configurado/);
  });

  it('analisa header com múltiplas assinaturas v1', () => {
    const { timestamp, assinaturas } = analisarHeader('t=123,v1=aaa,v1=bbb');
    expect(timestamp).toBe(123);
    expect(assinaturas).toEqual(['aaa', 'bbb']);
  });
});
