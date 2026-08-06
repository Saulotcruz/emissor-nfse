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
| 3 | `transport` + emissão em Produção Restrita | ⬜ |
| 4 | Webhook da Stripe + idempotência | ⬜ |
| 5 | Painel React | ⬜ |
| 6 | Cancelamento e reemissão | ⬜ |
| 7 | Virada para Produção | ⬜ |

## Stack

Node ESM + Express + MySQL (`mysql2`), sessão por cookie, testes com vitest + supertest.
Mesmo padrão do `mini-crm/CRM`, de propósito: o servidor já roda essa combinação.

## Subindo o ambiente

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
