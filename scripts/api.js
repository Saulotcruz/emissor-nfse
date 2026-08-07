#!/usr/bin/env node
/**
 * Consulta crua da API da SEFIN, usando o certificado configurado.
 *
 *   npm run api -- /SefinNacional/nfse/{chave}/eventos/101101
 *   npm run api -- --ambiente producao /SefinNacional/nfse/{chave}
 *   npm run api -- --metodo HEAD /SefinNacional/dps/{idDps}
 *   npm run api -- --host adn /contribuintes/DFe/0
 *
 * Existe porque a documentação da SEFIN diverge da API em pontos que só
 * aparecem no uso — o GET de eventos sem o tipo, por exemplo, responde 405.
 * Com isto dá para verificar o contrato em vez de deduzir.
 */
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { carregarEmitente, criarClienteSefin } from '../server/services/nfse/client.js';
import { SefinError } from '../server/services/nfse/errors.js';
import { baseUrlDoAmbiente } from '../server/services/nfse/transport.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const argv = process.argv.slice(2);
const opts = {};
const soltos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
  else soltos.push(argv[i]);
}
const caminho = soltos[0];

try {
  if (!caminho) {
    console.error('Informe o caminho. Ex.: npm run api -- /SefinNacional/nfse/CHAVE/eventos/101101');
    process.exitCode = 1;
  } else {
    const emitente = await carregarEmitente();
    const ambiente = opts.ambiente ?? emitente.ambiente;
    const { client } = criarClienteSefin(emitente, { ambiente });
    // O ADN é outro host: as consultas de eventos e a distribuição vivem lá.
    if (opts.host === 'adn') client.baseUrl = baseUrlDoAmbiente(ambiente, 'adn');

    console.log(`${opts.metodo ?? 'GET'} ${client.baseUrl}${caminho}  (${ambiente})\n`);
    const r = await client.requisitar(opts.metodo ?? 'GET', caminho, null, { aceitar404: true });
    console.log(`HTTP ${r.status}`);
    console.log(typeof r.corpo === 'string' ? r.corpo.slice(0, 4000) : JSON.stringify(r.corpo, null, 2)?.slice(0, 4000));
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (e instanceof SefinError) {
    if (e.status) console.error(`  HTTP ${e.status}`);
    if (e.corpo) console.error(`  ${JSON.stringify(e.corpo).slice(0, 1500)}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
