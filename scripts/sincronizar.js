#!/usr/bin/env node
/**
 * Confere na SEFIN se alguma nota foi cancelada fora do sistema.
 *
 *   npm run sincronizar               # autorizadas dos últimos 90 dias
 *   npm run sincronizar -- --dias 365 # janela maior
 *   npm run sincronizar -- --dias 0   # sem janela: confere todas
 *   npm run sincronizar -- --nota 3   # só uma
 *
 * Cancelar pelo Portal Nacional não avisa este sistema, e o XML da nota também
 * não denuncia: o `cStat` só distingue tipos de NFS-e gerada e nunca muda para
 * cancelada. O cancelamento é um evento separado, e é o que se consulta aqui.
 *
 * Isto NÃO tem relação com numeração: o número da DPS é consumido na emissão e
 * cancelar não o devolve. O que se corrige é o sistema afirmar que uma nota
 * está válida quando ela não está mais.
 */
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { sincronizarNota, sincronizarNotas } from '../server/services/nfse/client.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}

try {
  if (args.nota) {
    const r = await sincronizarNota(Number(args.nota));
    console.log(r.mudou ? `✓ Nota #${args.nota} marcada como ${r.novoStatus}` : `Nota #${args.nota}: sem mudança (${r.motivo ?? `${r.eventos} evento(s)`})`);
  } else {
    const dias = args.dias === undefined ? 90 : Number(args.dias);
    const resultados = await sincronizarNotas({ dias });
    const mudadas = resultados.filter((r) => r.mudou);
    const erros = resultados.filter((r) => r.erro);

    console.log(
      `${resultados.length} nota(s) conferida(s)` +
        (dias > 0 ? ` (autorizadas nos últimos ${dias} dias).` : ' (todas).')
    );
    for (const r of mudadas) console.log(`  ✓ #${r.id} → ${r.novoStatus}`);
    for (const r of erros) console.error(`  ✗ #${r.id}: ${r.erro}`);
    if (!mudadas.length && !erros.length) console.log('  Nenhuma divergência.');
    if (erros.length) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
