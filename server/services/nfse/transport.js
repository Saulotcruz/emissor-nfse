import https from 'node:https';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { erroDaResposta, TransporteSefinError } from './errors.js';

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

const PREFIXO = '/SefinNacional';
const TIMEOUT_PADRAO = 60000;

export function baseUrlDoAmbiente(ambiente) {
  const url = BASE_URLS[ambiente];
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

  async requisitar(metodo, caminho, corpoJson = null, { aceitar404 = false } = {}) {
    const url = new URL(caminho, this.baseUrl);
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
            resolve({ status: res.statusCode, texto: Buffer.concat(partes).toString('utf8') })
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

    const corpo = interpretarCorpo(resposta.texto);
    if (resposta.status === 404 && aceitar404) return { status: 404, corpo };
    if (resposta.status >= 400) throw erroDaResposta(resposta.status, corpo);
    return { status: resposta.status, corpo };
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
