import { apenasDigitos } from '../documento.js';
import { apurarTributos } from '../calculo.js';
import { montarIdDps } from './id-dps.js';
import { tag, grupo, dec, dataHoraUtc, dataSimples } from './xml.js';

/**
 * Monta o XML da DPS (Declaração de Prestação de Serviços).
 *
 * A ordem dos elementos NÃO é livre: o XSD usa <xs:sequence>, então qualquer
 * troca de posição faz o schema rejeitar. A ordem aqui segue exatamente
 * `TCInfoDPS` em schemas/1.01/tiposComplexos_v1.01.xsd.
 */

export const NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO = '1.01';
export const VER_APLIC = 'emissor-nfse-0.1';

// Valores de domínio do XSD (tiposSimples_v1.01.xsd).
export const TP_AMB = { producao: '1', producao_restrita: '2' };
export const TP_EMIT = { prestador: '1', tomador: '2', intermediario: '3' };
export const TRIB_ISSQN = {
  operacao_tributavel: '1',
  imunidade: '2',
  exportacao: '3',
  nao_incidencia: '4',
};
export const TP_RET_ISSQN = { nao_retido: '1', retido_tomador: '2', retido_intermediario: '3' };
export const OP_SIMPLES_NACIONAL = { nao_optante: '1', mei: '2', me_epp: '3' };

// CST do PIS/COFINS. "01 - Operação Tributável com Alíquota Básica" é o caso do
// Lucro Presumido; corresponde ao STANDARD_TAXABLE_OPERATION guardado no serviço.
export const CST_PIS_COFINS = {
  STANDARD_TAXABLE_OPERATION: '01',
  NENHUM: '00',
};

/**
 * @param {object} p
 * @param {object} p.emitente  Linha da tabela `emitente`
 * @param {object} p.tomador   Linha da tabela `tomador`
 * @param {object} p.servico   Linha da tabela `servico`
 * @param {object} p.nota      { numeroDps, serie, competencia, valorServico, descricaoServico, deducoes, ambiente, dhEmi }
 * @returns {{ xml: string, id: string, tributos: object }}
 */
export function montarDps({ emitente, tomador, servico, nota }) {
  validarEntrada({ emitente, tomador, servico, nota });

  const serie = nota.serie ?? emitente.serie_dps;
  const id = montarIdDps({
    codigoMunicipio: emitente.codigo_municipio,
    documento: emitente.cnpj,
    serie,
    numeroDps: nota.numeroDps,
  });

  const tributos = apurarTributos({
    valorServico: nota.valorServico,
    deducoes: nota.deducoes ?? 0,
    servico,
  });

  const ambiente = nota.ambiente ?? emitente.ambiente ?? 'producao_restrita';
  const dhEmi = nota.dhEmi ?? new Date();

  const infDps = grupo(
    'infDPS',
    [
      tag('tpAmb', TP_AMB[ambiente] ?? TP_AMB.producao_restrita),
      tag('dhEmi', dataHoraUtc(dhEmi)),
      tag('verAplic', VER_APLIC),
      // A série vai sem zeros à esquerda: TSSerieDPS aceita, e é como o DANFSe mostra.
      tag('serie', String(Number(apenasDigitos(serie)))),
      tag('nDPS', String(Number(nota.numeroDps))),
      tag('dCompet', dataSimples(nota.competencia ?? dhEmi)),
      tag('tpEmit', TP_EMIT.prestador),
      tag('cLocEmi', emitente.codigo_municipio),
      montarPrestador(emitente, { emitidaPeloPrestador: true }),
      montarTomador(tomador),
      montarServico({ emitente, servico, nota }),
      montarValores({ emitente, servico, tributos }),
    ],
    { atributos: ` Id="${id}"` }
  );

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<DPS xmlns="${NAMESPACE}" versao="${VERSAO}">${infDps}</DPS>`;

  return { xml, id, tributos };
}

/**
 * Quando o emitente da DPS é o próprio prestador (tpEmit=1), a SEFIN recusa
 * qualquer dado cadastral no XML — ela usa o que já tem no cadastro. Rejeições
 * observadas na Produção Restrita:
 *
 *   E0121 — nome/razão social do prestador não deve ser informado
 *   E0128 — endereço nacional do prestador não deve ser informado
 *
 * As duas são a mesma regra aplicada a campos diferentes, então enviamos apenas
 * o que identifica fiscalmente (CNPJ, inscrição municipal) e o regime tributário,
 * que é obrigatório. Nome, endereço, telefone e e-mail ficam de fora — e o DANFSe
 * continua mostrando todos eles, preenchidos pela SEFIN.
 */
function montarPrestador(emitente, { emitidaPeloPrestador = true } = {}) {
  const cadastral = emitidaPeloPrestador
    ? ['', '', '']
    : [montarEndereco(emitente), tag('fone', apenasDigitos(emitente.telefone) || null), tag('email', emitente.email)];

  return grupo('prest', [
    tag('CNPJ', apenasDigitos(emitente.cnpj)),
    tag('IM', emitente.inscricao_municipal),
    emitidaPeloPrestador ? '' : tag('xNome', emitente.razao_social),
    ...cadastral,
    grupo('regTrib', [
      tag(
        'opSimpNac',
        emitente.optante_simples_nacional
          ? OP_SIMPLES_NACIONAL.me_epp
          : OP_SIMPLES_NACIONAL.nao_optante
      ),
      // regApTribSN só se aplica a optante do Simples; fora disso o XSD pede ausência.
      tag('regEspTrib', emitente.regime_especial ?? '0'),
    ]),
  ]);
}

function montarTomador(tomador) {
  const doc = apenasDigitos(tomador.documento);
  return grupo('toma', [
    doc.length === 14 ? tag('CNPJ', doc) : tag('CPF', doc),
    tag('IM', tomador.inscricao_municipal),
    tag('xNome', tomador.razao_social),
    montarEndereco(tomador),
    tag('fone', apenasDigitos(tomador.telefone) || null),
    tag('email', tomador.email),
  ]);
}

/**
 * O grupo `end` é opcional, mas quando presente exige xLgr, nro e xBairro.
 * Meio preenchido o schema rejeita — por isso ou vai completo, ou não vai.
 */
function montarEndereco(pessoa) {
  const cep = apenasDigitos(pessoa.cep);
  const completo =
    pessoa.codigo_municipio && cep.length === 8 && pessoa.logradouro && pessoa.numero && pessoa.bairro;
  if (!completo) return '';

  return grupo('end', [
    grupo('endNac', [tag('cMun', pessoa.codigo_municipio), tag('CEP', cep)]),
    tag('xLgr', pessoa.logradouro),
    tag('nro', pessoa.numero),
    tag('xCpl', pessoa.complemento),
    tag('xBairro', pessoa.bairro),
  ]);
}

function montarServico({ emitente, servico, nota }) {
  return grupo('serv', [
    grupo('locPrest', [
      tag('cLocPrestacao', nota.municipioIncidencia ?? emitente.codigo_municipio),
    ]),
    grupo('cServ', [
      tag('cTribNac', apenasDigitos(servico.codigo_tributacao_nacional)),
      tag('xDescServ', nota.descricaoServico),
      tag('cNBS', servico.codigo_nbs),
    ]),
  ]);
}

function montarValores({ emitente, servico, tributos }) {
  const temDeducao = tributos.deducoes > 0;
  const optanteSimples = Boolean(emitente.optante_simples_nacional);

  /**
   * E0617 — não pode informar `pAliq` quando o prestador é NÃO optante do
   * Simples e o convênio do município de incidência está ATIVO: nesse caso a
   * alíquota vem da tabela do município.
   * E0619 — mas `pAliq` é OBRIGATÓRIO se o convênio NÃO estiver ativo.
   *
   * Como a situação do convênio é do município e não temos como saber daqui,
   * ela é configurável (`emitente.convenio_municipio_ativo`, padrão ativo).
   */
  const convenioAtivo = emitente.convenio_municipio_ativo !== 0;
  const informarAliquota = optanteSimples || !convenioAtivo;

  return grupo('valores', [
    grupo('vServPrest', [tag('vServ', dec(tributos.valorServico))]),
    temDeducao ? grupo('vDedRed', [tag('vDR', dec(tributos.deducoes))]) : '',
    grupo('trib', [
      grupo('tribMun', [
        tag('tribISSQN', TRIB_ISSQN[servico.tipo_tributacao_issqn] ?? TRIB_ISSQN.operacao_tributavel),
        tag('tpRetISSQN', servico.iss_retido ? TP_RET_ISSQN.retido_tomador : TP_RET_ISSQN.nao_retido),
        informarAliquota ? tag('pAliq', dec(servico.aliquota_iss)) : '',
      ]),
      montarTribFederal({ servico, tributos }),
      montarTotalTributos({ optanteSimples, tributos }),
    ]),
  ]);
}

/**
 * O grupo `totTrib` é obrigatório e aceita um entre vTotTrib, pTotTrib,
 * indTotTrib e pTotTribSN.
 *
 * E0713 — para prestador NÃO optante do Simples, `indTotTrib` e `pTotTribSN`
 * nunca podem ser informados. Sobra declarar os valores: informamos o que a
 * própria nota apura — municipal é o ISS, federal é PIS + COFINS.
 */
function montarTotalTributos({ optanteSimples, tributos }) {
  if (optanteSimples) return grupo('totTrib', [tag('indTotTrib', '0')]);

  return grupo('totTrib', [
    grupo('vTotTrib', [
      tag('vTotTribFed', dec(tributos.valorPis + tributos.valorCofins)),
      tag('vTotTribEst', dec(0)),
      tag('vTotTribMun', dec(tributos.valorIss)),
    ]),
  ]);
}

function montarTribFederal({ servico, tributos }) {
  const semPisCofins =
    !Number(servico.aliquota_pis) &&
    !Number(servico.aliquota_cofins) &&
    !tributos.retencoes.csll &&
    !tributos.retencoes.ir &&
    !tributos.retencoes.inss;
  if (semPisCofins) return '';

  const cst = CST_PIS_COFINS[servico.situacao_pis_cofins] ?? CST_PIS_COFINS.NENHUM;

  return grupo('tribFed', [
    grupo('piscofins', [
      tag('CST', cst),
      tag('vBCPisCofins', dec(tributos.valorServico)),
      tag('pAliqPis', dec(servico.aliquota_pis)),
      tag('pAliqCofins', dec(servico.aliquota_cofins)),
      tag('vPis', dec(tributos.valorPis)),
      tag('vCofins', dec(tributos.valorCofins)),
      tag('tpRetPisCofins', String(servico.tipo_retencao_pis_cofins ?? 0)),
    ]),
    tributos.retencoes.inss ? tag('vRetCP', dec(tributos.retencoes.inss)) : '',
    tributos.retencoes.ir ? tag('vRetIRRF', dec(tributos.retencoes.ir)) : '',
    tributos.retencoes.csll ? tag('vRetCSLL', dec(tributos.retencoes.csll)) : '',
  ]);
}

function validarEntrada({ emitente, tomador, servico, nota }) {
  if (!emitente?.cnpj) throw new Error('Emitente sem CNPJ');
  if (!emitente?.codigo_municipio) throw new Error('Emitente sem código de município (IBGE)');
  if (!tomador?.documento) throw new Error('Tomador sem documento');
  if (!tomador?.razao_social) throw new Error('Tomador sem razão social');
  if (!servico?.codigo_tributacao_nacional) throw new Error('Serviço sem código de tributação nacional');
  if (!nota?.numeroDps) throw new Error('Nota sem número da DPS');
  if (!nota?.descricaoServico) throw new Error('Nota sem descrição do serviço');

  const codigo = apenasDigitos(servico.codigo_tributacao_nacional);
  if (codigo.length !== 6) {
    throw new Error(`Código de tributação nacional deve ter 6 dígitos: ${servico.codigo_tributacao_nacional}`);
  }
}
