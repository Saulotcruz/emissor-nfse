#!/usr/bin/env node
/**
 * Cancela uma NFS-e autorizada (evento e101101).
 *
 *   npm run cancelar -- --nota 1 --motivo "Emissao de teste em homologacao"
 *   npm run cancelar -- --chave 3156700225167... --motivo "..." --codigo 2
 *
 * Opções:
 *   --nota    id da nota no banco
 *   --chave   chave de acesso, alternativa ao --nota
 *   --motivo  justificativa (15 a 255 caracteres, exigência do schema)
 *   --codigo  1 = erro na emissão (padrão) | 2 = serviço não prestado | 9 = outros
 *   --dry-run monta e assina o pedido, mostra o XML e NÃO envia
 */
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { apenasDigitos } from '../server/services/documento.js';
import { montarCancelamento, MOTIVO_CANCELAMENTO } from '../server/services/nfse/evento-builder.js';
import { assinarPedidoEvento } from '../server/services/nfse/signer.js';
import { SefinError } from '../server/services/nfse/errors.js';
import { cancelarNota, carregarEmitente, criarClienteSefin } from '../server/services/nfse/client.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = { codigo: MOTIVO_CANCELAMENTO.erro_emissao, dryRun: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dry-run') args.dryRun = true;
  else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}

const ROTULO_MOTIVO = { 1: 'Erro na emissão', 2: 'Serviço não prestado', 9: 'Outros' };

async function acharNota() {
  if (args.nota) {
    const [[n]] = await pool.query('SELECT * FROM nota WHERE id = ?', [Number(args.nota)]);
    return n;
  }
  if (args.chave) {
    const [[n]] = await pool.query('SELECT * FROM nota WHERE chave_acesso = ?', [apenasDigitos(args.chave)]);
    return n;
  }
  return null;
}

async function confirmar(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const r = (await rl.question(`${pergunta} [digite SIM] `)).trim();
  rl.close();
  return r === 'SIM';
}

async function main() {
  if ((!args.nota && !args.chave) || !args.motivo) {
    console.error('Informe --nota <id> (ou --chave <50 dígitos>) e --motivo "<justificativa>".');
    console.error('Ex.: npm run cancelar -- --nota 1 --motivo "Emissao de teste em homologacao"');
    process.exitCode = 1;
    return;
  }

  const nota = await acharNota();
  if (!nota) {
    console.error('✗ Nota não encontrada.');
    process.exitCode = 1;
    return;
  }
  if (nota.status !== 'autorizada') {
    console.error(`✗ Só é possível cancelar nota autorizada. Esta está "${nota.status}".`);
    process.exitCode = 1;
    return;
  }

  const emitente = await carregarEmitente();
  const ehProducao = nota.ambiente === 'producao';

  console.log(`Ambiente     ${ehProducao ? '⚠  PRODUÇÃO (cancelamento vale de verdade)' : 'Produção Restrita (teste)'}`);
  console.log(`Nota         #${nota.id} — NFS-e ${nota.numero_nfse ?? '—'} — R$ ${Number(nota.valor_servico).toFixed(2)}`);
  console.log(`Chave        ${nota.chave_acesso}`);
  console.log(`Motivo       ${args.codigo} — ${ROTULO_MOTIVO[args.codigo] ?? '?'}`);
  console.log(`Justificativa ${args.motivo}\n`);

  if (args.dryRun) {
    const { xml } = montarCancelamento({
      emitente,
      chaveAcesso: nota.chave_acesso,
      motivo: args.motivo,
      codigoMotivo: String(args.codigo),
      ambiente: nota.ambiente,
    });
    const { certificado } = criarClienteSefin(emitente);
    console.log(assinarPedidoEvento(xml, certificado));
    console.log('\n(dry-run: nada foi enviado)');
    return;
  }

  if (ehProducao && !(await confirmar('Isto vai CANCELAR uma nota fiscal válida. Confirma?'))) {
    console.log('Cancelado.');
    return;
  }

  try {
    const r = await cancelarNota(nota.id, { motivo: args.motivo, codigoMotivo: String(args.codigo) });
    if (r.jaCancelada) {
      console.log('A nota já estava cancelada.');
      return;
    }
    console.log('✓ Cancelamento registrado');
    console.log(`  Id do pedido  ${r.idPedido}`);
    if (r.retorno) console.log(`  Retorno       ${JSON.stringify(r.retorno).slice(0, 400)}`);
  } catch (e) {
    console.error(`\n✗ Cancelamento recusado: ${e.message}`);
    if (e instanceof SefinError) {
      console.error(`  tipo   ${e.name}`);
      if (e.status) console.error(`  HTTP   ${e.status}`);
      if (e.codigo) console.error(`  código ${e.codigo}`);
      if (e.corpo) console.error(`  corpo  ${JSON.stringify(e.corpo).slice(0, 800)}`);
      console.error('\n  Prazo, valor limite e exigência de tomador identificado são');
      console.error('  parametrizados pelo município (E0822, E0823, E0824) — a recusa');
      console.error('  pode ser legítima mesmo com o XML correto.');
    }
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await pool.end();
}
