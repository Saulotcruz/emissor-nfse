import https from 'node:https';
import crypto from 'node:crypto';
import forge from 'node-forge';

/**
 * Servidor HTTPS que imita a SEFIN, com mTLS ligado.
 *
 * Existe para exercitar o transporte de verdade — handshake com certificado de
 * cliente, gzip+base64, códigos de erro — sem depender da rede nem do certificado
 * real. O que ele NÃO valida é o contrato da SEFIN: isso só a Produção Restrita diz.
 */

function gerarParCertificado(cn, { ca = null, san = false } = {}) {
  // 2048 bits: o OpenSSL recusa chave menor em TLS ("ee key too small").
  // A geração vai pelo crypto nativo, que é ordens de grandeza mais rápido que
  // o node-forge nesse tamanho; o forge só monta e assina o certificado.
  const par = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keys = {
    privateKey: forge.pki.privateKeyFromPem(par.privateKey),
    publicKey: forge.pki.publicKeyFromPem(par.publicKey),
  };

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e6)).padStart(8, '0');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);

  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(ca ? ca.cert.subject.attributes : attrs);
  const extensoes = [{ name: 'basicConstraints', cA: !ca }];
  if (san) {
    // Sem subjectAltName o Node recusa a conexão: o CN sozinho não vale mais
    // para casar o host ("Hostname/IP does not match certificate's altnames").
    extensoes.push({
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    });
  }
  cert.setExtensions(extensoes);
  cert.sign(ca ? ca.key : keys.privateKey, forge.md.sha256.create());

  return {
    key: keys.privateKey,
    cert,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

/**
 * Sobe o servidor falso.
 * @param {(req, corpo) => {status:number, corpo:any}} responder
 */
export async function subirSefinFake(responder) {
  const ca = gerarParCertificado('CA DE TESTE');
  const servidor = gerarParCertificado('localhost', { ca, san: true });
  const cliente = gerarParCertificado('CLIENTE DE TESTE:11222333000181', { ca });

  const requisicoes = [];

  const server = https.createServer(
    {
      key: servidor.keyPem,
      cert: servidor.certPem,
      ca: [ca.certPem],
      requestCert: true,
      // A SEFIN recusa quem não apresenta certificado; aqui deixamos passar para
      // conseguir devolver 496 no handler e testar essa tradução de erro.
      rejectUnauthorized: false,
    },
    (req, res) => {
      const partes = [];
      req.on('data', (p) => partes.push(p));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const registro = {
          metodo: req.method,
          caminho: req.url,
          headers: req.headers,
          corpo: texto ? JSON.parse(texto) : null,
          temCertificadoCliente: Boolean(req.socket.getPeerCertificate()?.subject),
        };
        requisicoes.push(registro);

        const r = responder(registro) ?? { status: 200, corpo: {} };
        const payload = typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo ?? {});
        res.writeHead(r.status, { 'Content-Type': r.tipo ?? 'application/json' });
        res.end(payload);
      });
    }
  );

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const porta = server.address().port;

  // .pfx do cliente, no mesmo formato do certificado A1 real.
  const p12 = forge.pkcs12.toPkcs12Asn1(cliente.key, [cliente.cert], 'senha123', {
    algorithm: '3des',
  });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');

  return {
    baseUrl: `https://127.0.0.1:${porta}`,
    pfx,
    senha: 'senha123',
    caPem: ca.certPem,
    requisicoes,
    fechar: () => new Promise((resolve) => server.close(resolve)),
  };
}
