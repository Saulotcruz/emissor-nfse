/**
 * Traduz erro de banco em instrução acionável.
 *
 * "Table 'x' doesn't exist" é tecnicamente correto e operacionalmente inútil:
 * quem lê no servidor precisa saber o que **fazer**, não o que faltou. Toda vez
 * que uma dessas mensagens cruas chegou ao operador, a resposta foi a mesma —
 * rodar a migração.
 */
export function explicar(e) {
  switch (e?.code) {
    case 'ER_NO_SUCH_TABLE':
      return `${e.message}\n\n  → Falta rodar a migração:  npm run migrate`;
    case 'ER_BAD_FIELD_ERROR':
      return `${e.message}\n\n  → Banco desatualizado em relação ao código:  npm run migrate`;
    case 'ER_BAD_DB_ERROR':
      return `${e.message}\n\n  → O banco não existe. Crie-o e rode:  npm run migrate`;
    case 'ECONNREFUSED':
      return `${e.message}\n\n  → MySQL não está respondendo. Confira o serviço e o DB_HOST/DB_PORT do .env.`;
    case 'ER_ACCESS_DENIED_ERROR':
      return `${e.message}\n\n  → Usuário ou senha do banco recusados. Confira DB_USER/DB_PASSWORD no .env.`;
    default:
      return e?.message ?? String(e);
  }
}
