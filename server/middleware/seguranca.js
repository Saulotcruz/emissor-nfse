/**
 * Cabeçalhos de segurança e defesa contra CSRF.
 *
 * Escrito à mão em vez de trazer o helmet: são poucas linhas, e o que roda
 * num sistema que emite documento fiscal deve caber numa leitura — mesmo
 * critério usado na verificação de assinatura da Stripe.
 */

/**
 * Cabeçalhos que o navegador respeita.
 *
 * O que cada um evita, concretamente:
 *  - `nosniff`: um XML ou PDF baixado do painel ser interpretado como script;
 *  - `frame-ancestors`/`X-Frame-Options`: o painel ser embutido num iframe
 *    invisível e o usuário ser induzido a clicar em "cancelar nota";
 *  - `no-referrer`: a chave de acesso da nota vazar na URL de um link externo;
 *  - HSTS: a primeira requisição cair em HTTP e a sessão viajar em claro.
 */
export function cabecalhosDeSeguranca(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:", // o QR do DANFSe é embutido como data: URI
      "style-src 'self' 'unsafe-inline'", // estilos inline gerados pelo React
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  // HSTS só faz sentido sobre HTTPS; mandá-lo em HTTP local só atrapalha.
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const METODOS_QUE_MUDAM = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Recusa requisição que muda estado vinda de outra origem.
 *
 * O cookie já é `sameSite: 'lax'`, o que sozinho barra o CSRF clássico nos
 * navegadores atuais. Esta é a segunda tranca: navegador sempre manda `Origin`
 * em requisição cross-site, então uma origem que não confere é recusada aqui,
 * sem depender de o navegador honrar o SameSite.
 *
 * Ausência de `Origin` é liberada de propósito: é o caso de cliente que não é
 * navegador (curl, os testes, o webhook da Stripe), e esses não carregam o
 * cookie de sessão de ninguém — é justamente o que o CSRF explora.
 */
export function mesmaOrigem(req, res, next) {
  if (!METODOS_QUE_MUDAM.has(req.method)) return next();

  const origem = req.get('origin');
  if (!origem) return next();

  const esperada = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  try {
    if (new URL(origem).origin === new URL(esperada).origin) return next();
  } catch {
    // Origin malformado: trata como não confere.
  }
  return res.status(403).json({ error: 'Origem não autorizada' });
}
