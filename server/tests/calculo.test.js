import { describe, it, expect } from 'vitest';
import { arredondar, aplicarAliquota, apurarTributos } from '../services/calculo.js';

// Tributação de prestador de software no Lucro Presumido: ISS 2% não retido,
// PIS 0,65% e COFINS 3% de operação própria, sem nenhuma retenção federal.
const SERVICO = {
  aliquota_iss: 2,
  iss_retido: 0,
  aliquota_pis: 0.65,
  aliquota_cofins: 3,
  ret_pis: 0,
  ret_cofins: 0,
  ret_csll: 0,
  ret_inss: 0,
  ret_ir: 0,
};

describe('arredondar', () => {
  it('usa meio-para-cima em 2 casas', () => {
    expect(arredondar(2.9766)).toBe(2.98);
    expect(arredondar(0.9674)).toBe(0.97);
    expect(arredondar(4.4649)).toBe(4.46);
  });

  it('não escorrega no ponto flutuante', () => {
    expect(arredondar(1.005)).toBe(1.01);
    expect(arredondar(0.1 + 0.2)).toBe(0.3);
  });
});

describe('aplicarAliquota', () => {
  it('trata a alíquota como percentual', () => {
    expect(aplicarAliquota(100, 2)).toBe(2);
    expect(aplicarAliquota(148.83, 0.65)).toBe(0.97);
  });
});

// Regressão contra uma NFS-e real autorizada (DANFSe v2.0).
// Se algum destes números mudar, a nota emitida sai diferente da que a SEFIN autorizou.
describe('apurarTributos — conferido contra NFS-e real de R$ 148,83', () => {
  const r = apurarTributos({ valorServico: 148.83, servico: SERVICO });

  it('reproduz a base e o ISSQN apurado do documento', () => {
    expect(r.bcIssqn).toBe(148.83);
    expect(r.valorIss).toBe(2.98);
    expect(r.issRetido).toBe(false);
  });

  it('reproduz PIS e COFINS de débito de apuração própria', () => {
    expect(r.valorPis).toBe(0.97);
    expect(r.valorCofins).toBe(4.46);
  });

  it('não retém nada, então o líquido é igual ao valor da operação', () => {
    expect(r.totalRetencoes).toBe(0);
    expect(r.valorLiquido).toBe(148.83);
  });

  it('reproduz as exclusões da base do IBS/CBS (ISS + PIS + COFINS)', () => {
    expect(r.exclusoesBaseIbsCbs).toBe(8.41);
  });
});

describe('apurarTributos — deduções e retenções', () => {
  it('deduções reduzem a base do ISS, não o valor da operação', () => {
    const r = apurarTributos({ valorServico: 1000, deducoes: 200, servico: SERVICO });
    expect(r.bcIssqn).toBe(800);
    expect(r.valorIss).toBe(16);
    // PIS e COFINS continuam sobre o valor cheio.
    expect(r.valorPis).toBe(6.5);
    expect(r.valorCofins).toBe(30);
  });

  it('ISS retido entra no total das retenções e reduz o líquido', () => {
    const r = apurarTributos({
      valorServico: 1000,
      servico: { ...SERVICO, iss_retido: 1 },
    });
    expect(r.retencoes.iss).toBe(20);
    expect(r.totalRetencoes).toBe(20);
    expect(r.valorLiquido).toBe(980);
  });

  it('soma retenções federais quando configuradas', () => {
    const r = apurarTributos({
      valorServico: 1000,
      servico: { ...SERVICO, ret_pis: 0.65, ret_cofins: 3, ret_csll: 1, ret_ir: 1.5 },
    });
    expect(r.totalRetencoes).toBe(61.5);
    expect(r.valorLiquido).toBe(938.5);
  });

  it('rejeita valor inválido e dedução maior que o serviço', () => {
    expect(() => apurarTributos({ valorServico: 0, servico: SERVICO })).toThrow(/inválido/i);
    expect(() => apurarTributos({ valorServico: 100, deducoes: 200, servico: SERVICO }))
      .toThrow(/Deduções maiores/i);
  });
});
