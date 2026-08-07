# Referência — campos da NFS-e (Padrão Nacional)

Mapeamento extraído de uma **NFS-e real autorizada** (DANFSe v2.0, município de MG).
É a fonte de verdade para o `dps-builder` da Fase 2: confira contra este documento antes
de confiar na documentação.

> Identificação de emitente e tomador foi omitida — este repositório é público. Ficou
> registrado apenas o que descreve a **estrutura** do documento e as **regras de cálculo**.

## Cabeçalho

| Campo do DANFSe | Valor observado | Onde vive no sistema |
|---|---|---|
| Município | do emitente | `emitente.codigo_municipio` (IBGE, 7 dígitos) |
| Ambiente Gerador | 2 (Sistema Nacional NFS-e) | fixo — emitimos pela SEFIN Nacional |
| Tipo de Ambiente | 1 = Produção · 2 = Produção Restrita | `nota.ambiente` |
| Chave de acesso | 50 dígitos | `nota.chave_acesso CHAR(50)` |
| Número da NFS-e | atribuído pela SEFIN | `nota.numero_nfse` |
| Número / Série da DPS | nossos, enviados na DPS | `nota.numero_dps` / `nota.serie` |
| Situação | "NFS-e Gerada" | `nota.status = autorizada` |

### Série da DPS — por que a nossa é 1

A nota real de referência saiu com **série 70000**, que é a faixa do Emissor Nacional (portal
web). A emissão por **webservice** usa a faixa **1–49999**, e por isso o sistema fica na série
`1` com numeração própria começando em 1.

| Faixa | Emissor |
|---|---|
| 00001–49999 | webservice ← este sistema |
| 50000–69999 | emissor mobile |
| 70000–79999 | Portal Nacional ← as notas emitidas manualmente |
| 80000–89999 | Portal Nacional com transcrição manual |

As duas sequências são independentes: **dá para emitir pelos dois caminhos em paralelo** durante
a transição, sem colisão de numeração.

## Prestador

| Campo | Observação |
|---|---|
| CNPJ · Nome empresarial | `EMITENTE_CNPJ` · `EMITENTE_RAZAO_SOCIAL` |
| Indicador Municipal (Inscrição) | **veio vazio numa nota autorizada** — confirma que a IM não é exigida quando o município opera no Portal Nacional |
| Município / IBGE | `EMITENTE_CODIGO_MUNICIPIO` |
| Endereço · E-mail · Telefone | demais `EMITENTE_*` |
| Simples Nacional na Data de Competência | Não optante → `optante_simples_nacional = 0` |
| Regime de Apuração pelo SN | vazio quando não é optante |

## Tomador

Os campos que a DPS carrega — todos já existem na tabela `tomador`:
CNPJ/CPF, nome empresarial, indicador municipal, **município + código IBGE**, UF, CEP,
endereço (logradouro, número, bairro), e-mail e telefone.

> **O código IBGE do tomador é obrigatório** e tem 7 dígitos. A BrasilAPI devolve o código
> **SIAFI**, que é diferente — por isso `normalizar()` em `services/brasilapi.js` deixa
> `codigo_municipio` como `null` de propósito. A conversão nome/UF → IBGE entra na Fase 2.

Os grupos **Destinatário** e **Intermediário da operação** aparecem como "não identificado" —
são opcionais e não vamos preencher.

## Serviço

| Campo | Valor |
|---|---|
| Código de Tributação Nacional | formatado `01.05.01` no DANFSe, `010501` no XML |
| Código de Tributação Municipal | vazio |
| Código NBS | vazio |
| Local da Prestação | município do emitente |
| Descrição do código | texto oficial do item da lista de serviços |
| **Descrição do Serviço** | nome do plano contratado |

A descrição do serviço é **por nota** e identifica o plano contratado — não é um texto fixo.
Na Fase 4 ela virá da descrição do line item da fatura da Stripe, e é gravada em
`nota.descricao_servico`. O texto do código fica em `servico.descricao`.

## Tributação municipal (ISSQN)

| Campo | Valor |
|---|---|
| Tipo de Tributação do ISSQN | Operação Tributável |
| BC ISSQN | valor da operação (sem deduções) |
| Alíquota Aplicada | 2,00 % |
| Retenção do ISSQN | Não Retido |
| Município de Incidência | município do emitente |

## Tributação federal (exceto CBS)

| Campo | Valor |
|---|---|
| PIS — Débito Apuração Própria | 0,65 % sobre o valor da operação |
| COFINS — Débito Apuração Própria | 3,00 % sobre o valor da operação |
| IRRF · Contribuição Previdenciária · Contribuições Sociais Retidas | vazios |
| Descrição Contrib. Sociais Retidas | **0 - PIS/COFINS/CSLL Não Retidos** → `tipo_retencao_pis_cofins = 0` |

O rótulo "Débito Apuração Própria" confirma a separação que o modelo já faz: `aliquota_pis` e
`aliquota_cofins` são da **operação**, e `ret_*` são **retenção**. Trocar um pelo outro emitiria
nota com retenção indevida.

## Tributação IBS/CBS

Todos os campos de valor vieram vazios — a reforma ainda não incide. O único preenchido:

| Campo | Valor |
|---|---|
| Exclusões e Reduções da Base de Cálculo | ISS + PIS + COFINS |

Calculado em `apurarTributos().exclusoesBaseIbsCbs`, pronto para quando o grupo IBS/CBS entrar.

## Totais

| Campo | Regra |
|---|---|
| Valor da Operação / Serviço | `nota.valor_servico` |
| Descontos incondicionado / condicionado | não usados |
| Total das Retenções | zero na configuração atual |
| Valor Líquido da NFS-e | igual ao valor da operação, já que nada é retido |

## Primeira emissão autorizada

Produção Restrita, 06/08/2026 — DPS série 1 nº 1, NFS-e nº 1, R$ 1,00, tomador MEI.
Chave de acesso com 50 dígitos, conforme `TSChaveNFSe`.

O caminho completo está provado: mTLS com certificado A1 → XML no schema v1.01 →
assinatura **RSA-SHA256** com canonicalização exclusiva → GZip+Base64 → SEFIN → NFS-e
autorizada de forma síncrona. O suporte a SHA1 continua no código, mas não é necessário.

## DANFSe

A API que gerava o DANFSe foi **desligada em 1º de julho de 2026**. A NT SE/CGSN 008/2026
transferiu a geração para os sistemas emissores e tornou o layout um **padrão nacional
obrigatório**, com prazo de adaptação até 3 de agosto de 2026.

### A grade vem do anexo da NT

O anexo da NT traz uma tabela **"Posição c/ relação à margem"** com 114 campos: para cada um,
altura, largura, distância da esquerda e do topo em centímetros, o caminho no XML e a máscara
de formatação. É dela que sai toda a geometria de `danfse.js` — as constantes em centímetros
não são escolha de estilo.

| Medida | Valor |
|---|---|
| Página | A4 retrato, margem 0,30 cm, largura útil 20,40 cm |
| Colunas | 0,30 / 5,41 / 10,51 / 15,62 cm, largura 5,09 (ou 10,19 quando ocupa duas) |
| Altura de linha | 0,63 cm nos blocos de pessoa e tributação; 0,67 cm nos dados e totais |
| Cabeçalho | 1,16 cm de altura, a partir de 0,30 |
| Chave de acesso | 0,77 × 15,30 cm em 0,30 / 1,48 |
| QR Code | 1,52 × 1,52 cm em 17,48 / 1,67 |
| Complemento do QR | 0,68 × 4,72 cm em 15,80 / 3,36 |
| Canhoto | 0,67 cm de altura, em posição fixa a 28,10 cm do topo |

Ordem dos blocos, também do anexo: cabeçalho → dados da NFS-e → prestador → tomador →
destinatário → intermediário → serviço prestado → tributação municipal → tributação federal →
tributação IBS/CBS → valor total → informações complementares → canhoto.

Detalhes que a tabela impõe e são fáceis de errar:

- **descrições por extenso, nunca o código**: `tpEmit=1` imprime "Prestador", não "1";
- **texto cortado com reticências**, não quebrado em duas linhas — daí o campo elástico ser
  só o de informações complementares;
- **destinatário e intermediário ausentes** viram a faixa "NÃO IDENTIFICADO NA NFS-e", não um
  bloco de traços;
- **campos concatenados**: "Município / Sigla UF", "Código IBGE / CEP", "CST / cClassTrib";
- o **município do cabeçalho não é exibido** quando o código de tributação nacional é 99;
- o bloco **IBS/CBS é impresso mesmo vazio** — o layout é fixo, e um ERP espera as células
  naquela posição.

### Demais regras

| Regra | Onde |
|---|---|
| QR Code de 1,52 cm × 1,52 cm | `QR_LADO` em `danfse.js` |
| Fonte Arial/MS Sans Serif, mínimo 7pt | Helvetica (métrica equivalente); valores em 8,5pt |
| Paridade XML–PDF | dados lidos do XML autorizado, nunca do banco |
| Marca d'água em documento cancelado ou substituído | `marcaDagua()` |

O estado de cancelamento **não** vem do XML: o `cStat` da NFS-e nunca muda para cancelada.
Ele é passado por fora, a partir do status da nota.

Uma tensão real, registrada: vários rótulos do próprio anexo não cabem em 7pt na coluna de
5,09 cm que o anexo lhes dá — "Base de Cálculo Após Exclusões e Reduções", por exemplo. O
gerador encolhe o **rótulo** até 6pt para caber numa linha; os **valores** ficam sempre em
8,5pt. O DANFSe emitido pela própria SEFIN faz o mesmo. Se o mínimo de 7pt for lido como
valendo também para rótulos, esse é o ponto a rever.

O layout foi conferido campo a campo contra um DANFSe v2.0 real emitido pela SEFIN. Ainda
assim, vale a validação de um contador antes de tratá-lo como definitivo.

## Rejeições encontradas na Produção Restrita

Regras que o XSD não expressa e que só aparecem no envio real. Cada uma virou teste.

| Código | Regra | Como o builder trata |
|---|---|---|
| `E0121` | Nome/razão social do **prestador** não pode ser informado quando o emitente da DPS é o próprio prestador (`tpEmit=1`) | `xNome` omitido do grupo `prest` |
| `E0128` | Endereço nacional do **prestador** não pode ser informado, pelo mesmo motivo | grupo `end` omitido do `prest` |
| `E0617` | `pAliq` **não** pode ser informado quando o prestador é não optante do Simples **e** o convênio do município está ativo | alíquota omitida do `tribMun` |
| `E0619` | `pAliq` **é obrigatório** se o convênio do município **não** estiver ativo | `emitente.convenio_municipio_ativo = 0` volta a enviar a alíquota |
| `E0713` | `indTotTrib` e `pTotTribSN` nunca podem ser informados para não optante do Simples | `totTrib` usa `vTotTrib` com os valores apurados |

As duas são a mesma regra em campos diferentes: **com `tpEmit=1` a SEFIN não aceita dado
cadastral do prestador**, porque usa o cadastro dela. O builder envia do `prest` apenas o que
identifica fiscalmente — CNPJ, inscrição municipal e o `regTrib`, que é obrigatório. Telefone
e e-mail também ficam de fora, por precaução baseada no mesmo padrão.

O grupo `prest` resultante:

```xml
<prest><CNPJ>…</CNPJ><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>
```

Nada disso empobrece o documento: o DANFSe segue mostrando nome, endereço, telefone e e-mail
do prestador — preenchidos pela SEFIN. A regra vale só para o prestador; o **tomador** continua
levando nome e endereço no XML.

Confirmado no mesmo envio: **assinatura RSA-SHA256 com canonicalização exclusiva é aceita** —
a rejeição veio da camada de negócio, depois da validação de assinatura. O suporte a SHA1
continua no código como alternativa, mas não é necessário.

### De onde vieram

Depois das duas primeiras rejeições, as demais foram encontradas **antes de enviar**, lendo o
anexo de leiaute oficial (`anexo_i-sefin_adn-dps_nfse`), que traz 429 regras com código de erro.
As 224 que tocam campos emitidos por este sistema estão em `docs/regras-sefin.json`.

Vale consultar esse arquivo antes de mexer no builder — muita regra é condicional e depende de
Simples Nacional, convênio do município e tipo de tributação.

O corpo da rejeição vem assim, e é o que o `errors.js` desmonta:

```json
{"tipoAmbiente":2,"versaoAplicativo":"SefinNacional_1.6.0",
 "idDPS":"DPS...","erros":[{"Codigo":"E0121","Descricao":"..."}]}
```

## Competência

`dCompet` é **data civil**, não instante. O MySQL devolve `DATE` como string com `dateStrings`,
e converter para `Date` antes de aplicar fuso desloca o dia: `new Date('2026-09-01')` é meia-noite
UTC, e −3h joga para 31/08 — competência no mês anterior.

Bug real, encontrado conferindo uma nota de produção que saiu com competência 06/08 tendo sido
emitida em 07/08. Corrigido em `xml.js`: string no formato `AAAA-MM-DD` volta intacta.

## Conferência numérica

Os valores da nota real viraram teste de regressão em `server/tests/calculo.test.js`:

| Tributo | Cálculo | DANFSe |
|---|---|---|
| ISS | 148,83 × 2 % = 2,9766 | **R$ 2,98** |
| PIS | 148,83 × 0,65 % = 0,9674 | **R$ 0,97** |
| COFINS | 148,83 × 3 % = 4,4649 | **R$ 4,46** |
| Exclusões IBS/CBS | soma dos três | **R$ 8,41** |

Arredondamento comercial em 2 casas, meio-para-cima.
