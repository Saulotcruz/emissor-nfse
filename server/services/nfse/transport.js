import https from 'node:https';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { erroDaResposta, TransporteSefinError, RejeicaoSefinError } from './errors.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Comunicação com a SEFIN Nacional.
 *
 * A API exige mTLS: sem certificado de cliente ela devolve 496 antes de qualquer
 * lógica de aplicação — confirmado em teste, até a documentação é barrada.
 * O corpo dos envios é o XML assinado comprimido em GZip e codificado em Base64.
 */

export const BASE_URLS = {
  producao_restrita: 'https://sefin.producaorestrita.nfse.gov.br',
  producao: 'https://sefin.nfse.gov.br',
};

/** Ambiente Nacional de Distribuição — é onde vivem as consultas de eventos. */
export const BASE_URLS_ADN = {
  producao_restrita: 'https://adn.producaorestrita.nfse.gov.br',
  producao: 'https://adn.nfse.gov.br',
};

const PREFIXO = '/SefinNacional';
// O ADN usa outro prefixo e outro host — emissão e consulta de eventos vivem
// em serviços diferentes do Sistema Nacional.
const PREFIXO_ADN = '/contribuintes';
const TIMEOUT_PADRAO = 60000;

export function baseUrlDoAmbiente(ambiente, host = 'sefin') {
  const mapa = host === 'adn' ? BASE_URLS_ADN : BASE_URLS;
  const url = mapa[ambiente];
  if (!url) throw new Error(`Ambiente desconhecido: ${ambiente}`);
  return url;
}

/** GZip + Base64, o formato que a SEFIN espera no campo dpsXmlGZipB64. */
export async function comprimir(xml) {
  return (await gzip(Buffer.from(xml, 'utf8'))).toString('base64');
}

/** Caminho inverso, para ler o XML da NFS-e devolvido na resposta. */
export async function descomprimir(base64) {
  return (await gunzip(Buffer.from(base64, 'base64'))).toString('utf8');
}

/** Cliente da SEFIN Nacional. */
export class SefinClient {
  /**
   * Recebe chave e certificado já em PEM — não o .pfx.
   *
   * Motivo: o Node passa o `pfx` direto ao OpenSSL, e o OpenSSL 3 recusa os
   * algoritmos legados usados nos arquivos A1 da ICP-Brasil com
   * "Unsupported PKCS12 PFX data". O node-forge lê o mesmo arquivo sem
   * problema (é JS puro), então extraímos o PEM com ele e entregamos pronto.
   */
  constructor({ ambiente = 'producao_restrita', chavePem, certPem, timeout = TIMEOUT_PADRAO, baseUrl } = {}) {
    if (!chavePem || !certPem) {
      throw new Error('Chave e certificado em PEM são obrigatórios para falar com a SEFIN');
    }
    this.baseUrl = baseUrl ?? baseUrlDoAmbiente(ambiente);
    // Consultas de evento não estão na SEFIN: lá o caminho /eventos só aceita
    // POST (405) e a variante com tipo nem existe (404 em HTML do IIS).
    this.baseUrlAdn = baseUrl ?? baseUrlDoAmbiente(ambiente, 'adn');
    this.timeout = timeout;
    this.agent = new https.Agent({
      key: chavePem,
      cert: certPem,
      keepAlive: true,
      // Sempre validar a cadeia do servidor. Desligar isso abriria espaço para
      // um intermediário ver e alterar documento fiscal assinado.
      rejectUnauthorized: true,
    });
  }

  /**
   * Envia a DPS assinada. A resposta é síncrona: já vem a chave de acesso e o
   * XML da NFS-e autorizada.
   */
  async enviarDps(xmlAssinado) {
    const dpsXmlGZipB64 = await comprimir(xmlAssinado);
    const resp = await this.requisitar('POST', `${PREFIXO}/nfse`, { dpsXmlGZipB64 });

    const chaveAcesso = resp.corpo?.chaveAcesso ?? resp.corpo?.ChaveAcesso ?? null;
    const nfseB64 = resp.corpo?.nfseXmlGZipB64 ?? resp.corpo?.NfseXmlGZipB64 ?? null;

    return {
      chaveAcesso,
      nfseXml: nfseB64 ? await descomprimir(nfseB64) : null,
      corpo: resp.corpo,
    };
  }

  /** Consulta a NFS-e pela chave de 50 dígitos. */
  async consultarNfse(chaveAcesso) {
    const resp = await this.requisitar('GET', `${PREFIXO}/nfse/${chaveAcesso}`);
    const b64 = resp.corpo?.nfseXmlGZipB64 ?? resp.corpo?.NfseXmlGZipB64 ?? null;
    return { nfseXml: b64 ? await descomprimir(b64) : null, corpo: resp.corpo };
  }

  /**
   * Verifica se um idDPS já virou nota. É a checagem que torna seguro retentar
   * um envio que falhou por timeout: sem ela, a retentativa pode duplicar.
   * Usa HEAD para não trazer o XML inteiro só para saber se existe.
   */
  async dpsJaEmitida(idDps) {
    const resp = await this.requisitar('HEAD', `${PREFIXO}/dps/${idDps}`, null, { aceitar404: true });
    return resp.status !== 404;
  }

  async consultarDps(idDps) {
    const resp = await this.requisitar('GET', `${PREFIXO}/dps/${idDps}`, null, { aceitar404: true });
    if (resp.status === 404) return null;
    const b64 = resp.corpo?.nfseXmlGZipB64 ?? resp.corpo?.NfseXmlGZipB64 ?? null;
    return { nfseXml: b64 ? await descomprimir(b64) : null, corpo: resp.corpo };
  }

  /**
   * Registra um evento na nota — e101101 é o cancelamento.
   *
   * A resposta traz `eventoXmlGZipB64`: o XML do evento registrado, que é o
   * comprovante oficial. Descomprimimos para guardar legível, do mesmo jeito
   * que fazemos com o XML da NFS-e.
   */
  async enviarEvento(chaveAcesso, xmlEventoAssinado) {
    const pedidoRegistroEventoXmlGZipB64 = await comprimir(xmlEventoAssinado);
    const resp = await this.requisitar('POST', `${PREFIXO}/nfse/${chaveAcesso}/eventos`, {
      pedidoRegistroEventoXmlGZipB64,
    });

    const b64 = resp.corpo?.eventoXmlGZipB64 ?? resp.corpo?.EventoXmlGZipB64 ?? null;
    return {
      eventoXml: b64 ? await descomprimir(b64) : null,
      corpo: resp.corpo,
    };
  }

  /**
   * Documentos vinculados a uma NFS-e — é como se descobre um cancelamento
   * feito fora daqui, pelo Portal Nacional.
   *
   * Fica no ADN, não na SEFIN: lá o caminho `/eventos` só aceita POST (405), e
   * a variante com o tipo do evento nem existe (404 em HTML do IIS). A resposta
   * vem como lote de DF-e, com cada documento em GZip+Base64.
   *
   * O XML da própria nota não denuncia cancelamento: o `cStat` só distingue
   * tipos de NFS-e gerada (100, 102, 103, 107) e nunca muda.
   */
  async consultarEventos(chaveAcesso) {
    const caminho = `${PREFIXO_ADN}/nfse/${chaveAcesso}/eventos`;
    const resp = await this.requisitar('GET', caminho, null, {
      aceitar404: true,
      base: this.baseUrlAdn,
    });

    if (resp.status === 404) {
      if (typeof resp.corpo === 'string' && /<html/i.test(resp.corpo)) {
        throw new RejeicaoSefinError(
          `Endpoint de consulta de eventos não existe neste host: GET ${caminho}`,
          { status: 404 }
        );
      }
      return [];
    }

    const lote = resp.corpo?.LoteDFe ?? resp.corpo?.loteDFe ?? [];
    return Promise.all(
      lote.map(async (d) => {
        const b64 = d.ArquivoXml ?? d.arquivoXml ?? null;
        return {
          nsu: d.NSU ?? d.nsu ?? null,
          tipoDocumento: d.TipoDocumento ?? d.tipoDocumento ?? null,
          chaveAcesso: d.ChaveAcesso ?? d.chaveAcesso ?? null,
          eventoXml: b64 ? await descomprimir(b64) : null,
        };
      })
    );
  }

  /**
   * DANFSe em PDF, gerado pelo ambiente nacional a partir da chave.
   *
   * O caminho não está na documentação pública, então tentamos os candidatos em
   * ordem e ficamos no primeiro que devolver PDF. Foi o que resolveu a consulta
   * de eventos: a documentação diverge da API em detalhes que só o uso mostra.
   *
   * Gerar sob demanda em vez de guardar: o layout do DANFSe muda com as notas
   * técnicas, e um PDF salvo hoje envelhece. O XML é que é o documento.
   */
  async baixarDanfse(chaveAcesso) {
    const tentativas = [
      { base: this.baseUrlAdn, caminho: `${PREFIXO_ADN}/danfse/${chaveAcesso}` },
      { base: this.baseUrlAdn, caminho: `/danfse/${chaveAcesso}` },
      { base: this.baseUrl, caminho: `${PREFIXO}/danfse/${chaveAcesso}` },
    ];

    const erros = [];
    for (const t of tentativas) {
      try {
        const r = await this.requisitar('GET', t.caminho, null, {
          base: t.base,
          binario: true,
          aceitar404: true,
        });
        if (r.status === 404) {
          erros.push(`404 ${t.caminho}`);
          continue;
        }
        // Assinatura do PDF: %PDF. Sem isto, um HTML de erro com status 200
        // viraria um "PDF" corrompido na mão do usuário.
        if (r.bytes?.subarray(0, 4).toString('latin1') === '%PDF') {
          return { pdf: r.bytes, caminho: t.caminho };
        }
        erros.push(`${t.caminho} respondeu ${r.tipo || 'formato desconhecido'}, não PDF`);
      } catch (e) {
        erros.push(`${t.caminho}: ${e.message}`);
      }
    }

    throw new RejeicaoSefinError(
      `Não foi possível obter o DANFSe. Tentativas: ${erros.join(' | ')}`,
      { status: 404 }
    );
  }

  async requisitar(metodo, caminho, corpoJson = null, { aceitar404 = false, base, binario = false } = {}) {
    const url = new URL(caminho, base ?? this.baseUrl);
    const payload = corpoJson ? Buffer.from(JSON.stringify(corpoJson), 'utf8') : null;

    const resposta = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: metodo,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          agent: this.agent,
          timeout: this.timeout,
          headers: {
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
        },
        (res) => {
          const partes = [];
          res.on('data', (p) => partes.push(p));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              bytes: Buffer.concat(partes),
              tipo: res.headers['content-type'] ?? '',
            })
          );
        }
      );

      req.on('timeout', () => {
        req.destroy(
          new TransporteSefinError(`Timeout de ${this.timeout}ms falando com a SEFIN`, {
            status: null,
          })
        );
      });
      req.on('error', (e) => reject(traduzirErroDeRede(e)));

      if (payload) req.write(payload);
      req.end();
    });

    // Em resposta binária o corpo só é interpretado quando deu erro — aí ele
    // vem em JSON ou HTML, e é o que precisa ser lido.
    const houveErro = resposta.status >= 400;
    const corpo = binario && !houveErro ? null : interpretarCorpo(resposta.bytes.toString('utf8'));

    if (resposta.status === 404 && aceitar404) return { status: 404, corpo, bytes: resposta.bytes };
    if (houveErro) throw erroDaResposta(resposta.status, corpo);
    return { status: resposta.status, corpo, bytes: resposta.bytes, tipo: resposta.tipo };
  }
}

function interpretarCorpo(texto) {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    // A SEFIN devolve HTML em erro de infraestrutura (o 496 do IIS, por exemplo).
    return texto;
  }
}

function traduzirErroDeRede(e) {
  if (e instanceof TransporteSefinError) return e;
  const retentaveis = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'];
  if (retentaveis.includes(e.code)) {
    return new TransporteSefinError(`Falha de rede falando com a SEFIN: ${e.code}`, { codigo: e.code });
  }
  return e;
}
