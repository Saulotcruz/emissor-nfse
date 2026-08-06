#!/usr/bin/env node
/**
 * Confere o certificado A1 sem tocar na rede e sem emitir nada.
 *
 *   npm run cert
 *
 * Lê NFSE_CERT_PATH e NFSE_CERT_PASSWORD do .env (ou do ambiente, que tem
 * precedência). Serve como primeiro teste depois de instalar o .pfx no servidor.
 */
import fs from 'node:fs';
import dotenv from 'dotenv';
import { lerCertificado, diasParaVencer } from '../server/services/nfse/signer.js';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const caminho = process.env.NFSE_CERT_PATH;
const senha = process.env.NFSE_CERT_PASSWORD;

function sair(mensagem) {
  console.error(`✗ ${mensagem}`);
  process.exit(1);
}

if (!caminho) sair('NFSE_CERT_PATH não definido (.env ou variável de ambiente)');
if (!senha) sair('NFSE_CERT_PASSWORD não definido');
if (!fs.existsSync(caminho)) sair(`Arquivo não encontrado: ${caminho}`);

const stat = fs.statSync(caminho);
let cert;
try {
  cert = lerCertificado({ caminho, senha });
} catch (e) {
  sair(e.message);
}

const dias = diasParaVencer(cert);
const fmt = (d) => d.toISOString().slice(0, 10);

console.log(`Arquivo      ${caminho} (${stat.size} bytes)`);
console.log(`Titular      ${cert.titular ?? '(sem CN)'}`);
console.log(`Válido       ${fmt(cert.validoDe)} até ${fmt(cert.validoAte)}`);
console.log(`Fingerprint  ${cert.fingerprint.slice(0, 32)}…`);

// Permissão frouxa em chave privada é achado de segurança, não detalhe.
const modo = (stat.mode & 0o777).toString(8).padStart(3, '0');
if (stat.mode & 0o077) {
  console.log(`Permissão    ${modo}  ⚠ legível por outros usuários — use chmod 600`);
} else {
  console.log(`Permissão    ${modo}  ok`);
}

if (dias < 0) {
  console.error(`\n✗ Certificado VENCIDO há ${Math.abs(dias)} dias. A emissão vai falhar.`);
  process.exit(1);
}
if (dias <= 30) {
  console.warn(`\n⚠ Vence em ${dias} dias. Providencie a renovação.`);
} else {
  console.log(`\n✓ Certificado válido, vence em ${dias} dias.`);
}
