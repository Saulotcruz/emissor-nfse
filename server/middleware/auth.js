/**
 * Autenticação e papéis.
 *
 * Três papéis, do menor para o maior privilégio:
 *
 *   visualizacao  ver notas, baixar XML e DANFSe
 *   emissao       o acima + emitir, reemitir, cancelar e cadastrar tomadores
 *   admin         tudo + alíquotas, dados do emitente, usuários e auditoria
 *
 * São cumulativos de propósito: a autorização pergunta "tem pelo menos este
 * nível?", e não "é exatamente este papel". Assim uma rota nova de emissão não
 * precisa lembrar de incluir o admin na lista — esquecer isso seria um buraco
 * silencioso, que só aparece quando alguém reclama de um 403.
 */

export const PAPEIS = ['visualizacao', 'emissao', 'admin'];

const NIVEL = Object.fromEntries(PAPEIS.map((p, i) => [p, i]));

export function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  next();
}

/** Exige o papel informado ou qualquer um acima dele. */
export function requirePapel(minimo) {
  const exigido = NIVEL[minimo];
  if (exigido === undefined) throw new Error(`Papel desconhecido: ${minimo}`);

  return function verificar(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
    // Papel fora da lista (dado corrompido, papel removido) não vira acesso:
    // na dúvida, nega.
    const meu = NIVEL[req.session.user.papel];
    if (meu === undefined || meu < exigido) {
      return res.status(403).json({ error: 'Seu perfil não permite esta ação' });
    }
    return next();
  };
}

export const requireEmissao = requirePapel('emissao');
export const requireAdmin = requirePapel('admin');

/**
 * Barra quem ainda usa a senha provisória que um admin definiu.
 *
 * Precisa ser servidor, não tela: enquanto a senha for conhecida por duas
 * pessoas, a trilha de auditoria não pode afirmar que foi o dono da conta quem
 * emitiu ou cancelou. Uma barreira só no painel seria contornável por qualquer
 * chamada direta à API.
 *
 * Fica de fora de `/me`, `/me/senha` e `/logout` — é por elas que o usuário sai
 * dessa situação.
 */
export function exigirSenhaDefinitiva(req, res, next) {
  if (!req.session?.user?.deveTrocarSenha) return next();
  return res.status(403).json({
    error: 'Defina uma senha nova antes de usar o sistema',
    codigo: 'SENHA_PROVISORIA',
  });
}
