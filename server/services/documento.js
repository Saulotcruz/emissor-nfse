/** Remove tudo que não é dígito. */
export function apenasDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * Valida CNPJ pelos dois dígitos verificadores.
 * Um CNPJ inválido rejeitado aqui é uma nota que não vira rejeição na SEFIN.
 */
export function cnpjValido(valor) {
  const cnpj = apenasDigitos(valor);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const digito = (base) => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const base = cnpj.slice(0, 12);
  const dv1 = digito(base);
  const dv2 = digito(base + dv1);
  return cnpj === `${base}${dv1}${dv2}`;
}

/** Valida CPF pelos dois dígitos verificadores. */
export function cpfValido(valor) {
  const cpf = apenasDigitos(valor);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const dv1 = digito(cpf.slice(0, 9), 10);
  const dv2 = digito(cpf.slice(0, 10), 11);
  return cpf === `${cpf.slice(0, 9)}${dv1}${dv2}`;
}

/** Retorna 'cnpj' | 'cpf' | null a partir do comprimento e dos dígitos verificadores. */
export function tipoDocumento(valor) {
  const doc = apenasDigitos(valor);
  if (doc.length === 14) return cnpjValido(doc) ? 'cnpj' : null;
  if (doc.length === 11) return cpfValido(doc) ? 'cpf' : null;
  return null;
}
