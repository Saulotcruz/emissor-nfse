import bcrypt from 'bcryptjs';
import request from 'supertest';
import { pool } from '../../db/pool.js';
import { migrate } from '../../db/migrate.js';
import { seed } from '../../db/seed.js';
import { EMITENTE_FIXTURE, SERVICO_FIXTURE } from '../fixtures/emitente.js';

// Ordem importa: filhos antes dos pais, mesmo com FOREIGN_KEY_CHECKS=0 desligado.
const TABLES = ['nota_evento', 'nota', 'stripe_evento', 'tomador', 'servico', 'certificado', 'emitente', 'users'];

export async function resetDb({ comSeed = true } = {}) {
  await migrate();
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of TABLES) await pool.query(`TRUNCATE TABLE ${t}`);
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  if (comSeed) await seed({ emitente: EMITENTE_FIXTURE, servico: SERVICO_FIXTURE });
}

export async function createUser({
  nome = 'Admin Teste',
  email = 'admin@test.local',
  senha = 'secret123',
  papel = 'admin',
} = {}) {
  const hash = await bcrypt.hash(senha, 4);
  const [r] = await pool.query(
    'INSERT INTO users (nome, email, senha_hash, papel) VALUES (?, ?, ?, ?)',
    [nome, email, hash, papel]
  );
  return { id: r.insertId, nome, email, senha, papel };
}

export async function loginAgent(app, user) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ email: user.email, senha: user.senha });
  if (res.status !== 200) throw new Error(`login falhou no teste: ${res.status}`);
  return agent;
}

export async function createTomador(dados = {}) {
  const base = {
    tipo_doc: 'cnpj',
    documento: '19131243000197',
    razao_social: 'OPEN KNOWLEDGE BRASIL',
    origem: 'manual',
    ...dados,
  };
  const cols = Object.keys(base);
  const [r] = await pool.query(
    `INSERT INTO tomador (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => base[c])
  );
  return { id: r.insertId, ...base };
}
