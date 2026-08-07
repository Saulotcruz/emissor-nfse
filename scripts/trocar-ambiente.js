#!/usr/bin/env node
/**
 * Troca o ambiente fiscal do emitente.
 *
 *   npm run ambiente                        # mostra a situação atual
 *   npm run ambiente -- --producao          # passa a emitir NOTA VÁLIDA
 *   npm run ambiente -- --producao-restrita # volta para o ambiente de teste
 *   npm run ambiente -- --producao --reiniciar-numeracao
 *
 * A variável NFSE_AMBIENTE do .env só é lida pelo `seed`, e o seed não altera
 * registro existente — quem manda de verdade é a coluna `emitente.ambiente`.
 * Este comando é o único jeito de mudá-la fora do painel.
 */
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { carregarEmitente } from '../server/services/nfse/client.js';
import { baseUrlDoAmbiente } from '../server/services/nfse/transport.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = new Set(process.argv.slice(2));
const paraProducao = args.has('--producao');
const paraRestrita = args.has('--producao-restrita');
const reiniciarNumeracao = args.has('--reiniciar-numeracao');

const ROTULO = {
  producao: '⚠  PRODUÇÃO — as notas valem de verdade',
  producao_restrita: 'Produção Restrita — teste, sem efeito fiscal',
};

async function contarNotas(ambiente) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'autorizada') AS autorizadas
       FROM nota WHERE ambiente = ?`,
    [ambiente]
  );
  return { total: Number(r.total), autorizadas: Number(r.autorizadas ?? 0) };
}

async function confirmar(pergunta, esperado = 'SIM') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const r = (await rl.question(`${pergunta} [digite ${esperado}] `)).trim();
  rl.close();
  return r === esperado;
}

async function main() {
  const emitente = await carregarEmitente();

  if (paraProducao && paraRestrita) {
    console.error('Escolha um: --producao ou --producao-restrita.');
    process.exitCode = 1;
    return;
  }

  const destino = paraProducao ? 'producao' : paraRestrita ? 'producao_restrita' : null;

  console.log(`Emitente     ${emitente.razao_social} (${emitente.cnpj})`);
  console.log(`Ambiente     ${ROTULO[emitente.ambiente]}`);
  console.log(`Endpoint     ${baseUrlDoAmbiente(emitente.ambiente)}`);
  console.log(`Série / nº   ${emitente.serie_dps} / próximo ${emitente.proximo_numero_dps}`);

  const atual = await contarNotas(emitente.ambiente);
  console.log(`Notas        ${atual.total} neste ambiente (${atual.autorizadas} autorizadas)\n`);

  if (!destino) {
    console.log('Nada alterado. Use --producao ou --producao-restrita para trocar.');
    return;
  }
  if (destino === emitente.ambiente) {
    console.log(`Já está em ${ROTULO[destino]}. Nada a fazer.`);
    return;
  }

  console.log(`Trocar para  ${ROTULO[destino]}`);
  console.log(`Novo endpoint ${baseUrlDoAmbiente(destino)}\n`);

  if (destino === 'producao') {
    const emProducao = await contarNotas('producao');
    console.log('Antes de confirmar, verifique:');
    console.log('  • o certificado A1 é o mesmo usado no Portal Nacional (npm run cert)');
    console.log('  • o webhook da Stripe aponta para o LIVE mode e o STRIPE_WEBHOOK_SECRET foi trocado');
    console.log('  • a alíquota e o código de serviço conferem com o que você emite manualmente');
    console.log('  • os alertas por e-mail estão funcionando (npm run alertas -- --testar)\n');

    if (reiniciarNumeracao) {
      if (emProducao.total > 0) {
        console.error(
          `✗ Já existem ${emProducao.total} nota(s) em produção. Reiniciar a numeração ` +
            'geraria DPS duplicada e a SEFIN rejeitaria. Rode sem --reiniciar-numeracao.'
        );
        process.exitCode = 1;
        return;
      }
      console.log(`A numeração da DPS voltará de ${emitente.proximo_numero_dps} para 1.\n`);
    } else {
      console.log(
        `A numeração da DPS seguirá de ${emitente.proximo_numero_dps} — os números gastos em\n` +
          'teste ficam como lacuna, o que é inofensivo. Use --reiniciar-numeracao para começar em 1.\n'
      );
    }

    if (!(await confirmar('Isto fará o sistema emitir NOTAS FISCAIS VÁLIDAS. Confirma?', 'PRODUCAO'))) {
      console.log('Cancelado.');
      return;
    }
  }

  const campos = ['ambiente = ?'];
  const valores = [destino];
  if (destino === 'producao' && reiniciarNumeracao) {
    campos.push('proximo_numero_dps = 1');
  }
  valores.push(emitente.id);

  await pool.query(`UPDATE emitente SET ${campos.join(', ')} WHERE id = ?`, valores);

  const atualizado = await carregarEmitente();
  console.log(`\n✓ Ambiente agora é ${ROTULO[atualizado.ambiente]}`);
  console.log(`  Próxima DPS: série ${atualizado.serie_dps} nº ${atualizado.proximo_numero_dps}`);
  console.log('\nReinicie o serviço para o log refletir a mudança: pm2 restart nfse-emissor');
}

try {
  await main();
} finally {
  await pool.end();
}
