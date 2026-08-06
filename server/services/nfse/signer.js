import fs from 'node:fs';
import { SignedXml } from 'xml-crypto';
import forge from 'node-forge';

/**
 * Assinatura XMLDSig da DPS.
 *
 * O que o XSD define (schemas/1.01/tiposComplexos_v1.01.xsd, tipo TCDPS):
 *   <DPS><infDPS Id="DPS..."/><ds:Signature/></DPS>
 * ou seja, a assinatura é irmã de `infDPS`, e é o `infDPS` que é referenciado
 * pelo atributo `Id` — assinatura *enveloped*.
 *
 * Algoritmos: o padrão do Sistema Nacional NFS-e é RSA-SHA256 com canonicalização
 * exclusiva. Ficam configuráveis porque a confirmação definitiva só vem quando a
 * Produção Restrita aceitar ou rejeitar (Fase 3) — se rejeitar por assinatura, o
 * primeiro teste é trocar para SHA1, que é o padrão histórico da NF-e.
 */

export const ALGORITMOS = {
  sha256: {
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  },
  sha1: {
    signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  },
};

export const C14N_EXCLUSIVA = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const TRANSFORM_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * Extrai chave privada e certificado de um .pfx/.p12 (A1).
 * O Node consome o .pfx direto no mTLS, mas o xml-crypto precisa de PEM — daí
 * o node-forge no meio.
 */
export function lerCertificado({ caminho, buffer, senha }) {
  const conteudo = buffer ?? fs.readFileSync(caminho);
  if (senha === undefined || senha === null) {
    throw new Error('Senha do certificado não informada (NFSE_CERT_PASSWORD)');
  }

  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(conteudo.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, senha);
  } catch (e) {
    // A mensagem do forge para senha errada é críptica; vale traduzir.
    if (/Invalid password|MAC/i.test(e.message)) {
      throw new Error('Senha do certificado incorreta ou arquivo .pfx corrompido');
    }
    throw e;
  }

  const bagChave =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const bagsCert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];

  if (!bagChave?.key) throw new Error('Chave privada não encontrada no certificado');
  if (!bagsCert.length) throw new Error('Certificado não encontrado no arquivo');

  // O primeiro bag é o certificado do titular; os demais, quando existem, são
  // os intermediários da cadeia ICP-Brasil. O mTLS quer a cadeia completa.
  const cert = bagsCert[0].cert;
  const cadeiaPem = bagsCert.map((b) => forge.pki.certificateToPem(b.cert)).join('');

  return {
    privateKeyPem: forge.pki.privateKeyToPem(bagChave.key),
    certificatePem: forge.pki.certificateToPem(cert),
    cadeiaPem,
    // Base64 puro do DER, que é o formato do <X509Certificate> no XMLDSig.
    certificateBase64: forge.util
      .encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .replace(/\r?\n/g, ''),
    titular: cert.subject.getField('CN')?.value ?? null,
    validoDe: cert.validity.notBefore,
    validoAte: cert.validity.notAfter,
    fingerprint: forge.md.sha256
      .create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .digest()
      .toHex(),
  };
}

/** Dias restantes até o vencimento. Negativo = já venceu. */
export function diasParaVencer(certificado, agora = new Date()) {
  return Math.ceil((certificado.validoAte.getTime() - agora.getTime()) / 86400000);
}

/**
 * Assina o XML da DPS.
 *
 * @param {string} xml            XML da DPS, sem assinatura
 * @param {object} certificado    Retorno de lerCertificado()
 * @param {string} [algoritmo]    'sha256' (padrão) ou 'sha1'
 * @returns {string} XML com <Signature> inserida dentro de <DPS>
 */
export function assinarDps(xml, certificado, opcoes = {}) {
  return assinarXml(xml, certificado, { ...opcoes, elemento: 'infDPS' });
}

/**
 * Assina o Pedido de Registro de Evento (cancelamento e afins).
 * Mesmo mecanismo da DPS, mudando só o elemento referenciado: aqui é o
 * `infPedReg`, conforme `TCPedRegEvt` no XSD.
 */
export function assinarPedidoEvento(xml, certificado, opcoes = {}) {
  return assinarXml(xml, certificado, { ...opcoes, elemento: 'infPedReg' });
}

/**
 * Assinatura XMLDSig enveloped sobre um elemento identificado por `Id`.
 * @param {string} opcoes.elemento  nome local do elemento assinado
 */
export function assinarXml(xml, certificado, { algoritmo = 'sha256', elemento = 'infDPS' } = {}) {
  const algs = ALGORITMOS[algoritmo];
  if (!algs) throw new Error(`Algoritmo de assinatura desconhecido: ${algoritmo}`);

  const id = extrairId(xml, elemento);

  const sig = new SignedXml({
    privateKey: certificado.privateKeyPem,
    publicCert: certificado.certificatePem,
    signatureAlgorithm: algs.signature,
    canonicalizationAlgorithm: C14N_EXCLUSIVA,
  });

  sig.addReference({
    // Referencia o elemento pelo Id — é o que o padrão exige, não o documento inteiro.
    xpath: `//*[local-name(.)='${elemento}']`,
    transforms: [TRANSFORM_ENVELOPED, C14N_EXCLUSIVA],
    digestAlgorithm: algs.digest,
    uri: `#${id}`,
  });

  // O KeyInfo carrega o certificado público, para a SEFIN validar a cadeia.
  sig.getKeyInfoContent = () =>
    `<X509Data><X509Certificate>${certificado.certificateBase64}</X509Certificate></X509Data>`;

  sig.computeSignature(xml, {
    // A Signature é irmã do elemento assinado, dentro da raiz.
    location: { reference: `//*[local-name(.)='${elemento}']`, action: 'after' },
  });

  return sig.getSignedXml();
}

/**
 * Verifica a assinatura sem tocar na rede.
 * É o portão da Fase 2: se não passar aqui, não adianta enviar para a SEFIN.
 */
export function verificarAssinatura(xmlAssinado, certificadoPem) {
  const sig = new SignedXml({ publicCert: certificadoPem });
  const doc = extrairElementoSignature(xmlAssinado);
  if (!doc) throw new Error('XML não contém elemento Signature');

  sig.loadSignature(doc);
  const valido = sig.checkSignature(xmlAssinado);
  return { valido, erros: valido ? [] : sig.getSignedReferences?.() ?? ['assinatura inválida'] };
}

function extrairId(xml, elemento) {
  const m = xml.match(new RegExp(`<${elemento}[^>]*\\sId="([^"]+)"`));
  if (!m) throw new Error(`XML não tem ${elemento} com atributo Id`);
  return m[1];
}

function extrairElementoSignature(xml) {
  const m = xml.match(/<(?:\w+:)?Signature[\s>][\s\S]*?<\/(?:\w+:)?Signature>/);
  return m ? m[0] : null;
}
