import { migrate } from './migrate.js';
import { pool } from './pool.js';

const DICAS = {
  ER_BAD_DB_ERROR: (db) =>
    `A database "${db}" não existe. O migrate cria as tabelas, não a database.\n\n` +
    `  mysql -u root -p -e "CREATE DATABASE \\\`${db}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"\n\n` +
    'Se o MySQL roda em container, prefixe com: docker exec -i <container> ',
  ER_ACCESS_DENIED_ERROR: () =>
    'Usuário ou senha recusados. Confira DB_USER e DB_PASS no .env.',
  ECONNREFUSED: () =>
    'Nada escutando em DB_HOST:DB_PORT. O MySQL está no ar? Se for container, a porta está publicada?',
  ENOTFOUND: () => 'DB_HOST não resolve. Confira o nome do host no .env.',
};

try {
  await migrate();
  console.log('Migrações aplicadas.');
} catch (e) {
  const dica = DICAS[e.code]?.(process.env.DB_NAME);
  console.error(`✗ Migração não aplicada: ${e.sqlMessage ?? e.message}`);
  if (dica) console.error(`\n${dica}`);
  else console.error(e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
