/**
 * Limite de tentativas de login.
 *
 * Sem isto, a senha do painel fica exposta a força bruta: o login é a única
 * porta para emitir e cancelar nota fiscal em nome da empresa.
 *
 * O estado é em memória de propósito — o serviço roda em uma instância só
 * (ver ecosystem.config.cjs). Se um dia virar cluster, isto precisa ir para o
 * banco ou para um Redis, senão cada processo conta separado.
 */

const TENTATIVAS_ATE_BLOQUEIO = Number(process.env.LOGIN_MAX_TENTATIVAS || 5);
const JANELA_MS = Number(process.env.LOGIN_JANELA_MINUTOS || 15) * 60_000;

const tentativas = new Map();

function chave(req) {
  // IP + e-mail: não deixa um atacante bloquear a conta de outra pessoa só
  // errando a senha dela, nem varrer muitos e-mails do mesmo IP.
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  return `${req.ip}|${email}`;
}

function limpar(agora) {
  for (const [k, v] of tentativas) {
    if (agora - v.primeira > JANELA_MS) tentativas.delete(k);
  }
}

export function registrarFalha(req) {
  const agora = Date.now();
  limpar(agora);
  const k = chave(req);
  const atual = tentativas.get(k) ?? { contagem: 0, primeira: agora };
  atual.contagem += 1;
  atual.ultima = agora;
  tentativas.set(k, atual);
}

export function limparTentativas(req) {
  tentativas.delete(chave(req));
}

export function limitarLogin(req, res, next) {
  const agora = Date.now();
  limpar(agora);
  const atual = tentativas.get(chave(req));
  if (!atual || atual.contagem < TENTATIVAS_ATE_BLOQUEIO) return next();

  const restanteS = Math.ceil((atual.primeira + JANELA_MS - agora) / 1000);
  res.set('Retry-After', String(restanteS));
  return res.status(429).json({
    error: `Muitas tentativas. Tente novamente em ${Math.ceil(restanteS / 60)} minuto(s).`,
  });
}

/** Exposto para os testes; produção não precisa zerar nada. */
export function _zerar() {
  tentativas.clear();
}
