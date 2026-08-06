import { apenasDigitos } from '../documento.js';

/**
 * Identificador da DPS.
 *
 * Regra retirada do XSD oficial (`TSIdDPS` em tiposSimples_v1.01.xsd):
 *
 *   "DPS" + Cód.Mun (7) + Tipo de Inscrição Federal (1) + Inscrição Federal (14)
 *         + Série (5) + Núm. DPS (15)
 *
 * Total: 3 + 42 caracteres. O XSD impõe `pattern="DPS[0-9]{42}"`, ou seja, tudo
 * depois do literal é dígito — daí o zero-padding de série e número.
 *
 * Para CPF, a inscrição federal é completada com "000" à esquerda até 14.
 */

export const TIPO_INSCRICAO = { CPF: 1, CNPJ: 2 };

/** Zero-padding à esquerda, com erro explícito se o valor não couber. */
function pad(valor, tamanho, campo) {
  const s = String(valor);
  if (s.length > tamanho) {
    throw new Error(`${campo} excede ${tamanho} dígitos: ${s}`);
  }
  return s.padStart(tamanho, '0');
}

/**
 * @param {object} p
 * @param {string} p.codigoMunicipio  IBGE, 7 dígitos
 * @param {string} p.documento        CNPJ (14) ou CPF (11) do emitente
 * @param {string|number} p.serie     1 a 99999
 * @param {string|number} p.numeroDps 1 a 999999999999999
 */
export function montarIdDps({ codigoMunicipio, documento, serie, numeroDps }) {
  const municipio = apenasDigitos(codigoMunicipio);
  if (municipio.length !== 7) {
    throw new Error(`Código de município deve ter 7 dígitos (IBGE): ${codigoMunicipio}`);
  }

  const doc = apenasDigitos(documento);
  let tipoInscricao;
  if (doc.length === 14) tipoInscricao = TIPO_INSCRICAO.CNPJ;
  else if (doc.length === 11) tipoInscricao = TIPO_INSCRICAO.CPF;
  else throw new Error(`Documento do emitente deve ser CNPJ ou CPF: ${documento}`);

  const numero = Number(numeroDps);
  if (!Number.isInteger(numero) || numero < 1) {
    throw new Error(`Número da DPS deve ser inteiro positivo: ${numeroDps}`);
  }

  const serieDigitos = apenasDigitos(serie);
  if (!serieDigitos || Number(serieDigitos) < 1 || Number(serieDigitos) > 99999) {
    throw new Error(`Série da DPS deve estar entre 1 e 99999: ${serie}`);
  }

  const id =
    'DPS' +
    municipio +
    String(tipoInscricao) +
    pad(doc, 14, 'Inscrição federal') +
    pad(serieDigitos, 5, 'Série') +
    pad(numero, 15, 'Número da DPS');

  if (!/^DPS[0-9]{42}$/.test(id)) {
    throw new Error(`Id da DPS não bate com o padrão do XSD: ${id}`);
  }
  return id;
}

/**
 * Faixas de série por tipo de emissor, no Padrão Nacional.
 * Confirmado numa NFS-e real: as emitidas pelo Portal Nacional saem na faixa 70000+.
 * Emissão por webservice — que é o caso deste sistema — usa 1 a 49999.
 */
export const FAIXAS_SERIE = {
  webservice: [1, 49999],
  mobile: [50000, 69999],
  portalNacional: [70000, 79999],
  portalTranscricao: [80000, 89999],
};

export function serieDeWebservice(serie) {
  const n = Number(apenasDigitos(serie));
  const [min, max] = FAIXAS_SERIE.webservice;
  return Number.isInteger(n) && n >= min && n <= max;
}

/** A chave de acesso devolvida pela SEFIN tem 50 dígitos (`TSChaveNFSe`). */
export function chaveValida(chave) {
  return /^[0-9]{50}$/.test(String(chave ?? ''));
}
