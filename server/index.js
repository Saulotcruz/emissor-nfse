import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';

await migrate();
const app = createApp();

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const port = process.env.PORT || 3100;
app.listen(port, () => {
  const ambiente = process.env.NFSE_AMBIENTE || 'producao-restrita';
  console.log(`Emissor NFS-e ouvindo na porta ${port} (ambiente fiscal: ${ambiente})`);
});
