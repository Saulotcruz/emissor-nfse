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
  baldes.clear();
}

/* ------------------------------------------------------- limite geral de uso */

/**
 * Limite de requisições para o resto da API.
 *
 * O bloqueio de login acima protege a senha; este protege o serviço. São coisas
 * diferentes: aquele conta **falhas** e trava a conta, este conta **chamadas** e
 * segura o ritmo, mesmo de quem está autenticado.
 *
 * Também é em memória, pelo mesmo motivo e com a mesma ressalva: uma instância
 * só. Ver `ecosystem.config.cjs`.
 */
const baldes = new Map();

function contar(chaveBalde, janelaMs, agora) {
  const balde = baldes.get(chaveBalde);
  if (!balde || agora - balde.inicio > janelaMs) {
    const novo = { contagem: 1, inicio: agora };
    baldes.set(chaveBalde, novo);
    return novo;
  }
  balde.contagem += 1;
  return balde;
}

/** Remove baldes vencidos; roda de vez em quando para o Map não crescer sem fim. */
function limparBaldes(agora) {
  if (baldes.size < 5000) return;
  for (const [k, v] of baldes) {
    if (agora - v.inicio > 60 * 60_000) baldes.delete(k);
  }
}

/**
 * @param {object} opcoes
 * @param {number} opcoes.maximo     chamadas permitidas na janela
 * @param {number} opcoes.janelaMs
 * @param {string} opcoes.nome       identifica o balde; rotas diferentes não se misturam
 */
export function limitador({ maximo, janelaMs, nome }) {
  return function limitar(req, res, next) {
    const agora = Date.now();
    limparBaldes(agora);

    // Por usuário quando há sessão, por IP quando não há: senão todo mundo
    // atrás do mesmo NAT dividiria a mesma cota.
    const quem = req.session?.user?.id ? `u${req.session.user.id}` : `ip${req.ip}`;
    const balde = contar(`${nome}|${quem}`, janelaMs, agora);

    if (balde.contagem > maximo) {
      const restanteS = Math.ceil((balde.inicio + janelaMs - agora) / 1000);
      res.set('Retry-After', String(restanteS));
      return res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.' });
    }
    return next();
  };
}
