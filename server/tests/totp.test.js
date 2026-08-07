import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  gerarSegredo,
  codigoTotp,
  contadorAtual,
  verificarTotp,
  uriOtpauth,
  gerarCodigosBackup,
  PASSO_S,
} from '../services/mfa/totp.js';

describe('base32', () => {
  // Vetores do RFC 4648.
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('codifica %o como %o', (texto, esperado) => {
    expect(base32Encode(Buffer.from(texto))).toBe(esperado);
  });

  it('decodifica de volta ao original', () => {
    for (const t of ['f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      expect(base32Decode(base32Encode(Buffer.from(t))).toString()).toBe(t);
    }
  });

  // Autenticadores mostram o segredo em grupos; colar de lá não pode quebrar.
  it('ignora espaços, hífens e o padding', () => {
    expect(base32Decode('MZXW 6YTB-OI==')).toEqual(base32Decode('MZXW6YTBOI'));
  });

  it('recusa caractere fora do alfabeto', () => {
    expect(() => base32Decode('MZXW1')).toThrow(/base32/i);
  });
});

describe('codigoTotp', () => {
  /**
   * Vetores do RFC 6238 (apêndice B), variante SHA1: o segredo é a string
   * ASCII "12345678901234567890". Se estes passam, o código gerado aqui é o
   * mesmo que o Google Authenticator espera.
   */
  const SEGREDO = base32Encode(Buffer.from('12345678901234567890'));

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('em t=%i devolve %s', (segundos, esperado) => {
    expect(codigoTotp(SEGREDO, Math.floor(segundos / PASSO_S))).toBe(esperado);
  });

  it('sempre devolve 6 dígitos, inclusive com zero à esquerda', () => {
    for (let c = 0; c < 200; c += 1) {
      expect(codigoTotp(SEGREDO, c)).toMatch(/^\d{6}$/);
    }
  });
});

describe('verificarTotp', () => {
  const segredo = gerarSegredo();
  const agora = 1_700_000_000_000;
  const codigoDe = (deslocamento = 0) =>
    codigoTotp(segredo, contadorAtual(agora) + deslocamento);

  it('aceita o código do intervalo atual', () => {
    expect(verificarTotp(segredo, codigoDe(0), { agora })).toBe(contadorAtual(agora));
  });

  // Relógio de celular fora de hora é comum; ±30s é a tolerância usual.
  it('aceita o intervalo anterior e o seguinte', () => {
    expect(verificarTotp(segredo, codigoDe(-1), { agora })).not.toBeNull();
    expect(verificarTotp(segredo, codigoDe(1), { agora })).not.toBeNull();
  });

  it('recusa fora da janela', () => {
    expect(verificarTotp(segredo, codigoDe(-2), { agora })).toBeNull();
    expect(verificarTotp(segredo, codigoDe(2), { agora })).toBeNull();
  });

  it('recusa código malformado sem explodir', () => {
    for (const lixo of [null, undefined, '', '12345', '1234567', 'abcdef', {}]) {
      expect(verificarTotp(segredo, lixo, { agora })).toBeNull();
    }
  });

  // Sem isto, um código visto por cima do ombro vale pelos 30 segundos dele.
  it('recusa reapresentação do mesmo código', () => {
    const codigo = codigoDe(0);
    const contador = verificarTotp(segredo, codigo, { agora });
    expect(contador).not.toBeNull();
    expect(verificarTotp(segredo, codigo, { agora, contadorMinimo: contador })).toBeNull();
  });

  it('recusa também um código anterior ao último usado', () => {
    const contador = contadorAtual(agora);
    expect(verificarTotp(segredo, codigoDe(-1), { agora, contadorMinimo: contador })).toBeNull();
  });

  it('deixa passar o código seguinte depois de um uso', () => {
    const contador = contadorAtual(agora);
    expect(verificarTotp(segredo, codigoDe(1), { agora, contadorMinimo: contador })).toBe(contador + 1);
  });

  it('recusa código de outro segredo', () => {
    expect(verificarTotp(gerarSegredo(), codigoDe(0), { agora })).toBeNull();
  });
});

describe('segredo e URI', () => {
  it('gera segredos distintos e de tamanho utilizável', () => {
    const a = gerarSegredo();
    const b = gerarSegredo();
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
  });

  it('monta a URI que o autenticador espera', () => {
    const uri = uriOtpauth({ segredo: 'ABC234', conta: 'saulo@example.com' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=ABC234');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(decodeURIComponent(uri)).toContain('Emissor NFS-e:saulo@example.com');
  });
});

describe('códigos de recuperação', () => {
  it('gera dez códigos únicos no formato agrupado', () => {
    const codigos = gerarCodigosBackup();
    expect(codigos).toHaveLength(10);
    expect(new Set(codigos).size).toBe(10);
    for (const c of codigos) expect(c).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});
