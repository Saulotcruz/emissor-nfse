import { apenasDigitos, cnpjValido } from './documento.js';

const BASE_URL = process.env.BRASILAPI_URL || 'https://brasilapi.com.br/api/cnpj/v1';
const TIMEOUT_MS = Number(process.env.BRASILAPI_TIMEOUT_MS || 15000);
// A BrasilAPI responde 403 para requisições sem User-Agent — o fetch do Node não manda um
// por padrão. Sem este header a consulta falha em produção mesmo com o CNPJ correto.
const USER_AGENT = process.env.BRASILAPI_USER_AGENT || 'emissor-nfse/0.1 (+https://github.com/Saulotcruz/emissor-nfse)';

export class CnpjNaoEncontradoError extends Error {
  constructor(cnpj) {
    super(`CNPJ ${cnpj} não encontrado na BrasilAPI`);
    this.name = 'CnpjNaoEncontradoError';
    this.status = 404;
  }
}

/**
 * Consulta dados cadastrais de um CNPJ na BrasilAPI (pública, sem chave).
 * Retorna o formato já normalizado para a tabela `tomador`.
 */
export async function consultarCnpj(valor) {
  const cnpj = apenasDigitos(valor);
  if (!cnpjValido(cnpj)) throw new Error(`CNPJ inválido: ${valor}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${BASE_URL}/${cnpj}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 404) throw new CnpjNaoEncontradoError(cnpj);
  if (resp.status === 429) throw new Error('BrasilAPI recusou por excesso de requisições (429). Tente novamente em instantes.');
  if (!resp.ok) throw new Error(`BrasilAPI respondeu ${resp.status} para o CNPJ ${cnpj}`);

  return normalizar(await resp.json());
}

/** Mapeia o retorno da BrasilAPI para as colunas de `tomador`. */
export function normalizar(dados) {
  return {
    tipo_doc: 'cnpj',
    documento: apenasDigitos(dados.cnpj),
    razao_social: dados.razao_social ?? null,
    nome_fantasia: dados.nome_fantasia || null,
    email: dados.email || null,
    telefone: apenasDigitos(dados.ddd_telefone_1) || null,
    logradouro: dados.logradouro || null,
    // A BrasilAPI devolve string vazia quando não há número; a SEFIN espera algo preenchido.
    numero: dados.numero || 'S/N',
    complemento: dados.complemento || null,
    bairro: dados.bairro || null,
    cep: apenasDigitos(dados.cep) || null,
    uf: dados.uf || null,
    // Atenção: `codigo_municipio` aqui NÃO vem preenchido. A BrasilAPI devolve
    // `codigo_municipio` no padrão SIAFI, e a DPS exige o código IBGE de 7 dígitos.
    // A conversão entra na Fase 2, junto do builder.
    codigo_municipio: null,
    municipio_nome: dados.municipio || null,
  };
}
