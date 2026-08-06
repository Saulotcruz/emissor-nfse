import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

// Nota: pool.pool (pool callback interno do mysql2/promise) é usado pelo
// express-mysql-session em server/app.js, que espera a API de callbacks.
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  charset: 'utf8mb4',
});

/**
 * Executa fn dentro de uma transação. Usado na alocação do número da DPS,
 * onde o SELECT ... FOR UPDATE precisa da mesma conexão do UPDATE seguinte.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
