# Virada para produção

## Onde as coisas ficam no servidor

| O quê | Caminho |
|---|---|
| Aplicação | `/var/www/emissor-nfse` |
| Certificado A1 (`.pfx`) | `/opt/nfse/certs/`, com `chmod 600` |
| Processo | pm2, nome `nfse-emissor` |
| Porta | 3100, só no loopback — NAT publica apenas 80 e 443 |

O certificado fica **fora** da pasta da aplicação de propósito: um `git pull` ou um deploy
que limpe o diretório não pode levar junto a chave que assina documento fiscal.

## Subir uma versão nova

```bash
cd /var/www/emissor-nfse && git pull origin master
npm ci --omit=dev && npm run migrate && npm run build:web && pm2 restart nfse-emissor
```

`npm run migrate` é o passo que costuma ser esquecido: sem ele a interface nova aparece e
quebra ao encostar numa coluna que ainda não existe.

---

Passo a passo para sair da Produção Restrita e emitir NFS-e com valor fiscal.

A ordem importa: cada bloco é reversível até o último. Depois de emitir a primeira nota
válida, o caminho de volta é cancelamento, não desfazer.

## Antes de começar

| Verificação | Comando / onde |
|---|---|
| Certificado A1 válido e com folga | `npm run cert` |
| Alertas por e-mail funcionando | `npm run alertas -- --testar` |
| Emissão e cancelamento provados em Produção Restrita | já feito |
| Alíquota e código de serviço batem com o que você emite manualmente | `docs/referencia-nfse.md` |

Se o certificado estiver a menos de 30 dias do vencimento, renove **antes** — trocar
certificado com emissão automática ligada é mais arriscado que trocar antes de ligar.

## 1. Stripe: endpoint de produção

O sandbox e o live mode são ambientes separados, com webhooks e signing secrets próprios.

1. No dashboard da Stripe, **saia do sandbox** (seletor de conta) e vá para o modo de produção.
2. **Webhooks → Add endpoint**, apontando para `https://SEU_HOST/api/stripe/webhook`.
3. Evento: apenas **`invoice.payment_succeeded`**.
4. **Fixe a versão da API** — não deixe em "current version".
5. Copie o signing secret e troque no `.env`:

```
STRIPE_WEBHOOK_SECRET=whsec_...   # o do LIVE, não o do sandbox
```

```bash
pm2 restart nfse-emissor
```

> Enquanto o ambiente fiscal ainda for Produção Restrita, um pagamento real gera nota
> **sem efeito fiscal**. É o melhor ensaio possível: dados verdadeiros, risco zero.
> Vale fazer pelo menos um antes do passo 2.

## 2. Trocar o ambiente fiscal

Mudar `NFSE_AMBIENTE` no `.env` **não basta**: essa variável só é lida pelo `seed`, e o seed
não altera registro existente. O que vale é a coluna `emitente.ambiente`.

```bash
npm run ambiente
```

Mostra ambiente atual, endpoint, série e quantas notas existem. Para virar:

```bash
npm run ambiente -- --producao
```

Pede confirmação digitada (`PRODUCAO`) e lista o que conferir antes.

Sobre a numeração: os números gastos em teste continuam contados. Isso é inofensivo — a
sequência da DPS admite lacunas, e a SEFIN de produção nunca viu aqueles números. Se quiser
começar do 1:

```bash
npm run ambiente -- --producao --reiniciar-numeracao
```

O comando recusa reiniciar se já houver nota emitida em produção, porque geraria DPS duplicada.

Depois:

```bash
pm2 restart nfse-emissor
```

O log deve mostrar `ambiente fiscal: producao`.

## 3. Primeira nota real

Não espere um cliente. Emita você mesmo, com valor simbólico:

```bash
npm run emitir-teste -- --tomador CNPJ_DE_UM_CLIENTE --valor 1.00 --descricao "Emissao de teste"
```

> Não use o CNPJ da própria empresa: prestador e tomador iguais costuma ser rejeitado.

Confira o PDF no Portal Nacional contra uma nota que você emitiu manualmente — tomador,
código de serviço, alíquota de ISS, PIS/COFINS e descrição. Depois cancele:

```bash
npm run cancelar -- --nota N --motivo "Emissao de teste do novo sistema"
```

Prazo e condições de cancelamento são parametrizados pelo município, então faça isso em dia
útil e com folga.

## 4. Ligar de vez

A emissão automática já está ligada: qualquer `invoice.payment_succeeded` no live mode vira
nota. Não há interruptor por cliente.

Se quiser controlar o ritmo, a forma mais simples é começar com poucas assinaturas ativas na
Stripe live e ir aumentando.

## 5. Rotina

```
0 8 * * * cd /var/www/emissor-nfse && /usr/bin/node scripts/verificar-alertas.js >> logs/alertas.log 2>&1
```

O alerta cobre nota rejeitada, nota presa, evento sem nota e vencimento do certificado.

## Voltar atrás

```bash
npm run ambiente -- --producao-restrita
```

Não pede confirmação — voltar para o ambiente de teste é sempre seguro. As notas já emitidas
em produção continuam válidas: quem distingue é a coluna `nota.ambiente`.

## O que fica manual por enquanto

Sem o painel (Fase 5), a operação é por linha de comando e consulta ao banco:

```sql
SELECT id, status, numero_nfse, valor_servico, erro_mensagem
  FROM nota WHERE ambiente = 'producao' ORDER BY id DESC LIMIT 20;
```

O alerta diário cobre o essencial — você só precisa olhar quando ele avisar.
