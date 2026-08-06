/**
 * Cálculo dos tributos da NFS-e.
 *
 * Os valores e a regra de arredondamento foram conferidos contra uma NFS-e real
 * autorizada (DANFSe v2.0, município de MG, ISS 2%, Lucro Presumido):
 *
 *   valor da operação  R$ 148,83
 *   ISS 2%             148,83 x 0,02   = 2,9766  -> R$ 2,98
 *   PIS 0,65%          148,83 x 0,0065 = 0,9674  -> R$ 0,97
 *   COFINS 3%          148,83 x 0,03   = 4,4649  -> R$ 4,46
 *
 * Confirma duas coisas: arredondamento comercial em 2 casas, e que PIS/COFINS
 * aparecem como "Débito Apuração Própria" — são da operação, não retenção.
 */

/**
 * Arredonda para 2 casas com meio-para-cima, sem o erro de ponto flutuante do
 * toFixed. `2.9766.toFixed(2)` acerta, mas casos como 1.005 não — daí o epsilon.
 */
export function arredondar(valor, casas = 2) {
  const fator = 10 ** casas;
  return Math.round((valor + Number.EPSILON) * fator) / fator;
}

/** Aplica uma alíquota percentual sobre a base e arredonda em 2 casas. */
export function aplicarAliquota(base, aliquotaPercentual) {
  return arredondar(Number(base) * (Number(aliquotaPercentual) / 100));
}

/**
 * Apura os tributos de uma nota.
 *
 * @param {object} p
 * @param {number} p.valorServico  Valor da operação
 * @param {number} [p.deducoes]    Deduções que reduzem a base do ISS
 * @param {object} p.servico       Linha da tabela `servico`
 * @returns {object} valores apurados, prontos para a DPS e para a tabela `nota`
 */
export function apurarTributos({ valorServico, deducoes = 0, servico }) {
  const valor = Number(valorServico);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(`Valor de serviço inválido: ${valorServico}`);
  }

  const bcIssqn = arredondar(valor - Number(deducoes || 0));
  if (bcIssqn < 0) throw new Error('Deduções maiores que o valor do serviço');

  // Operação própria: informados na nota, não descontados do valor a receber.
  const valorIss = aplicarAliquota(bcIssqn, servico.aliquota_iss);
  const valorPis = aplicarAliquota(valor, servico.aliquota_pis);
  const valorCofins = aplicarAliquota(valor, servico.aliquota_cofins);

  // Retenções: estas SIM reduzem o valor líquido a receber.
  const retencoes = {
    iss: servico.iss_retido ? valorIss : 0,
    pis: aplicarAliquota(valor, servico.ret_pis),
    cofins: aplicarAliquota(valor, servico.ret_cofins),
    csll: aplicarAliquota(valor, servico.ret_csll),
    inss: aplicarAliquota(valor, servico.ret_inss),
    ir: aplicarAliquota(valor, servico.ret_ir),
  };
  const totalRetencoes = arredondar(Object.values(retencoes).reduce((a, b) => a + b, 0));

  return {
    valorServico: arredondar(valor),
    deducoes: arredondar(Number(deducoes || 0)),
    bcIssqn,
    valorIss,
    valorPis,
    valorCofins,
    issRetido: Boolean(servico.iss_retido),
    retencoes,
    totalRetencoes,
    valorLiquido: arredondar(valor - totalRetencoes),
    // O DANFSe traz ISS + PIS + COFINS como "Exclusões e Reduções da Base de Cálculo"
    // do grupo IBS/CBS. Calculado aqui para quando a reforma tributária entrar.
    exclusoesBaseIbsCbs: arredondar(valorIss + valorPis + valorCofins),
  };
}
