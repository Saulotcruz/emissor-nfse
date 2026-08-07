import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import zlib from 'node:zlib';
import { SefinClient, comprimir, descomprimir, baseUrlDoAmbiente, BASE_URLS, BASE_URLS_ADN } from '../services/nfse/transport.js';
import { RejeicaoSefinError, TransporteSefinError, CertificadoSefinError, erroDaResposta } from '../services/nfse/errors.js';
import { subirSefinFake } from './helpers/sefin-fake.js';

const XML_DPS = '<?xml version="1.0" encoding="UTF-8"?><DPS versao="1.01"><infDPS Id="DPS123"/></DPS>';
const XML_NFSE = '<?xml version="1.0"?><NFSe versao="1.01"><infNFSe/></NFSe>';
const CHAVE = '3'.repeat(50);

let fake;
let resposta;
let client;

beforeAll(async () => {
  // Cada teste define `resposta`; o servidor só devolve o que estiver ali.
  fake = await subirSefinFake(() => resposta);
  client = new SefinClient({
    baseUrl: fake.baseUrl,
    chavePem: fake.chavePem,
    certPem: fake.certPem,
    timeout: 5000,
  });
  // Confia na CA do servidor falso sem desligar a verificação do cliente.
  client.agent.options.ca = [fake.caPem];
});

afterAll(async () => {
  await fake.fechar();
});

describe('compressão', () => {
  it('gzip + base64 é reversível', async () => {
    const b64 = await comprimir(XML_DPS);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await descomprimir(b64)).toBe(XML_DPS);
  });

  it('o base64 é realmente um gzip, não o XML cru codificado', async () => {
    const buf = Buffer.from(await comprimir(XML_DPS), 'base64');
    // Assinatura do gzip: 1f 8b
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
    expect(zlib.gunzipSync(buf).toString('utf8')).toBe(XML_DPS);
  });

  it('preserva acentos, que a descrição do serviço costuma ter', async () => {
    const xml = '<x>Licenciamento ou cessão de direito de uso — R$ 1,00</x>';
    expect(await descomprimir(await comprimir(xml))).toBe(xml);
  });
});

describe('ambientes', () => {
  it('produção restrita e produção têm hosts distintos', () => {
    expect(baseUrlDoAmbiente('producao_restrita')).toBe(BASE_URLS.producao_restrita);
    expect(baseUrlDoAmbiente('producao')).toContain('sefin.nfse.gov.br');
    expect(baseUrlDoAmbiente('producao_restrita')).not.toBe(baseUrlDoAmbiente('producao'));
  });

  it('o ADN é outro host, onde vivem as consultas de eventos', () => {
    expect(baseUrlDoAmbiente('producao', 'adn')).toBe(BASE_URLS_ADN.producao);
    expect(baseUrlDoAmbiente('producao', 'adn')).not.toBe(baseUrlDoAmbiente('producao'));
  });

  it('recusa ambiente desconhecido em vez de cair em produção por engano', () => {
    expect(() => baseUrlDoAmbiente('homologacao')).toThrow(/desconhecido/);
  });

  it('exige chave e certificado em PEM na construção do cliente', () => {
    expect(() => new SefinClient({ ambiente: 'producao_restrita' })).toThrow(/PEM são obrigatórios/);
    // Passar o .pfx não serve: o OpenSSL 3 recusa o PKCS#12 da ICP-Brasil.
    expect(() => new SefinClient({ ambiente: 'producao_restrita', pfx: fake.pfx })).toThrow(/PEM/);
  });
});

describe('enviarDps', () => {
  it('faz POST em /SefinNacional/nfse com o XML gzipado em base64', async () => {
    resposta = {
      status: 201,
      corpo: { chaveAcesso: CHAVE, nfseXmlGZipB64: zlib.gzipSync(XML_NFSE).toString('base64') },
    };
    const r = await client.enviarDps(XML_DPS);

    const req = fake.requisicoes.at(-1);
    expect(req.metodo).toBe('POST');
    expect(req.caminho).toBe('/SefinNacional/nfse');
    expect(req.headers['content-type']).toContain('application/json');
    expect(await descomprimir(req.corpo.dpsXmlGZipB64)).toBe(XML_DPS);

    expect(r.chaveAcesso).toBe(CHAVE);
    expect(r.nfseXml).toBe(XML_NFSE);
  });

  it('apresenta o certificado de cliente no handshake', async () => {
    resposta = { status: 201, corpo: { chaveAcesso: CHAVE } };
    await client.enviarDps(XML_DPS);
    expect(fake.requisicoes.at(-1).temCertificadoCliente).toBe(true);
  });

  it('sobrevive à resposta sem XML da NFS-e', async () => {
    resposta = { status: 201, corpo: { chaveAcesso: CHAVE } };
    const r = await client.enviarDps(XML_DPS);
    expect(r.chaveAcesso).toBe(CHAVE);
    expect(r.nfseXml).toBeNull();
  });
});

describe('tradução de erros', () => {
  it('rejeição de validação vira RejeicaoSefinError, que não deve ser retentada', async () => {
    resposta = {
      status: 400,
      corpo: [{ Codigo: 'E0123', Descricao: 'Alíquota de ISS inválida', Complemento: 'pAliq' }],
    };
    const e = await client.enviarDps(XML_DPS).catch((x) => x);
    expect(e).toBeInstanceOf(RejeicaoSefinError);
    expect(e.retentavel).toBe(false);
    expect(e.codigo).toBe('E0123');
    expect(e.message).toContain('Alíquota de ISS inválida');
    expect(e.message).toContain('pAliq');
  });

  it('junta múltiplas rejeições numa mensagem só', () => {
    const e = erroDaResposta(400, [
      { Codigo: 'E1', Descricao: 'primeiro' },
      { Codigo: 'E2', Descricao: 'segundo' },
    ]);
    expect(e.message).toContain('primeiro');
    expect(e.message).toContain('segundo');
  });

  it('5xx e 429 são retentáveis', async () => {
    resposta = { status: 503, corpo: { title: 'Serviço indisponível' } };
    const e = await client.enviarDps(XML_DPS).catch((x) => x);
    expect(e).toBeInstanceOf(TransporteSefinError);
    expect(e.retentavel).toBe(true);
  });

  it('496 identifica falta de certificado — foi o que a API real devolveu sem mTLS', async () => {
    resposta = { status: 496, corpo: '<html><body><h1>496 SSL Certificate Required</h1></body></html>', tipo: 'text/html' };
    const e = await client.enviarDps(XML_DPS).catch((x) => x);
    expect(e).toBeInstanceOf(CertificadoSefinError);
    expect(e.retentavel).toBe(false);
    expect(e.message).toMatch(/mTLS/);
  });

  it('403 aponta para certificado ou credenciamento, não para o XML', async () => {
    resposta = { status: 403, corpo: 'Forbidden' };
    const e = await client.enviarDps(XML_DPS).catch((x) => x);
    expect(e).toBeInstanceOf(CertificadoSefinError);
    expect(e.message).toMatch(/credenciamento/);
  });

  it('não quebra quando o corpo de erro é HTML em vez de JSON', async () => {
    resposta = { status: 500, corpo: '<html>erro</html>', tipo: 'text/html' };
    const e = await client.enviarDps(XML_DPS).catch((x) => x);
    expect(e).toBeInstanceOf(TransporteSefinError);
    expect(e.corpo).toContain('<html>');
  });
});

describe('consultas', () => {
  it('consulta a NFS-e pela chave e descomprime o XML', async () => {
    resposta = { status: 200, corpo: { nfseXmlGZipB64: zlib.gzipSync(XML_NFSE).toString('base64') } };
    const r = await client.consultarNfse(CHAVE);
    expect(fake.requisicoes.at(-1).caminho).toBe(`/SefinNacional/nfse/${CHAVE}`);
    expect(r.nfseXml).toBe(XML_NFSE);
  });

  // Esta é a checagem que torna seguro retentar um envio que caiu por timeout.
  it('dpsJaEmitida usa HEAD e distingue existente de inexistente', async () => {
    resposta = { status: 200, corpo: {} };
    expect(await client.dpsJaEmitida('DPS123')).toBe(true);
    expect(fake.requisicoes.at(-1).metodo).toBe('HEAD');
    expect(fake.requisicoes.at(-1).caminho).toBe('/SefinNacional/dps/DPS123');

    resposta = { status: 404, corpo: {} };
    expect(await client.dpsJaEmitida('DPS123')).toBe(false);
  });

  it('consultarDps devolve null em 404, em vez de estourar', async () => {
    resposta = { status: 404, corpo: {} };
    expect(await client.consultarDps('DPS999')).toBeNull();
  });
});

describe('eventos', () => {
  it('envia o evento de cancelamento comprimido, na rota da chave', async () => {
    const xmlEvento = '<pedRegEvento><infPedReg/></pedRegEvento>';
    const xmlRegistrado = '<evento versao="1.01"><infEvento/></evento>';
    resposta = {
      status: 200,
      corpo: { eventoXmlGZipB64: zlib.gzipSync(xmlRegistrado).toString('base64') },
    };
    const r = await client.enviarEvento(CHAVE, xmlEvento);

    const req = fake.requisicoes.at(-1);
    expect(req.metodo).toBe('POST');
    expect(req.caminho).toBe(`/SefinNacional/nfse/${CHAVE}/eventos`);
    expect(await descomprimir(req.corpo.pedidoRegistroEventoXmlGZipB64)).toBe(xmlEvento);

    // A resposta traz o XML do evento registrado: é o comprovante do cancelamento.
    expect(r.eventoXml).toBe(xmlRegistrado);
  });

  it('tolera resposta de evento sem XML', async () => {
    resposta = { status: 200, corpo: { status: 'REGISTRADO' } };
    const r = await client.enviarEvento(CHAVE, '<pedRegEvento/>');
    expect(r.eventoXml).toBeNull();
    expect(r.corpo.status).toBe('REGISTRADO');
  });
});

describe('consultarEventos', () => {
  // Na SEFIN esse caminho só aceita POST (405) e a variante com tipo nem existe.
  // A consulta vive no ADN, com prefixo /contribuintes.
  it('usa o caminho do ADN', async () => {
    resposta = { status: 200, corpo: { LoteDFe: [] } };
    await client.consultarEventos(CHAVE);
    expect(fake.requisicoes.at(-1).caminho).toBe(`/contribuintes/nfse/${CHAVE}/eventos`);
    expect(fake.requisicoes.at(-1).metodo).toBe('GET');
  });

  it('desempacota o LoteDFe, descomprimindo o XML de cada documento', async () => {
    const xmlEvento = '<evento versao="1.01"><infEvento><e101101/></infEvento></evento>';
    resposta = {
      status: 200,
      corpo: {
        StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
        LoteDFe: [
          { NSU: 329, TipoDocumento: 'NFSE', ChaveAcesso: CHAVE, ArquivoXml: zlib.gzipSync('<NFSe/>').toString('base64') },
          { NSU: 330, TipoDocumento: 'EVENTO', ChaveAcesso: CHAVE, ArquivoXml: zlib.gzipSync(xmlEvento).toString('base64') },
        ],
      },
    };
    const r = await client.consultarEventos(CHAVE);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ nsu: 329, tipoDocumento: 'NFSE' });
    expect(r[1].eventoXml).toBe(xmlEvento);
  });

  it('lote vazio vira lista vazia', async () => {
    resposta = { status: 200, corpo: { StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] } };
    expect(await client.consultarEventos(CHAVE)).toEqual([]);
  });

  // Tratar os dois 404 igual faria a verificação passar em silêncio com o
  // endpoint quebrado — pior que não ter verificação nenhuma.
  it('404 em HTML denuncia rota inexistente, em vez de fingir que não há eventos', async () => {
    resposta = {
      status: 404,
      corpo: '<html><body>404 - File or directory not found.</body></html>',
      tipo: 'text/html',
    };
    await expect(client.consultarEventos(CHAVE)).rejects.toThrow(/não existe neste host/);
  });
});

describe('cabeçalho Accept', () => {
  // Pedir JSON de um endpoint que só produz PDF faz a SEFIN responder 501, o
  // que parece endpoint inexistente e não é — foi o que aconteceu na primeira
  // tentativa de baixar o DANFSe.
  it('pede JSON nas rotas normais e PDF nas binárias', async () => {
    resposta = { status: 200, corpo: {} };
    await client.consultarNfse(CHAVE);
    expect(fake.requisicoes.at(-1).headers.accept).toBe('application/json');

    resposta = { status: 200, corpo: '%PDF-1.4', tipo: 'application/pdf' };
    await client.baixarDanfse(CHAVE);
    expect(fake.requisicoes.at(-1).headers.accept).toContain('application/pdf');
  });
});

describe('baixarDanfse', () => {
  it('devolve o PDF e informa qual caminho respondeu', async () => {
    const pdfFalso = '%PDF-1.4\n conteudo';
    resposta = { status: 200, corpo: pdfFalso, tipo: 'application/pdf' };
    const r = await client.baixarDanfse(CHAVE);
    expect(r.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.caminho).toContain(CHAVE);
  });

  // Um HTML de erro com status 200 viraria um "PDF" corrompido na mão do
  // usuário; a assinatura do arquivo é o que separa os dois casos.
  it('recusa resposta 200 que não seja PDF', async () => {
    resposta = { status: 200, corpo: '<html>erro</html>', tipo: 'text/html' };
    await expect(client.baixarDanfse(CHAVE)).rejects.toThrow(/não PDF/);
  });

  it('relata todas as tentativas quando nenhuma responde', async () => {
    resposta = { status: 404, corpo: {} };
    await expect(client.baixarDanfse(CHAVE)).rejects.toThrow(/Tentativas:.*404/s);
  });
});

describe('segurança do transporte', () => {
  it('mantém a verificação do certificado do servidor ligada', () => {
    const c = new SefinClient({ ambiente: 'producao', chavePem: fake.chavePem, certPem: fake.certPem });
    expect(c.agent.options.rejectUnauthorized).toBe(true);
  });

  it('falha ao falar com servidor cuja cadeia não confia', async () => {
    const semCa = new SefinClient({ baseUrl: fake.baseUrl, chavePem: fake.chavePem, certPem: fake.certPem, timeout: 5000 });
    resposta = { status: 200, corpo: {} };
    await expect(semCa.consultarNfse(CHAVE)).rejects.toThrow();
  });
});
