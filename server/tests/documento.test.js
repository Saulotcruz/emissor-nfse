import { describe, it, expect } from 'vitest';
import { apenasDigitos, cnpjValido, cpfValido, tipoDocumento } from '../services/documento.js';

describe('apenasDigitos', () => {
  it('remove máscara', () => {
    expect(apenasDigitos('11.222.333/0001-81')).toBe('11222333000181');
  });

  it('tolera nulo e indefinido', () => {
    expect(apenasDigitos(null)).toBe('');
    expect(apenasDigitos(undefined)).toBe('');
  });
});

describe('cnpjValido', () => {
  it('aceita CNPJ real com e sem máscara', () => {
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('19131243000197')).toBe(true);
  });

  it('rejeita dígito verificador errado', () => {
    expect(cnpjValido('11222333000182')).toBe(false);
  });

  it('rejeita comprimento errado e dígitos repetidos', () => {
    expect(cnpjValido('1122233300018')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
  });
});

describe('cpfValido', () => {
  it('aceita CPF com dígitos corretos', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
  });

  it('rejeita dígito errado e sequência repetida', () => {
    expect(cpfValido('52998224724')).toBe(false);
    expect(cpfValido('00000000000')).toBe(false);
  });
});

describe('tipoDocumento', () => {
  it('classifica por comprimento e validade', () => {
    expect(tipoDocumento('11222333000181')).toBe('cnpj');
    expect(tipoDocumento('529.982.247-25')).toBe('cpf');
  });

  it('devolve null quando o documento não fecha', () => {
    expect(tipoDocumento('11222333000182')).toBeNull();
    expect(tipoDocumento('123')).toBeNull();
  });
});
