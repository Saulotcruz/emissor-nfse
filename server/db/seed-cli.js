import { migrate } from './migrate.js';
import { seed, emitenteDoAmbiente, servicoDoAmbiente } from './seed.js';
import { pool } from './pool.js';

const adminEmail = process.env.ADMIN_EMAIL;
const adminSenha = process.env.ADMIN_SENHA;

try {
  await migrate();
  const emitente = emitenteDoAmbiente();
  const servico = servicoDoAmbiente();
  await seed({ emitente, servico, adminEmail, adminSenha });

  console.log(`Emitente: ${emitente.razao_social} (${emitente.cnpj})`);
  console.log(`Serviço padrão: ${servico.codigo_tributacao_nacional} — ISS ${servico.aliquota_iss}%`);
  console.log(`Série da DPS: ${emitente.serie_dps} | Ambiente: ${emitente.ambiente}`);
  if (adminEmail) {
    console.log(`Usuário admin garantido: ${adminEmail}`);
  } else {
    console.log('Defina ADMIN_EMAIL e ADMIN_SENHA para criar o usuário admin.');
  }
} catch (e) {
  console.error(`Seed não aplicado: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
