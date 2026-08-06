#!/usr/bin/env node
/**
 * Cadastra um tomador buscando os dados na BrasilAPI.
 *
 *   npm run tomador -- --cnpj 19131243000197
 *   npm run tomador -- --cnpj 19131243000197 --ibge 3550308 --email nf@cliente.com
 *
 * Opções:
 *   --cnpj    CNPJ do tomador (obrigatório)
 *   --ibge    código IBGE do município (7 dígitos) — ver observação abaixo
 *   --email   e-mail para receber a nota
 *   --nome    sobrescreve a razão social vinda da BrasilAPI
 *
 * Sobre o --ibge: a BrasilAPI devolve o código SIAFI do município, e a DPS exige
 * o IBGE. Sem ele, o endereço do tomador NÃO vai na nota — o que é válido pelo
 * schema, já que o grupo é opcional. Informe se quiser o endereço no documento.
 */
import dotenv from 'dotenv';
import { pool } from '../server/db/pool.js';
import { apenasDigitos, tipoDocumento } from '../server/services/documento.js';
import { consultarCnpj, CnpjNaoEncontradoError } from '../server/services/brasilapi.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}

async function main() {
  const cnpj = apenasDigitos(args.cnpj);
  if (!cnpj) {
    console.error('Informe --cnpj <CNPJ>.');
    console.error('Ex.: npm run tomador -- --cnpj 19131243000197');
    process.exitCode = 1;
    return;
  }
  if (tipoDocumento(cnpj) !== 'cnpj') {
    console.error(`✗ CNPJ inválido: ${args.cnpj}`);
    process.exitCode = 1;
    return;
  }

  const [[existente]] = await pool.query('SELECT * FROM tomador WHERE documento = ?', [cnpj]);
  if (existente) {
    console.log(`Tomador já cadastrado: #${existente.id} — ${existente.razao_social}`);
    return;
  }

  let dados;
  try {
    dados = await consultarCnpj(cnpj);
  } catch (e) {
    if (e instanceof CnpjNaoEncontradoError) console.error(`✗ ${e.message}`);
    else console.error(`✗ Falha ao consultar a BrasilAPI: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const registro = {
    tipo_doc: 'cnpj',
    documento: dados.documento,
    razao_social: args.nome ?? dados.razao_social,
    nome_fantasia: dados.nome_fantasia,
    email: args.email ?? dados.email,
    telefone: dados.telefone,
    logradouro: dados.logradouro,
    numero: dados.numero,
    complemento: dados.complemento,
    bairro: dados.bairro,
    cep: dados.cep,
    codigo_municipio: args.ibge ? apenasDigitos(args.ibge) : null,
    uf: dados.uf,
    origem: 'manual',
  };

  if (registro.codigo_municipio && registro.codigo_municipio.length !== 7) {
    console.error(`✗ --ibge deve ter 7 dígitos: ${args.ibge}`);
    process.exitCode = 1;
    return;
  }

  const cols = Object.keys(registro);
  const [r] = await pool.query(
    `INSERT INTO tomador (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => registro[c])
  );

  console.log(`✓ Tomador #${r.insertId} cadastrado`);
  console.log(`  ${registro.razao_social} (${registro.documento})`);
  console.log(`  ${registro.logradouro ?? '—'}, ${registro.numero ?? '—'} — ${dados.municipio_nome ?? '—'}/${registro.uf ?? '—'}`);
  if (!registro.codigo_municipio) {
    console.log('\n  ⚠ Sem código IBGE do município: o endereço NÃO irá na nota.');
    console.log(`    Para incluir, rode de novo com --ibge <código> ou atualize depois.`);
  }
}

try {
  await main();
} finally {
  await pool.end();
}
