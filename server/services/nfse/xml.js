/**
 * Helpers mínimos de XML. Não usamos biblioteca de serialização de propósito:
 * o XML da DPS é assinado, então qualquer reordenação ou reformatação feita por
 * uma lib entre a montagem e a assinatura quebraria o digest.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapar(valor) {
  return String(valor).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** `<tag>valor</tag>`, ou string vazia quando o valor é nulo/vazio. */
export function tag(nome, valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  return `<${nome}>${escapar(valor)}</${nome}>`;
}

/** Agrupa filhos sob uma tag; some se não sobrar nenhum filho. */
export function grupo(nome, filhos, { atributos = '' } = {}) {
  const conteudo = filhos.filter(Boolean).join('');
  if (!conteudo) return '';
  return `<${nome}${atributos}>${conteudo}</${nome}>`;
}

/**
 * Formata decimal no padrão do XSD (TSDec15V2 e afins): ponto como separador
 * e exatamente 2 casas. Vírgula ou 3 casas fazem o schema rejeitar.
 */
export function dec(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new Error(`Valor decimal inválido: ${valor}`);
  return n.toFixed(2);
}

/**
 * Data/hora no formato TSDateTimeUTC: AAAA-MM-DDThh:mm:ss±hh:mm.
 * O XSD exige o offset explícito — `toISOString()` produz "Z", que NÃO passa.
 */
export function dataHoraUtc(data, offsetHoras = -3) {
  const d = data instanceof Date ? data : new Date(data);
  if (Number.isNaN(d.getTime())) throw new Error(`Data inválida: ${data}`);

  const deslocado = new Date(d.getTime() + offsetHoras * 3600000);
  const iso = deslocado.toISOString().slice(0, 19);
  const sinal = offsetHoras < 0 ? '-' : '+';
  const hh = String(Math.abs(offsetHoras)).padStart(2, '0');
  return `${iso}${sinal}${hh}:00`;
}

/**
 * Data simples AAAA-MM-DD (TSData).
 *
 * Quando o valor já é uma data civil — o que o MySQL devolve com `dateStrings`,
 * por exemplo — ele volta intacto. Converter para Date primeiro seria um bug:
 * `new Date('2026-09-01')` é meia-noite UTC, e o deslocamento de -3h jogaria a
 * competência para 2026-08-31, ou seja, o mês anterior.
 */
export function dataSimples(data, offsetHoras = -3) {
  if (typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.trim())) {
    return data.trim();
  }
  return dataHoraUtc(data, offsetHoras).slice(0, 10);
}
