/**
 * Configuração do pm2.
 *
 * `.cjs` de propósito: o package.json declara "type": "module", e o pm2 lê o
 * arquivo de configuração como CommonJS.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'nfse-emissor',
      script: 'server/index.js',
      cwd: __dirname,

      // Uma instância basta: o volume é de algumas notas por dia, e emissão
      // fiscal não ganha nada com paralelismo. A alocação do número da DPS usa
      // SELECT ... FOR UPDATE, então mais instâncias seriam seguras — mas não
      // há motivo para complicar.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      // Espaço entre reinícios: se o banco cair, evita loop de restart.
      restart_delay: 5000,
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'production',
      },

      // O .env é lido pelo dotenv a partir do cwd; não repetir segredos aqui.
      error_file: 'logs/erro.log',
      out_file: 'logs/saida.log',
      merge_logs: true,
      time: true,
    },
  ],
};
