import forge from 'node-forge';

/**
 * Gera um .pfx autoassinado em memória, só para os testes de assinatura.
 * Nenhum certificado real entra no repositório.
 */
export function gerarPfxDeTeste({ senha = 'teste123', cn = 'EMPRESA DE TESTE LTDA:11222333000181' } = {}) {
  // 1024 bits é fraco de propósito: o teste só exercita o fluxo, e chave maior
  // deixaria a suíte lenta.
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z');

  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, {
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();

  return { buffer: Buffer.from(der, 'binary'), senha, cn };
}
