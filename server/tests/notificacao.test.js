import { describe, it, expect } from 'vitest';
import {
  montarMensagem,
  nomeArquivoXml,
  notificacaoAtiva,
  notificarEmissao,
} from '../services/alertas/notificacao.js';

const NOTA = {
  id: 3,
  serie: '1',
  numero_dps: 3,
  numero_nfse: '30',
  chave_acesso: '31567002251675482000110000000000030260873764566900'.slice(0, 50),
  competencia: '2026-08-07',
  valor_servico: '1.00',
  descricao_servico: 'Emissão de teste',
  valor_iss: '0.02',
  valor_pis: '0.01',
  valor_cofins: '0.03',
  ambiente: 'producao',
  nfse_xml: '<NFSe versao="1.01"><infNFSe/></NFSe>',
};
const TOMADOR = { razao_social: 'EMPRESA CLIENTE LTDA', documento: '19131243000197' };
const EMITENTE = { razao_social: 'EMPRESA DE TESTE LTDA' };

describe('montarMensagem', () => {
  it('traz identificação da nota, valor e tributos apurados', () => {
    const { assunto, texto } = montarMensagem({ nota: NOTA, tomador: TOMADOR, emitente: EMITENTE });

    expect(assunto).toContain('Nota 30 emitida');
    expect(assunto).toContain('EMPRESA CLIENTE LTDA');
    expect(assunto).toContain('R$ 1.00');

    expect(texto).toContain(NOTA.chave_acesso);
    expect(texto).toContain('série 1 nº 3');
    expect(texto).toContain('ISSQN       R$ 0.02');
    expect(texto).toContain('PIS         R$ 0.01');
    expect(texto).toContain('COFINS      R$ 0.03');
  });

  // Um aviso de teste que se pareça com um de produção é convite a confusão.
  it('marca claramente quando a nota é de produção restrita', () => {
    const { assunto, texto } = montarMensagem({
      nota: { ...NOTA, ambiente: 'producao_restrita' },
      tomador: TOMADOR,
      emitente: EMITENTE,
    });
    expect(assunto).toContain('[TESTE]');
    expect(texto).toContain('NÃO tem efeito fiscal');
  });

  it('não quebra quando os tributos não foram gravados', () => {
    const { texto } = montarMensagem({
      nota: { ...NOTA, valor_iss: null, valor_pis: null, valor_cofins: null },
      tomador: TOMADOR,
      emitente: EMITENTE,
    });
    expect(texto).toContain('ISSQN       R$ —');
  });
});

describe('nomeArquivoXml', () => {
  it('usa a chave de acesso, que é única', () => {
    expect(nomeArquivoXml(NOTA)).toBe(`nfse-${NOTA.chave_acesso}.xml`);
  });

  it('cai para série e número quando ainda não há chave', () => {
    expect(nomeArquivoXml({ ...NOTA, chave_acesso: null })).toBe('nfse-1-3.xml');
  });
});

describe('notificacaoAtiva', () => {
  it('vem ligada por padrão e desliga com NOTIFICAR_EMISSAO=0', () => {
    expect(notificacaoAtiva({})).toBe(true);
    expect(notificacaoAtiva({ NOTIFICAR_EMISSAO: '1' })).toBe(true);
    expect(notificacaoAtiva({ NOTIFICAR_EMISSAO: '0' })).toBe(false);
  });
});

describe('notificarEmissao', () => {
  it('não envia quando está desligada', async () => {
    const r = await notificarEmissao({
      nota: NOTA,
      tomador: TOMADOR,
      emitente: EMITENTE,
      env: { NOTIFICAR_EMISSAO: '0' },
    });
    expect(r).toEqual({ enviado: false, motivo: 'notificação desligada' });
  });

  it('não envia nota sem XML — o anexo é o ponto do aviso', async () => {
    const r = await notificarEmissao({
      nota: { ...NOTA, nfse_xml: null },
      tomador: TOMADOR,
      emitente: EMITENTE,
      env: {},
    });
    expect(r.motivo).toBe('nota sem XML');
  });

  // Devolve o motivo em vez de estourar: a nota já está autorizada na SEFIN, e
  // uma exceção aqui faria a emissão parecer malsucedida.
  it('devolve o motivo quando o SMTP não está configurado, sem lançar', async () => {
    const r = await notificarEmissao({ nota: NOTA, tomador: TOMADOR, emitente: EMITENTE, env: {} });
    expect(r.enviado).toBe(false);
    expect(r.motivo).toMatch(/SMTP_HOST/);
  });
});
