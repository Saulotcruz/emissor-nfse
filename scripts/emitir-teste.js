#!/usr/bin/env node
/**
 * Emite uma NFS-e de teste, do começo ao fim, sem depender da Stripe nem do painel.
 *
 *   npm run emitir-teste -- --tomador 51675482000110 --valor 1.00 --descricao "Teste"
 *
 * Opções:
 *   --tomador   CNPJ/CPF ou id do tomador (obrigatório)
 *   --valor     valor do serviço (padrão: 1.00)
 *   --descricao descrição do serviço na nota
 *   --sha1      assina com RSA-SHA1 em vez de SHA-256
 *   --dry-run   monta e assina, mostra o XML e NÃO envia
 *
 * O ambiente (Produção Restrita ou Produção) vem de `emitente.ambiente` — o
 * script mostra qual é e pede confirmação antes de emitir valendo.
 */
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { apenasDigitos } from '../server/services/documento.js';
import { montarDps } from '../server/services/nfse/dps-builder.js';
import { assinarDps } from '../server/services/nfse/signer.js';
import { SefinError } from '../server/services/nfse/errors.js';
import {
  carregarEmitente,
  carregarServicoPadrao,
  reservarNota,
  emitirNota,
  criarClienteSefin,
} from '../server/services/nfse/client.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = analisarArgumentos(process.argv.slice(2));

function analisarArgumentos(argv) {
  const out = { valor: '1.00', descricao: 'Emissão de teste', sha1: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha1') out.sha1 = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--tomador') out.tomador = argv[++i];
    else if (a === '--valor') out.valor = argv[++i];
    else if (a === '--descricao') out.descricao = argv[++i];
  }
  return out;
}

async function acharTomador(referencia) {
  const doc = apenasDigitos(referencia);
  if (doc.length >= 11) {
    const [[t]] = await pool.query('SELECT * FROM tomador WHERE documento = ?', [doc]);
    return t;
  }
  const [[t]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [Number(referencia)]);
  return t;
}

async function confirmar(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const r = (await rl.question(`${pergunta} [digite SIM] `)).trim();
  rl.close();
  return r === 'SIM';
}

async function main() {
  if (!args.tomador) {
    console.error('Informe --tomador <CNPJ|CPF|id>.');
    console.error('Ex.: npm run emitir-teste -- --tomador 19131243000197 --valor 1.00');
    process.exitCode = 1;
    return;
  }

  const emitente = await carregarEmitente();
  const servico = await carregarServicoPadrao();
  const tomador = await acharTomador(args.tomador);

  if (!tomador) {
    console.error(`Tomador não encontrado: ${args.tomador}`);
    console.error('Cadastre pelo painel ou pela API antes de emitir.');
    process.exitCode = 1;
    return;
  }

  const ehProducao = emitente.ambiente === 'producao';
  console.log(`Ambiente     ${ehProducao ? '⚠  PRODUÇÃO (vale de verdade)' : 'Produção Restrita (teste)'}`);
  console.log(`Emitente     ${emitente.razao_social} (${emitente.cnpj})`);
  console.log(`Tomador      ${tomador.razao_social} (${tomador.documento})`);
  console.log(`Serviço      ${servico.codigo_tributacao_nacional} — ISS ${Number(servico.aliquota_iss)}%`);
  console.log(`Valor        R$ ${Number(args.valor).toFixed(2)}`);
  console.log(`Descrição    ${args.descricao}`);
  console.log(`Assinatura   ${args.sha1 ? 'RSA-SHA1' : 'RSA-SHA256'}`);
  console.log(`Série/nº     ${emitente.serie_dps} / ${emitente.proximo_numero_dps}\n`);

  if (args.dryRun) {
    const { xml } = montarDps({
      emitente,
      tomador,
      servico,
      nota: {
        numeroDps: Number(emitente.proximo_numero_dps),
        serie: emitente.serie_dps,
        valorServico: Number(args.valor),
        descricaoServico: args.descricao,
        ambiente: emitente.ambiente,
      },
    });
    const { certificado } = criarClienteSefin(emitente);
    console.log(assinarDps(xml, certificado, { algoritmo: args.sha1 ? 'sha1' : 'sha256' }));
    console.log('\n(dry-run: nada foi enviado e nenhum número de DPS foi consumido)');
    return;
  }

  if (ehProducao && !(await confirmar('Isto vai emitir uma nota fiscal VÁLIDA. Confirma?'))) {
    console.log('Cancelado.');
    return;
  }

  const reserva = await reservarNota({
    tomadorId: tomador.id,
    servicoId: servico.id,
    valorServico: Number(args.valor),
    descricaoServico: args.descricao,
    origem: 'manual',
  });
  console.log(`Nota #${reserva.id} reservada — DPS ${reserva.serie}/${reserva.numeroDps}`);
  console.log(`idDPS ${reserva.idDps}\n`);

  try {
    const r = await emitirNota(reserva.id, { algoritmo: args.sha1 ? 'sha1' : 'sha256' });
    console.log('✓ NFS-e autorizada');
    console.log(`  Chave de acesso  ${r.chaveAcesso}`);
    if (r.numeroNfse) console.log(`  Número da NFS-e  ${r.numeroNfse}`);
    console.log(`\nXML salvo na nota #${reserva.id} (npm run cert não é afetado).`);
  } catch (e) {
    console.error(`\n✗ Falha na emissão: ${e.message}`);
    if (e instanceof SefinError) {
      console.error(`  tipo       ${e.name}`);
      console.error(`  retentável ${e.retentavel ? 'sim' : 'não'}`);
      if (e.status) console.error(`  HTTP       ${e.status}`);
      if (e.codigo) console.error(`  código     ${e.codigo}`);
      if (e.corpo) console.error(`  corpo      ${JSON.stringify(e.corpo).slice(0, 800)}`);
      if (/assinat|signature|digest/i.test(e.message) && !args.sha1) {
        console.error('\n  Se o motivo for assinatura, tente de novo com --sha1.');
      }
    }
    console.error(`\nA nota #${reserva.id} ficou registrada com o erro. O número da DPS`);
    console.error('continua reservado, então a retentativa reaproveita o mesmo idDPS.');
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await pool.end();
}
