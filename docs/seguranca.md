# Segurança

O que protege o sistema, o que ainda não protege, e o que depende do servidor e não do código.

## Superfície exposta

Toda rota sob `/api` foi verificada sem sessão. O resultado:

| Rota | Sem sessão |
|---|---|
| `GET /api/health` | 200 — público de propósito, devolve só `{ok:true}` |
| `POST /api/stripe/webhook` | 400 sem assinatura válida |
| **Todas as demais** (notas, tomadores, config, `/me`) | **401** |

`notas`, `tomadores` e `config` têm `router.use(requireAuth)` na primeira linha, antes de
qualquer rota — não existe rota registrada acima do guarda. Escrita em `config` (emitente e
serviços) exige ainda `requireAdmin`.

Não há CORS configurado, então o navegador já barra leitura de outra origem. Não há
credencial padrão: o usuário admin só nasce se `seed()` receber e-mail e senha.

## Defesas em vigor

| Risco | Defesa |
|---|---|
| Força bruta na senha | Bloqueio por IP+e-mail, 5 tentativas / 15 min, com `Retry-After` |
| Enumeração de usuários | Mensagem genérica **e** tempo de resposta constante (bcrypt contra hash descartável) |
| Fixação de sessão | `req.session.regenerate()` no login |
| Sessão em claro | Cookie `httpOnly`, `sameSite=lax`, `secure` automático em produção |
| Segredo fraco de sessão | Aplicação **não sobe** em produção sem `SESSION_SECRET` de 32+ caracteres |
| CSRF | `sameSite=lax` + checagem de `Origin` nos métodos que mudam estado |
| Senha vazada | **Segundo fator TOTP** (Google Authenticator) — senha certa não abre sessão |
| Código TOTP capturado | Contador do último código aceito gravado: o mesmo código não vale duas vezes |
| Adivinhação do código de 6 dígitos | 5 tentativas / 15 min, na mesma contagem do login |
| Abuso da API por sessão válida | Teto de 600 req/5min geral e 30 req/5min nas operações caras |
| Clickjacking | `X-Frame-Options: DENY` e `frame-ancestors 'none'` |
| Sniffing de tipo | `X-Content-Type-Options: nosniff` |
| Chave de acesso vazando em referer | `Referrer-Policy: no-referrer` |
| Webhook forjado | HMAC-SHA256 sobre o corpo cru, comparação em tempo constante, janela de 300s |
| Reentrega de webhook | `stripe_event_id` UNIQUE + `nota.stripe_invoice_id` UNIQUE |

O webhook **falha fechado**: sem `STRIPE_WEBHOOK_SECRET` ele recusa tudo, em vez de aceitar
sem verificar.

## Segundo fator (TOTP)

Ativação em `Configuração → Verificação em duas etapas`. Três passos, por um motivo cada:

1. **Gerar o QR** — o segredo é gravado, mas com `mfa_ativo = 0`. Ativar antes da confirmação
   trancaria para fora quem não conseguiu ler o QR, e aqui não há "esqueci minha senha".
2. **Confirmar com um código** — prova que o aplicativo está gerando os códigos certos.
3. **Guardar os dez códigos de recuperação** — mostrados uma única vez, guardados como hash,
   cada um válido uma vez. São a única saída se o celular se perder.

Detalhes que importam:

- O TOTP é implementado no projeto (`services/mfa/totp.js`), sem dependência nova, e é
  testado contra os **vetores oficiais do RFC 6238** — é isso que garante que os códigos
  batem com os do Google Authenticator.
- Com MFA ligado, a senha certa devolve `{ mfaRequerido: true }` e **não** popula
  `req.session.user`. Até o segundo fator, `requireAuth` barra tudo.
- O contador do último código aceito é gravado (`mfa_ultimo_contador`). Sem isso, um código
  visto por cima do ombro continuaria valendo pelos 30 segundos dele.
- Desativar exige senha **e** código: só a sessão não basta, senão uma sessão roubada
  desligaria justamente a proteção contra sessão roubada.
- O segredo fica em claro no banco. Quem já tem acesso ao banco tem tudo de qualquer forma,
  mas está registrado como limite conhecido.

## Papéis

| Papel | Pode |
|---|---|
| `visualizacao` | Ver notas, baixar XML e DANFSe |
| `emissao` | O acima + emitir, reemitir, cancelar e cadastrar tomadores |
| `admin` | Tudo + alíquotas, dados do emitente, usuários e auditoria |

São **cumulativos**: a autorização pergunta "tem pelo menos este nível?", não "é exatamente
este papel". Uma rota nova de emissão não precisa lembrar de incluir o admin na lista —
esquecer isso seria um buraco silencioso.

Papel desconhecido (dado corrompido, papel removido) **nega**, nunca libera.

Duas travas na gestão de usuários, pelo mesmo motivo — ninguém pode deixar o sistema sem dono:

- não dá para rebaixar, desativar ou apagar **a si mesmo**;
- não dá para deixar o sistema **sem nenhum admin ativo**.

Usuário criado por um admin nasce com `deve_trocar_senha`. Enquanto não trocar, o servidor
recusa tudo fora de `/me`, `/me/senha` e `/logout` — e isso é **do servidor**, não da tela:
enquanto a senha for conhecida por duas pessoas, a trilha não pode afirmar que foi o dono da
conta quem emitiu ou cancelou.

Admin pode desligar o MFA de outro usuário (para quem perdeu o celular e gastou os códigos de
recuperação). É a única forma de reduzir a proteção de uma conta sem saber a senha dela, e por
isso fica na trilha marcada com `por: admin`.

## Trilha de auditoria

Tabela `auditoria`, **append-only**: não existe rota que altere ou apague linha, e a de
consulta (`GET /api/auditoria`, só admin) não tem contrapartida de escrita.

Registra login e falha de login, falha de segundo fator, logout, troca de senha, ativação e
desativação de MFA, uso de código de recuperação, emissão, reemissão e cancelamento de nota,
sincronização que achou divergência, e alterações de tomador, emitente e serviço.

Duas decisões:

- **O e-mail é copiado junto do `user_id`**: a resposta a "quem cancelou esta nota?" não pode
  depender de o usuário ainda existir.
- **Falha ao gravar a trilha não derruba a operação.** Quando o cancelamento já foi aceito
  pela SEFIN, recusar aqui não desfaz nada lá — só deixaria o sistema fora de sincronia com o
  fisco. Perder a linha é ruim; recusar um ato fiscal já consumado é pior. O erro vai para o
  log.

Emissão automática pela Stripe entra na trilha sem usuário, marcada como `automático`.

## Limite de requisições

| Alvo | Teto |
|---|---|
| Login e segundo fator | 5 **falhas** / 15 min, por IP+e-mail |
| `/api` em geral | 600 chamadas / 5 min |
| Notas: sincronizar, reemitir, cancelar, DANFSe | 30 / 5 min |
| Webhook da Stripe | 300 / min |
| Conferência de código no MFA | 10 / 5 min |

A contagem é por usuário quando há sessão e por IP quando não há — senão todo mundo atrás do
mesmo NAT dividiria a cota. O limite das operações de nota não é só custo de CPU: reemitir em
laço queima sequência de números de DPS na SEFIN, e isso não se recupera.

## O que depende do servidor, não do código

**A porta 3100 não pode estar acessível pela internet.** O app confia no cabeçalho
`X-Forwarded-For` (`trust proxy: 1`), que é o correto atrás do nginx. Se alguém alcançar a
porta direto, forja esse cabeçalho e os limites — que contam por IP — deixam de valer.

Conferir:

```bash
sudo ss -lntp | grep 3100
```

Deve aparecer `127.0.0.1:3100`. **Conferido em agosto/2026: o NAT encaminha apenas 80 e 443,
com firewall à frente.**

Também do servidor: `.pfx` em `/opt/nfse/certs/` com `chmod 600`, `.env` fora do Git, e
backup do banco.

## O que ainda não está protegido

- **Senha do certificado em texto no `.env`.** Quem lê o arquivo assina documento fiscal.
  Próximo item da fila.
- **Segredo do TOTP em claro no banco.** Só protege contra senha vazada, não contra dump do
  banco.
- **Sem upload do certificado pela interface** — trocar o `.pfx` ainda exige acesso ao
  servidor.
- Estado dos limites vive em memória: se um dia virar cluster, cada processo conta separado
  (ver `ecosystem.config.cjs`, hoje 1 instância).
- Sem expiração por inatividade: a sessão vale 12 horas corridas.
