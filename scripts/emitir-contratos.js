import 'dotenv/config';
import { pool } from '../server/db/pool.js';
import { emitirDoDia, competenciasPendentes } from '../server/services/contratos/emissao.js';
import { hojeLocal } from '../server/services/contratos/calendario.js';
import { explicar } from '../server/db/erros.js';

/**
 * Emissão dos contratos recorrentes. É o que a cron chama.
 *
 *   npm run contratos                    emite o que vence hoje
 *   npm run contratos -- --simular       mostra o que faria, sem emitir
 *   npm run contratos -- --data 2026-08-21   finge outra data (teste)
 *
 * Rodar várias vezes ao dia é seguro: o índice único (contrato_id,
 * competencia_ref) impede segunda nota na mesma competência.
 */

const args = process.argv.slice(2);
const valor = (nome) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const simular = args.includes('--simular');
const hoje = valor('data') ?? hojeLocal();

try {
  if (simular) console.log('MODO SIMULAÇÃO — nada será emitido\n');
  console.log(`Data de referência: ${hoje}\n`);

  const resultados = await emitirDoDia({ hoje, simular });

  if (!resultados.length) {
    console.log('Nenhum contrato a emitir hoje.');
  } else {
    for (const r of resultados) {
      const marca = { emitida: 'OK  ', ja_emitida: '=   ', erro: 'FALHA', simulado: 'SIM ' }[r.status];
      console.log(
        `${marca} contrato ${r.contratoId} · competência ${r.competenciaRef}` +
          (r.chaveAcesso ? ` · chave ${r.chaveAcesso}` : '') +
          (r.erro ? ` · ${r.erro}` : '')
      );
    }
  }

  // Mês inteiro perdido não é emitido sozinho: uma nota que faltou se resolve à
  // mão, mas uma nota inesperada de competência passada já é documento fiscal.
  const pendentes = await competenciasPendentes({ hoje });
  if (pendentes.length) {
    console.log(`\nATENÇÃO — ${pendentes.length} competência(s) passada(s) sem nota:`);
    for (const p of pendentes) {
      console.log(`  contrato ${p.contratoId} · ${p.competenciaRef} (previsto para ${p.dataEmissao})`);
    }
    console.log('\nEmita pelo painel se for o caso. A emissão automática só cobre o mês corrente.');
  }

  const falhas = resultados.filter((r) => r.status === 'erro').length;
  await pool.end();
  // Código de saída diferente de zero para a cron conseguir alertar.
  process.exit(falhas ? 1 : 0);
} catch (e) {
  console.error(`Falha ao emitir contratos: ${explicar(e)}`);
  await pool.end();
  process.exit(1);
}
