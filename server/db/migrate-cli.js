import { migrate } from './migrate.js';
import { pool } from './pool.js';

await migrate();
console.log('Migrações aplicadas.');
await pool.end();
