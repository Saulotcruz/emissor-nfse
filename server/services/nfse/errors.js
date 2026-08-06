/**
 * Erros da comunicação com a SEFIN Nacional.
 *
 * A distinção que importa: uma REJEIÇÃO é determinística — reenviar o mesmo XML
 * dá o mesmo erro, então retentar é desperdício. Uma falha de TRANSPORTE (timeout,
 * DNS, 5xx) pode ter sucesso na retentativa, mas com uma ressalva perigosa: se o
 * POST chegou a ser processado, a nota pode ter sido emitida. Por isso o retry de
 * emissão nunca é cego — consulta-se o idDPS antes.
 */

export class SefinError extends Error {
  constructor(mensagem, { codigo = null, status = null, corpo = null, retentavel = false } = {}) {
    super(mensagem);
    this.name = 'SefinError';
    this.codigo = codigo;
    this.status = status;
    this.corpo = corpo;
    this.retentavel = retentavel;
  }
}

/** Rejeição de regra de negócio/validação: não adianta reenviar igual. */
export class RejeicaoSefinError extends SefinError {
  constructor(mensagem, opcoes = {}) {
    super(mensagem, { ...opcoes, retentavel: false });
    this.name = 'RejeicaoSefinError';
  }
}

/** Falha de rede ou indisponibilidade: pode ser retentada, com cuidado. */
export class TransporteSefinError extends SefinError {
  constructor(mensagem, opcoes = {}) {
    super(mensagem, { ...opcoes, retentavel: true });
    this.name = 'TransporteSefinError';
  }
}

/** Certificado ausente, inválido ou não aceito pela outra ponta. */
export class CertificadoSefinError extends SefinError {
  constructor(mensagem, opcoes = {}) {
    super(mensagem, { ...opcoes, retentavel: false });
    this.name = 'CertificadoSefinError';
  }
}

/**
 * Traduz a resposta HTTP num erro tipado.
 * O corpo de erro da SEFIN varia entre um objeto ProblemDetails e uma lista de
 * erros — por isso a extração é defensiva em vez de assumir um formato só.
 */
export function erroDaResposta(status, corpo) {
  const { codigo, mensagem } = extrairErro(corpo);
  const texto = mensagem || `SEFIN respondeu HTTP ${status}`;
  const opcoes = { codigo, status, corpo };

  // 496 é o código do IIS para "client certificate required" — foi o que a API
  // devolveu em teste sem mTLS. 495 é certificado inválido.
  if (status === 495 || status === 496) {
    return new CertificadoSefinError(
      'A SEFIN exige certificado de cliente (mTLS) e ele não foi aceito',
      opcoes
    );
  }
  if (status === 401 || status === 403) {
    return new CertificadoSefinError(
      `Acesso negado pela SEFIN (${status}). Verifique o certificado e o credenciamento do CNPJ`,
      opcoes
    );
  }
  if (status === 429 || status >= 500) {
    return new TransporteSefinError(texto, opcoes);
  }
  return new RejeicaoSefinError(texto, opcoes);
}

function extrairErro(corpo) {
  if (!corpo) return {};
  if (typeof corpo === 'string') return { mensagem: corpo.slice(0, 500) };

  // Lista de erros: [{ Codigo, Descricao }] ou { erros: [...] }
  const lista = Array.isArray(corpo) ? corpo : corpo.erros ?? corpo.Erros ?? corpo.errors;
  if (Array.isArray(lista) && lista.length) {
    const itens = lista.map((e) => {
      const c = e.Codigo ?? e.codigo ?? e.code;
      const d = e.Descricao ?? e.descricao ?? e.Mensagem ?? e.mensagem ?? e.message ?? String(e);
      const compl = e.Complemento ?? e.complemento;
      return [c ? `[${c}]` : '', d, compl].filter(Boolean).join(' ');
    });
    const primeiro = lista[0];
    return {
      codigo: primeiro.Codigo ?? primeiro.codigo ?? primeiro.code ?? null,
      mensagem: itens.join(' | '),
    };
  }

  // ProblemDetails (RFC 7807), usado por APIs .NET
  const mensagem = corpo.detail ?? corpo.Detail ?? corpo.title ?? corpo.Title ?? corpo.mensagem;
  return { codigo: corpo.tipoAmbiente ?? corpo.codigo ?? null, mensagem };
}
