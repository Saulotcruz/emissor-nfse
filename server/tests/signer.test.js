import { describe, it, expect, beforeAll } from 'vitest';
import {
  lerCertificado,
  assinarDps,
  verificarAssinatura,
  diasParaVencer,
  ALGORITMOS,
  C14N_EXCLUSIVA,
} from '../services/nfse/signer.js';
import { montarDps } from '../services/nfse/dps-builder.js';
import { gerarPfxDeTeste } from './helpers/certificado.js';
import { EMITENTE_FIXTURE, SERVICO_FIXTURE } from './fixtures/emitente.js';
import { temXmllint, validarDps } from './helpers/xsd.js';

const TOMADOR = {
  documento: '19131243000197',
  razao_social: 'OPEN KNOWLEDGE BRASIL',
  logradouro: 'AV PAULISTA',
  numero: '37',
  bairro: 'BELA VISTA',
  cep: '01311902',
  codigo_municipio: '3550308',
};

const NOTA = {
  numeroDps: 1,
  serie: '1',
  competencia: '2026-08-05',
  valorServico: 148.83,
  descricaoServico: 'Plano Essential mensal',
};

let pfx;
let certificado;
let xmlDps;

beforeAll(() => {
  pfx = gerarPfxDeTeste();
  certificado = lerCertificado({ buffer: pfx.buffer, senha: pfx.senha });
  xmlDps = montarDps({
    emitente: EMITENTE_FIXTURE,
    tomador: TOMADOR,
    servico: SERVICO_FIXTURE,
    nota: NOTA,
  }).xml;
});

describe('lerCertificado', () => {
  it('extrai chave privada, certificado e metadados do .pfx', () => {
    expect(certificado.privateKeyPem).toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    expect(certificado.certificatePem).toMatch(/BEGIN CERTIFICATE/);
    expect(certificado.titular).toContain('EMPRESA DE TESTE');
    expect(certificado.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('devolve o certificado em base64 puro, sem cabeçalho nem quebras de linha', () => {
    // É o formato exigido dentro de <X509Certificate> no XMLDSig.
    expect(certificado.certificateBase64).not.toMatch(/BEGIN|\n|\r/);
    expect(certificado.certificateBase64.length).toBeGreaterThan(100);
  });

  it('traduz senha errada em mensagem legível', () => {
    expect(() => lerCertificado({ buffer: pfx.buffer, senha: 'errada' }))
      .toThrow(/Senha do certificado incorreta/);
  });

  it('exige que a senha seja informada', () => {
    expect(() => lerCertificado({ buffer: pfx.buffer, senha: null }))
      .toThrow(/NFSE_CERT_PASSWORD/);
  });
});

describe('diasParaVencer', () => {
  it('conta os dias que faltam e fica negativo depois do vencimento', () => {
    // O certificado de teste vale de 2026-01-01 a 2027-01-01.
    expect(diasParaVencer(certificado, new Date('2026-12-02T00:00:00Z'))).toBe(30);
    expect(diasParaVencer(certificado, new Date('2027-01-11T00:00:00Z'))).toBeLessThan(0);
  });
});

// Este é o portão da Fase 2: se a assinatura não fecha offline,
// não adianta enviar nada para a SEFIN.
describe('assinarDps', () => {
  it('insere a Signature como irmã de infDPS, dentro de DPS', () => {
    const assinado = assinarDps(xmlDps, certificado);
    expect(assinado).toMatch(/<\/infDPS>\s*<(?:\w+:)?Signature/);
    expect(assinado).toMatch(/<\/(?:\w+:)?Signature>\s*<\/DPS>/);
  });

  it('referencia o infDPS pelo Id, não o documento inteiro', () => {
    const assinado = assinarDps(xmlDps, certificado);
    const id = xmlDps.match(/Id="([^"]+)"/)[1];
    expect(assinado).toContain(`URI="#${id}"`);
  });

  it('usa RSA-SHA256, canonicalização exclusiva e transform enveloped', () => {
    const assinado = assinarDps(xmlDps, certificado);
    expect(assinado).toContain(ALGORITMOS.sha256.signature);
    expect(assinado).toContain(ALGORITMOS.sha256.digest);
    expect(assinado).toContain(C14N_EXCLUSIVA);
    expect(assinado).toContain('http://www.w3.org/2000/09/xmldsig#enveloped-signature');
  });

  it('embute o certificado público no KeyInfo', () => {
    const assinado = assinarDps(xmlDps, certificado);
    expect(assinado).toContain('<X509Certificate>');
    expect(assinado).toContain(certificado.certificateBase64);
  });

  it('a assinatura gerada verifica offline', () => {
    const assinado = assinarDps(xmlDps, certificado);
    const { valido } = verificarAssinatura(assinado, certificado.certificatePem);
    expect(valido).toBe(true);
  });

  it('detecta adulteração do conteúdo assinado', () => {
    const assinado = assinarDps(xmlDps, certificado);
    const adulterado = assinado.replace('<vServ>148.83</vServ>', '<vServ>1.00</vServ>');
    expect(adulterado).not.toBe(assinado);
    const { valido } = verificarAssinatura(adulterado, certificado.certificatePem);
    expect(valido).toBe(false);
  });

  it('permite trocar para SHA1, caso a SEFIN rejeite SHA256 na Fase 3', () => {
    const assinado = assinarDps(xmlDps, certificado, { algoritmo: 'sha1' });
    expect(assinado).toContain(ALGORITMOS.sha1.signature);
    expect(verificarAssinatura(assinado, certificado.certificatePem).valido).toBe(true);
  });

  it('rejeita algoritmo desconhecido em vez de assinar errado em silêncio', () => {
    expect(() => assinarDps(xmlDps, certificado, { algoritmo: 'md5' })).toThrow(/desconhecido/);
  });
});

describe.runIf(temXmllint())('XML assinado', () => {
  it('continua válido contra o XSD depois de assinado', () => {
    const { valido, erros } = validarDps(assinarDps(xmlDps, certificado));
    expect(erros).toBe('');
    expect(valido).toBe(true);
  });
});
