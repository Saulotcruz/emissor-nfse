# Emissor de NFS-e — Padrão Nacional

Sistema próprio de emissão de NFS-e, integrando **Stripe → SEFIN Nacional** diretamente, sem
intermediários. Substitui o caminho Stripe → n8n → Asaas documentado em `../NFSe/`.

A emissão usa o certificado A1 da própria empresa: no Padrão Nacional, o certificado do
contribuinte **é** a autorização — não há procuração nem credenciamento de software house.

## Status

| Fase | Escopo | Estado |
|---|---|---|
| 1 | Esqueleto, banco, autenticação, tomadores, configuração, cálculo de tributos | ✅ concluída |
| 2 | `dps-builder` + `signer` (XMLDSig) | ✅ concluída |
| 3 | `transport` + emissão em Produção Restrita | ✅ concluída — **NFS-e autorizada** |
| 4 | Webhook da Stripe + idempotência | ✅ concluída |
| 5 | Painel React | 🟡 tela de notas pronta |
| 6 | Cancelamento e reemissão | ✅ concluída |
| 7 | Virada para Produção | ⬜ |

## Stack

Node ESM + Express + MySQL (`mysql2`), sessão por cookie, testes com vitest + supertest.
Mesmo padrão do `mini-crm/CRM`, de propósito: o servidor já roda essa combinação.

## Subindo o ambiente

Crie a database antes — o `migrate` cria as tabelas, não a database:

```sql
CREATE DATABASE nfse_emissor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nfse'@'localhost' IDENTIFIED BY 'uma-senha-forte';
GRANT ALL PRIVILEGES ON nfse_emissor.* TO 'nfse'@'localhost';
FLUSH PRIVILEGES;
```

Depois:

```bash
cp .env.example .env        # preencha DB_*, SESSION_SECRET
npm install
npm run migrate
ADMIN_EMAIL=voce@example.com ADMIN_SENHA=suaSenha npm run seed
npm run dev
```

O `seed` lê os dados fiscais do **`.env`** (bloco `EMITENTE_*` e `SERVICO_*`) e cria a linha
do emitente e o serviço padrão. Nada de dado fiscal fica no código — este repositório é
público. Se faltar alguma variável obrigatória, o seed avisa qual e não grava nada.

### No servidor

O repositório não versiona `node_modules`. Depois de clonar ou de um `git pull` que mexa em
`package.json`, instale as dependências com as versões travadas no lock — **sem as de
desenvolvimento**:

```bash
npm ci --omit=dev
```

Sem isso qualquer script falha com `ERR_MODULE_NOT_FOUND`.

`--omit=dev` deixa de fora 147 pacotes que só servem para teste e lint (vitest, vite, esbuild).
Além de instalar mais rápido, tira do servidor o único ponto onde o `npm audit` acusa
vulnerabilidades — todas na cadeia do Vitest, e todas relacionadas a servidor de
desenvolvimento, que não roda em produção. As dependências de runtime estão limpas.

Em desenvolvimento, o `npm ci` normal continua sendo o certo, porque os testes precisam do
vitest.

### Conferindo o certificado A1

Depois de instalar o `.pfx` no servidor e preencher `NFSE_CERT_PATH` e
`NFSE_CERT_PASSWORD` no `.env`:

```bash
npm run cert
```

Mostra titular, validade, fingerprint e alerta se a permissão do arquivo estiver frouxa ou
se o vencimento estiver perto. Não toca na rede e não emite nada.

### Cadastrando um tomador

```bash
npm run tomador -- --cnpj 19131243000197
```

Busca razão social e endereço na BrasilAPI. Como ela devolve o código **SIAFI** do município
e a DPS exige o **IBGE**, passe `--ibge 3550308` se quiser o endereço do tomador na nota —
sem ele o grupo de endereço é omitido, o que o schema aceita.

### Primeira emissão de teste

Com o certificado no lugar e um tomador cadastrado:

```bash
npm run emitir-teste -- --tomador 19131243000197 --valor 1.00 --descricao "Teste"
```

Use `--dry-run` para ver o XML assinado sem enviar nada (não consome número de DPS) e
`--sha1` para trocar o algoritmo da assinatura. O ambiente vem de `emitente.ambiente`; em
produção o script pede confirmação explícita antes de emitir.

### Cancelando uma nota

```bash
npm run cancelar -- --nota 1 --motivo "Emissao de teste em homologacao"
```

A justificativa precisa ter entre 15 e 255 caracteres (exigência do schema). `--codigo` aceita
`1` erro na emissão (padrão), `2` serviço não prestado ou `9` outros. Use `--dry-run` para ver
o XML assinado sem enviar.

Prazo, valor limite e exigência de tomador identificado são **parametrizados pelo município**
(regras E0822, E0823 e E0824), então a recusa pode ser legítima mesmo com o XML correto.

### Painel

Tela de notas em `web/`, no mesmo layout do CRM. Listagem com filtro por status e competência,
detalhe da nota, download do XML, reemissão e cancelamento.

```bash
npm run build:web        # gera web/dist, servido pelo próprio backend
```

Em desenvolvimento, `npm --prefix web run dev` sobe o Vite com proxy para a porta 3100.

O acesso usa o mesmo login da API. Uma faixa âmbar no topo avisa quando o ambiente é Produção
Restrita — saber em qual ambiente se está é a informação mais cara de descobrir tarde.

### Rodando o serviço

Os comandos `cert`, `tomador`, `emitir-teste` e `cancelar` são de linha: executam e saem.
O servidor HTTP (webhook da Stripe, API e painel) é o `server/index.js`, na **porta 3100**
por padrão — ajustável pela env `PORT`.

Com pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save
```

O `pm2 startup` (uma vez, com sudo) faz o serviço voltar sozinho depois de reiniciar a máquina.
As migrações rodam automaticamente no boot do processo.

Atrás do nginx, lembre de `COOKIE_SECURE=1` no `.env` — o `trust proxy` já está ligado e a
sessão depende do `X-Forwarded-Proto`.

### Webhook da Stripe

Na Stripe, crie um endpoint apontando para `https://SEU_HOST/api/stripe/webhook` com o evento
**`invoice.payment_succeeded`**, e ponha o signing secret em `STRIPE_WEBHOOK_SECRET`.

O CNPJ do tomador sai do **Tax ID** do cliente (`br_cnpj`), que a Stripe grava na própria
fatura — não precisa de metadata nem de chamada extra à API. O metadata `auto_invoice.cnpj`
continua funcionando como alternativa, para clientes cadastrados antes do Tax ID.

Não emitem nota, por decisão de negócio: fatura de valor zero (trial) e moeda diferente de BRL.

### Aviso de cada emissão

A cada NFS-e autorizada, um e-mail sai com o **XML em anexo** — o documento fiscal em si; o
DANFSe é representação. Traz número, chave de acesso, tomador, valor e os tributos apurados,
e marca `[TESTE]` no assunto quando a nota é de Produção Restrita.

Usa a mesma configuração SMTP dos alertas. Desligue com `NOTIFICAR_EMISSAO=0`, ou mande para
outro destino com `EMISSAO_EMAIL_PARA`.

Falha de e-mail **nunca** derruba a emissão: quando o aviso roda, a nota já está autorizada na
SEFIN, e uma exceção aqui faria a emissão parecer malsucedida.

### Conferindo cancelamentos feitos por fora

Cancelar pelo Portal Nacional não avisa este sistema, e o XML da nota também não denuncia: o
`cStat` só distingue tipos de NFS-e gerada e nunca muda para cancelada — o cancelamento é um
evento separado.

```bash
npm run sincronizar
```

Consulta `GET /nfse/{chave}/eventos` para cada nota autorizada e marca como cancelada as que
tiverem evento de cancelamento (comum, por substituição, por análise fiscal ou de ofício). No
painel, o botão **Conferir na SEFIN** faz o mesmo.

Isto **não** tem relação com numeração: o número da DPS é consumido na emissão e cancelar não o
devolve, então não há falha de sequência. O que se corrige é o sistema afirmar que uma nota está
válida quando não está mais.

Confere as notas autorizadas nos **últimos 90 dias** — a janela existe para a carga na SEFIN
não crescer junto com o histórico. `--dias 365` amplia; `--dias 0` confere todas.

No cron, de meia em meia hora:

```
*/30 * * * * cd /var/www/emissor-nfse && /usr/bin/node scripts/sincronizar.js >> logs/sincronizar.log 2>&1
```

Note o `*/30`: `30 * * * *` roda de hora em hora, no minuto 30 — não a cada 30 minutos.

### Alertas por e-mail

Com a emissão automática rodando, uma nota que falha não avisa ninguém: o webhook responde
200 e o erro fica só no banco. O comando abaixo varre o sistema e manda e-mail **só quando há
o que relatar**:

```bash
npm run alertas
```

Verifica notas rejeitadas pela SEFIN, notas presas sem envio, eventos da Stripe que não viraram
nota e a validade do certificado A1. Opções: `--dry-run` (mostra sem enviar), `--testar` (só
manda um e-mail de teste) e `--reemitir` (tenta reenviar as notas presas antes de relatar).

No cron, uma vez por dia:

```
0 8 * * * cd /var/www/emissor-nfse && /usr/bin/node scripts/verificar-alertas.js >> logs/alertas.log 2>&1
```

### Ambiente fiscal

```bash
npm run ambiente                  # mostra a situação atual
npm run ambiente -- --producao    # passa a emitir nota válida (pede confirmação)
```

⚠️ Mudar `NFSE_AMBIENTE` no `.env` **não** troca o ambiente: essa variável só é lida pelo
`seed`, que não altera registro existente. Quem vale é a coluna `emitente.ambiente`, e este
comando é o único jeito de mudá-la fora do painel.

O passo a passo completo da virada está em [docs/producao.md](docs/producao.md).

### Testes

Precisam de um MySQL acessível e de um `.env.test` (veja `.env.test.example`):

```bash
npm test
```

## Estrutura

```
server/
  app.js                  createApp() — monta rotas e sessão
  index.js                bootstrap: migra, sobe, serve web/dist se existir
  db/                     pool, migrations, seed
  middleware/auth.js      requireAuth / requireAdmin
  routes/
    auth.js               login, logout, me
    tomadores.js          CRUD + consulta de CNPJ na BrasilAPI
    notas.js              listagem, detalhe, download do XML
    config.js             emitente, serviços, situação do certificado
  services/
    documento.js          validação de CNPJ/CPF
    calculo.js            apuração de ISS/PIS/COFINS e retenções
    brasilapi.js          consulta cadastral de CNPJ
    nfse/
      id-dps.js           Id da DPS, faixas de série, chave de acesso
      xml.js              escape, decimais e datas no formato do XSD
      dps-builder.js      objeto de domínio -> XML da DPS
      signer.js           XMLDSig sobre infDPS (xml-crypto + node-forge)
      client.js           fachada: reserva, monta, assina, envia e persiste
      evento-builder.js   pedido de registro de evento (cancelamento e101101)
    stripe/
      webhook.js          verificação da assinatura (HMAC, tempo constante)
      mapper.js           fatura -> payload de emissão
      processador.js      resolve tomador, reserva e emite
      transport.js        mTLS, gzip+base64, POST/GET/HEAD e eventos
      errors.js           rejeição x transporte x certificado
schemas/1.01/             XSDs oficiais (gov.br), sem modificação
  tests/
```

## Validação do XML

Os XSDs oficiais estão versionados em `schemas/1.01/` **sem nenhuma alteração**. Os testes
validam o XML gerado com `xmllint` (nativo no macOS; no Linux, pacote `libxml2-utils`).

> **Defeito conhecido do pacote oficial v1.01**: o tipo `TSSerieDPS` traz
> `pattern="^0{0,4}\d{1,5}$"`. Em XML Schema os patterns já são ancorados e `^`/`$` valem como
> caracteres literais — do jeito que está, nenhum valor de série valida. É o único pattern do
> arquivo com âncoras e a v1.00 não tinha pattern algum, então é erro de digitação do schema.
> A correção é aplicada só na cópia temporária usada na validação
> (`server/tests/helpers/xsd.js`), para a divergência ficar explícita.

## Referência fiscal

`docs/referencia-nfse.md` traz o mapeamento campo a campo extraído de uma **NFS-e real
autorizada**. É a fonte de verdade para o `dps-builder` — os valores de tributo daquela nota
viraram teste de regressão em `server/tests/calculo.test.js`.

## Decisões que valem lembrar

- **Idempotência**: `nota.stripe_invoice_id` é UNIQUE. A Stripe reenvia webhooks; o índice é o
  que impede a segunda nota. Numa retentativa, o mesmo `numero_dps` é reaproveitado, o que torna
  o `id_dps` determinístico e permite confirmar na SEFIN se já foi emitida.
- **Série 1**: a faixa 1–49999 é reservada para emissão via webservice. As notas emitidas
  manualmente no Portal Nacional ficam na faixa 70000–79999, então **não há colisão** e dá para
  emitir pelos dois caminhos durante a transição.
- **Senha do certificado nunca vai ao banco.** A tabela `certificado` guarda só metadados, para
  o painel avisar do vencimento. A senha vem de `NFSE_CERT_PASSWORD`.
- **Tomador é inativado, não apagado** — notas emitidas referenciam o cadastro.
- **`codigo_municipio` da BrasilAPI não é usado**: ela devolve o código SIAFI, e a DPS exige o
  IBGE de 7 dígitos. A conversão entra na Fase 2.
- **BrasilAPI exige `User-Agent`**: sem o header ela responde 403 ao `fetch` do Node.

## Referências

- [Swagger SEFIN Nacional — Produção Restrita](https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/docs/index)
- [APIs Produção Restrita e Produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao)
- [Manual das APIs do Sistema Nacional NFS-e](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf)
