import { describe, it, expect } from 'vitest';
import { numeroDoAmbiente, emitenteDoAmbiente, servicoDoAmbiente } from '../db/seed.js';

const ENV_MINIMO = {
  EMITENTE_CNPJ: '11.222.333/0001-81',
  EMITENTE_RAZAO_SOCIAL: 'EMPRESA DE TESTE LTDA',
  EMITENTE_CODIGO_MUNICIPIO: '3106200',
  SERVICO_CODIGO: '010501',
  SERVICO_DESCRICAO: 'Licenciamento de software',
};

describe('numeroDoAmbiente', () => {
  it('aceita ponto e vírgula como separador decimal', () => {
    expect(numeroDoAmbiente('0.65', 'X')).toBe(0.65);
    expect(numeroDoAmbiente('0,65', 'X')).toBe(0.65);
    expect(numeroDoAmbiente('2', 'X')).toBe(2);
  });

  it('vazio vira o padrão, não NaN', () => {
    expect(numeroDoAmbiente('', 'X')).toBe(0);
    expect(numeroDoAmbiente(undefined, 'X')).toBe(0);
    expect(numeroDoAmbiente('   ', 'X')).toBe(0);
  });

  // "2%" faz Number() devolver NaN. Passar batido gravaria alíquota inválida e
  // a nota sairia com tributo errado — por isso falha alto, com a correção pronta.
  it('recusa o símbolo % dizendo exatamente o que escrever', () => {
    expect(() => numeroDoAmbiente('2%', 'SERVICO_ALIQUOTA_ISS'))
      .toThrow('SERVICO_ALIQUOTA_ISS="2%": não use o símbolo %. A alíquota já é percentual — escreva 2');
    expect(() => numeroDoAmbiente('0,65%', 'SERVICO_ALIQUOTA_PIS')).toThrow(/escreva 0\.65/);
  });

  it('recusa texto e valor negativo', () => {
    expect(() => numeroDoAmbiente('dois', 'X')).toThrow(/não é um número válido/);
    expect(() => numeroDoAmbiente('-1', 'X')).toThrow(/não pode ser negativo/);
  });
});

describe('emitenteDoAmbiente', () => {
  it('limpa máscara do CNPJ, do CEP e do telefone', () => {
    const e = emitenteDoAmbiente({
      ...ENV_MINIMO,
      EMITENTE_CEP: '34.710-070',
      EMITENTE_TELEFONE: '(31) 9120-8144',
    });
    expect(e.cnpj).toBe('11222333000181');
    expect(e.cep).toBe('34710070');
    expect(e.telefone).toBe('3191208144');
  });

  it('exige código IBGE de 7 dígitos', () => {
    expect(() => emitenteDoAmbiente({ ...ENV_MINIMO, EMITENTE_CODIGO_MUNICIPIO: '31567' }))
      .toThrow(/7 dígitos/);
  });

  it('lista todas as variáveis obrigatórias que faltam', () => {
    expect(() => emitenteDoAmbiente({})).toThrow(
      /EMITENTE_CNPJ, EMITENTE_RAZAO_SOCIAL, EMITENTE_CODIGO_MUNICIPIO/
    );
  });

  it('só entra em produção com NFSE_AMBIENTE explícito', () => {
    expect(emitenteDoAmbiente(ENV_MINIMO).ambiente).toBe('producao_restrita');
    expect(emitenteDoAmbiente({ ...ENV_MINIMO, NFSE_AMBIENTE: 'producao' }).ambiente).toBe('producao');
    // Qualquer valor estranho cai no ambiente seguro, não em produção.
    expect(emitenteDoAmbiente({ ...ENV_MINIMO, NFSE_AMBIENTE: 'prod' }).ambiente).toBe('producao_restrita');
  });
});

describe('servicoDoAmbiente', () => {
  it('converte as alíquotas informadas corretamente', () => {
    const s = servicoDoAmbiente({
      ...ENV_MINIMO,
      SERVICO_ALIQUOTA_ISS: '2',
      SERVICO_ALIQUOTA_PIS: '0.65',
      SERVICO_ALIQUOTA_COFINS: '3',
    });
    expect(s.aliquota_iss).toBe(2);
    expect(s.aliquota_pis).toBe(0.65);
    expect(s.aliquota_cofins).toBe(3);
    expect(s.ret_pis).toBe(0);
  });

  it('aponta a variável exata quando a alíquota vem com %', () => {
    expect(() => servicoDoAmbiente({ ...ENV_MINIMO, SERVICO_ALIQUOTA_COFINS: '3%' }))
      .toThrow(/SERVICO_ALIQUOTA_COFINS/);
  });
});
