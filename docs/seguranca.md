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
| Clickjacking | `X-Frame-Options: DENY` e `frame-ancestors 'none'` |
| Sniffing de tipo | `X-Content-Type-Options: nosniff` |
| Chave de acesso vazando em referer | `Referrer-Policy: no-referrer` |
| Webhook forjado | HMAC-SHA256 sobre o corpo cru, comparação em tempo constante, janela de 300s |
| Reentrega de webhook | `stripe_event_id` UNIQUE + `nota.stripe_invoice_id` UNIQUE |

O webhook **falha fechado**: sem `STRIPE_WEBHOOK_SECRET` ele recusa tudo, em vez de aceitar
sem verificar.

## O que depende do servidor, não do código

**A porta 3100 não pode estar acessível pela internet.** O app confia no cabeçalho
`X-Forwarded-For` (`trust proxy: 1`), que é o correto atrás do nginx. Se alguém alcançar a
porta direto, forja esse cabeçalho e o bloqueio de login — que conta por IP — deixa de valer.

Conferir:

```bash
sudo ss -lntp | grep 3100
```

Deve aparecer `127.0.0.1:3100`. Se aparecer `0.0.0.0:3100`, fechar no firewall
(`sudo ufw deny 3100`) ou prender o listen ao loopback.

Também do servidor: `.pfx` em `/opt/nfse/certs/` com `chmod 600`, `.env` fora do Git, e
backup do banco.

## O que ainda não está protegido

- **Sem segundo fator.** Senha vazada = emitir e cancelar nota fiscal em nome da empresa.
  É o próximo item da fila.
- **Senha do certificado em texto no `.env`.** Quem lê o arquivo assina documento fiscal.
- **Sem trilha de auditoria** de quem emitiu ou cancelou o quê.
- **Sem limite de requisições fora do login.** Uma sessão válida pode chamar
  `/sincronizar` em laço.
- Estado do bloqueio de login vive em memória: se um dia virar cluster, cada processo conta
  separado (ver `ecosystem.config.cjs`, hoje 1 instância).
