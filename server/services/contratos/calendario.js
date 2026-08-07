/**
 * Datas dos contratos recorrentes.
 *
 * Isolado em funções puras porque é a parte que erra em silêncio: um contrato
 * marcado para o dia 31 que some em fevereiro, ou uma nota emitida na
 * competência errada, só aparecem no mês seguinte — quando já viraram documento
 * fiscal.
 *
 * Tudo trabalha com data local em texto (`AAAA-MM-DD`). Usar objetos `Date`
 * aqui traria fuso junto, e foi exatamente assim que a competência já saiu um
 * dia atrasada uma vez.
 */

/** Quantos dias tem o mês. `mes` é 1–12. */
export function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * Em que dia o contrato emite naquele mês.
 *
 * Contrato do dia 31 emite no dia 28 (ou 29) em fevereiro, não pula o mês:
 * pular deixaria o cliente sem nota e a receita sem lançamento, o que é pior
 * que antecipar três dias.
 */
export function diaDoMes(ano, mes, diaContrato) {
  return Math.min(Number(diaContrato), diasNoMes(ano, mes));
}

const pad = (n) => String(n).padStart(2, '0');

/** Data de emissão do contrato naquele mês, em AAAA-MM-DD. */
export function dataDeEmissao(ano, mes, diaContrato) {
  return `${ano}-${pad(mes)}-${pad(diaDoMes(ano, mes, diaContrato))}`;
}

/** Mês de referência em AAAA-MM — a chave que impede emitir duas vezes. */
export function competenciaRef(ano, mes) {
  return `${ano}-${pad(mes)}`;
}

/** Quebra 'AAAA-MM-DD' em números, sem passar por Date. */
export function partes(dataIso) {
  const [ano, mes, dia] = String(dataIso).slice(0, 10).split('-').map(Number);
  return { ano, mes, dia };
}

/**
 * Decide se um contrato deve emitir hoje, e por quê não quando não deve.
 *
 * Devolve `{ emitir, competenciaRef, dataEmissao, motivo }`. O motivo existe
 * para o painel conseguir explicar "por que este contrato não emitiu?" sem
 * ninguém precisar reler este arquivo.
 *
 * A decisão é sempre sobre o **mês corrente**. Um mês inteiro perdido (servidor
 * fora do ar por semanas) **não** é emitido retroativamente de forma automática:
 * vira alerta. Uma nota que faltou se resolve à mão; uma nota inesperada de uma
 * competência passada já é documento fiscal no mundo.
 */
export function avaliar(contrato, hojeIso) {
  const hoje = partes(hojeIso);
  const ref = competenciaRef(hoje.ano, hoje.mes);
  const dataEmissao = dataDeEmissao(hoje.ano, hoje.mes, contrato.dia_emissao);
  const base = { competenciaRef: ref, dataEmissao };

  if (!contrato.ativo) return { ...base, emitir: false, motivo: 'contrato inativo' };

  if (contrato.vigencia_inicio && dataEmissao < iso(contrato.vigencia_inicio)) {
    // Contrato cadastrado no dia 25 com emissão no dia 21 não emite retroativo
    // no mês em que foi criado: a primeira nota sai no mês seguinte.
    return { ...base, emitir: false, motivo: 'antes do início da vigência' };
  }
  if (contrato.vigencia_fim && dataEmissao > iso(contrato.vigencia_fim)) {
    return { ...base, emitir: false, motivo: 'após o fim da vigência' };
  }
  if (hojeIso < dataEmissao) {
    return { ...base, emitir: false, motivo: `aguardando o dia ${diaDoMes(hoje.ano, hoje.mes, contrato.dia_emissao)}` };
  }

  return { ...base, emitir: true, motivo: null };
}

/**
 * Competências passadas dentro da vigência, da mais recente para trás.
 *
 * Serve para o alerta de emissão perdida: comparando com o que existe em
 * `nota`, o que faltar é o que precisa de atenção humana.
 */
export function competenciasAnteriores(contrato, hojeIso, quantos = 3) {
  const hoje = partes(hojeIso);
  const lista = [];
  for (let i = 1; i <= quantos; i += 1) {
    const total = hoje.ano * 12 + (hoje.mes - 1) - i;
    const ano = Math.floor(total / 12);
    const mes = (total % 12) + 1;
    const dataEmissao = dataDeEmissao(ano, mes, contrato.dia_emissao);

    if (contrato.vigencia_inicio && dataEmissao < iso(contrato.vigencia_inicio)) break;
    if (contrato.vigencia_fim && dataEmissao > iso(contrato.vigencia_fim)) continue;
    lista.push({ competenciaRef: competenciaRef(ano, mes), dataEmissao });
  }
  return lista;
}

/** Aceita DATE do MySQL (objeto) ou texto, e devolve sempre AAAA-MM-DD. */
function iso(valor) {
  if (valor instanceof Date) {
    return `${valor.getFullYear()}-${pad(valor.getMonth() + 1)}-${pad(valor.getDate())}`;
  }
  return String(valor).slice(0, 10);
}

/** Data de hoje no fuso local, em AAAA-MM-DD. */
export function hojeLocal(agora = new Date()) {
  return `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}`;
}
