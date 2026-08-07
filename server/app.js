import express from 'express';
import 'express-async-errors'; // faz erros de rotas async caírem no error handler (Express 4)
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { pool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import tomadoresRoutes from './routes/tomadores.js';
import notasRoutes from './routes/notas.js';
import configRoutes from './routes/config.js';
import stripeRoutes from './routes/stripe.js';

/**
 * Em produção, um SESSION_SECRET fraco é o mesmo que não ter autenticação:
 * quem souber o segredo forja um cookie de sessão e emite nota em nome da
 * empresa. Falhar ao subir é melhor que rodar meses com 'dev-secret'.
 */
function segredoDeSessao() {
  const segredo = process.env.SESSION_SECRET;
  const producao = process.env.NODE_ENV === 'production';

  if (producao) {
    if (!segredo || segredo === 'dev-secret') {
      throw new Error('SESSION_SECRET não configurado. Gere um: openssl rand -hex 32');
    }
    if (segredo.length < 32) {
      throw new Error('SESSION_SECRET curto demais (mínimo 32 caracteres)');
    }
  }
  return segredo || 'dev-secret';
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // O webhook da Stripe precisa do corpo RAW para conferir a assinatura: a
  // Stripe assina os bytes exatos, e reserializar o JSON invalidaria a conferência.
  app.use('/api/stripe/webhook', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));

  const isTest = process.env.NODE_ENV === 'test';
  const MySQLStore = MySQLStoreFactory(session);
  app.use(
    session({
      secret: segredoDeSessao(),
      name: 'nfse.sid',
      resave: false,
      saveUninitialized: false,
      store: isTest ? undefined : new MySQLStore({ createDatabaseTable: true }, pool.pool),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // Em produção o cookie só viaja por HTTPS, a menos que se desligue de
        // propósito. Esquecer COOKIE_SECURE=1 atrás do nginx exporia a sessão.
        secure: process.env.COOKIE_SECURE === '0'
          ? false
          : process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 12,
      },
    })
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', authRoutes);
  app.use('/api/tomadores', tomadoresRoutes);
  app.use('/api/notas', notasRoutes);
  app.use('/api/config', configRoutes);
  // Sem sessão: quem autentica aqui é a assinatura da Stripe.
  app.use('/api/stripe', stripeRoutes);

  // A assinatura de 4 argumentos é o que faz o Express reconhecer isto como error handler.
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  });
  return app;
}
