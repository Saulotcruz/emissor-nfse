import { describe, it, expect } from 'vitest';
import { normalizar } from '../services/brasilapi.js';

// Retorno real da BrasilAPI, reduzido aos campos que o mapeamento usa.
const RETORNO = {
  cnpj: '19131243000197',
  razao_social: 'OPEN KNOWLEDGE BRASIL',
  nome_fantasia: 'REDE PELO CONHECIMENTO LIVRE',
  email: null,
  ddd_telefone_1: '1123851939',
  logradouro: 'PAULISTA 37',
  numero: '37',
  complemento: 'ANDAR 4',
  bairro: 'BELA VISTA',
  cep: '01311902',
  municipio: 'SAO PAULO',
  uf: 'SP',
  codigo_municipio: 7107,
};

describe('normalizar', () => {
  it('mapeia os campos da BrasilAPI para as colunas de tomador', () => {
    const t = normalizar(RETORNO);
    expect(t).toMatchObject({
      tipo_doc: 'cnpj',
      documento: '19131243000197',
      razao_social: 'OPEN KNOWLEDGE BRASIL',
      logradouro: 'PAULISTA 37',
      numero: '37',
      bairro: 'BELA VISTA',
      cep: '01311902',
      uf: 'SP',
    });
  });

  it('substitui número vazio por S/N, que a SEFIN exige preenchido', () => {
    expect(normalizar({ ...RETORNO, numero: '' }).numero).toBe('S/N');
  });

  it('não propaga o código de município da BrasilAPI, que é SIAFI e não IBGE', () => {
    // A DPS exige IBGE de 7 dígitos; 7107 é SIAFI. Deixar null evita gravar o código errado.
    expect(normalizar(RETORNO).codigo_municipio).toBeNull();
    expect(normalizar(RETORNO).municipio_nome).toBe('SAO PAULO');
  });

  it('converte string vazia em null nos campos opcionais', () => {
    const t = normalizar({ ...RETORNO, nome_fantasia: '', email: '', complemento: '' });
    expect(t.nome_fantasia).toBeNull();
    expect(t.email).toBeNull();
    expect(t.complemento).toBeNull();
  });
});
