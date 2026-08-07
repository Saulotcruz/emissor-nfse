import { DOMParser } from '@xmldom/xmldom';

/**
 * Extrai do XML da NFS-e os campos que o DANFSe mostra.
 *
 * A NT 008/2026 exige **paridade XML–PDF**: só pode aparecer no documento
 * impresso o que está no XML. Por isso a leitura é feita aqui, a partir do
 * XML autorizado, e não dos nossos registros no banco — que poderiam ter
 * sido editados depois da emissão.
 */

const NS = 'http://www.sped.fazenda.gov.br/nfse';

function texto(no) {
  return no?.textContent?.trim() ?? null;
}

/** Primeiro descendente com aquele nome local, a partir de um nó. */
function filho(no, nome) {
  if (!no) return null;
  const lista = no.getElementsByTagNameNS ? no.getElementsByTagNameNS(NS, nome) : no.getElementsByTagName(nome);
  return lista?.length ? lista[0] : null;
}

function valor(no, nome) {
  return texto(filho(no, nome));
}

/** Busca dentro de um grupo específico, evitando pegar a tag homônima de outro. */
function grupo(raiz, ...caminho) {
  let atual = raiz;
  for (const nome of caminho) {
    atual = filho(atual, nome);
    if (!atual) return null;
  }
  return atual;
}

function endereco(no) {
  if (!no) return null;
  const end = filho(no, 'end');
  if (!end) return null;
  const nac = filho(end, 'endNac');
  return {
    logradouro: valor(end, 'xLgr'),
    numero: valor(end, 'nro'),
    complemento: valor(end, 'xCpl'),
    bairro: valor(end, 'xBairro'),
    codigoMunicipio: nac ? valor(nac, 'cMun') : null,
    cep: nac ? valor(nac, 'CEP') : null,
  };
}

function pessoa(no) {
  if (!no) return null;
  return {
    cnpj: valor(no, 'CNPJ'),
    cpf: valor(no, 'CPF'),
    inscricaoMunicipal: valor(no, 'IM'),
    nome: valor(no, 'xNome'),
    telefone: valor(no, 'fone'),
    email: valor(no, 'email'),
    endereco: endereco(no),
  };
}

/**
 * @param {string} nfseXml XML da NFS-e devolvido pela SEFIN
 * @returns {object} dados prontos para o layout
 */
export function lerNfse(nfseXml) {
  const doc = new DOMParser().parseFromString(nfseXml, 'text/xml');
  const infNFSe = filho(doc, 'infNFSe');
  if (!infNFSe) throw new Error('XML não parece uma NFS-e: elemento infNFSe ausente');

  const infDPS = filho(filho(infNFSe, 'DPS'), 'infDPS');
  const emit = filho(infNFSe, 'emit');
  const valores = filho(infNFSe, 'valores');
  const trib = grupo(infDPS, 'valores', 'trib');
  const tribMun = filho(trib, 'tribMun');
  const pisCofins = grupo(trib, 'tribFed', 'piscofins');
  const serv = filho(infDPS, 'serv');
  const cServ = filho(serv, 'cServ');

  // O Id da NFS-e é "NFS" + a chave de acesso de 50 dígitos.
  const idNfse = infNFSe.getAttribute?.('Id') ?? '';
  const chaveAcesso = idNfse.replace(/^NFS/i, '') || null;

  return {
    chaveAcesso,
    numeroNfse: valor(infNFSe, 'nNFSe'),
    dataHoraProcessamento: valor(infNFSe, 'dhProc'),
    ambiente: valor(infDPS, 'tpAmb'),
    ambienteGerador: valor(infNFSe, 'ambGer'),
    situacao: valor(infNFSe, 'cStat'),
    localEmissao: valor(infNFSe, 'xLocEmi'),
    localPrestacao: valor(infNFSe, 'xLocPrestacao'),

    dps: {
      numero: valor(infDPS, 'nDPS'),
      serie: valor(infDPS, 'serie'),
      dataHoraEmissao: valor(infDPS, 'dhEmi'),
      competencia: valor(infDPS, 'dCompet'),
    },

    // O prestador vem do grupo `emit` da NFS-e: é a SEFIN que o preenche, a
    // partir do cadastro. Nós não enviamos esses dados na DPS.
    prestador: {
      ...pessoa(emit),
      // `emit` usa nomes próprios para alguns campos.
      nome: valor(emit, 'xNome') ?? valor(emit, 'xFant'),
      inscricaoMunicipal: valor(emit, 'IM'),
    },
    tomador: pessoa(filho(infDPS, 'toma')),

    servico: {
      codigoTributacaoNacional: cServ ? valor(cServ, 'cTribNac') : null,
      codigoTributacaoMunicipal: cServ ? valor(cServ, 'cTribMun') : null,
      codigoNbs: cServ ? valor(cServ, 'cNBS') : null,
      descricao: cServ ? valor(cServ, 'xDescServ') : null,
      descricaoCodigo: valor(infNFSe, 'xTribNac'),
      localPrestacao: valor(infNFSe, 'xLocPrestacao'),
    },

    issqn: {
      tipoTributacao: tribMun ? valor(tribMun, 'tribISSQN') : null,
      tipoRetencao: tribMun ? valor(tribMun, 'tpRetISSQN') : null,
      aliquota: tribMun ? valor(tribMun, 'pAliq') : null,
      base: valores ? valor(valores, 'vBC') : null,
      valor: valores ? valor(valores, 'vISSQN') : null,
    },

    federal: {
      cst: pisCofins ? valor(pisCofins, 'CST') : null,
      aliquotaPis: pisCofins ? valor(pisCofins, 'pAliqPis') : null,
      aliquotaCofins: pisCofins ? valor(pisCofins, 'pAliqCofins') : null,
      valorPis: pisCofins ? valor(pisCofins, 'vPis') : null,
      valorCofins: pisCofins ? valor(pisCofins, 'vCofins') : null,
      tipoRetencaoPisCofins: pisCofins ? valor(pisCofins, 'tpRetPisCofins') : null,
    },

    totais: {
      valorServico: grupo(infDPS, 'valores', 'vServPrest')
        ? valor(grupo(infDPS, 'valores', 'vServPrest'), 'vServ')
        : null,
      valorLiquido: valores ? valor(valores, 'vLiq') : null,
      totalRetencoes: valores ? valor(valores, 'vTotalRet') : null,
    },

    informacoesComplementares: valor(infNFSe, 'xOutInf'),
  };
}

export const TRIBUTACAO_ISSQN = {
  1: 'Operação Tributável',
  2: 'Imunidade',
  3: 'Exportação de serviço',
  4: 'Não Incidência',
};

export const RETENCAO_ISSQN = {
  1: 'Não Retido',
  2: 'Retido pelo Tomador',
  3: 'Retido pelo Intermediário',
};

export const RETENCAO_PIS_COFINS = {
  0: '0 - PIS/COFINS/CSLL Não Retidos',
  1: '1 - PIS/COFINS Retidos',
  2: '2 - PIS/COFINS Não Retidos',
  3: '3 - PIS/COFINS/CSLL Retidos',
};

export const SITUACAO = {
  100: 'NFS-e Gerada',
  102: 'NFS-e de Decisão Judicial',
  103: 'NFS-e Avulsa',
  107: 'NFS-e MEI',
};
