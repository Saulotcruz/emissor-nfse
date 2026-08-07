import express from 'express';
import 'express-async-errors'; // faz erros de rotas async caírem no error handler (Express 4)
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { pool } from './db/pool.js';
import { cabecalhosDeSeguranca, mesmaOrigem } from './middleware/seguranca.js';
import { limitador } from './middleware/limite.js';
import authRoutes from './routes/auth.js';
import mfaRoutes from './routes/mfa.js';
import auditoriaRoutes from './routes/auditoria.js';
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

/**
 * Segura as rotas de nota que custam caro: emissão, cancelamento, sincronização
 * e geração de DANFSe. Leitura da lista passa livre pelo teto geral.
 *
 * Não é só custo de CPU — reemitir em laço vira sequência de números de DPS
 * queimados na SEFIN, que não se recupera.
 */
const limiteOperacoesCaras = (() => {
  const limitar = limitador({ maximo: 30, janelaMs: 5 * 60_000, nome: 'notas-caras' });
  const CARAS = /^\/(sincronizar|\d+\/(reemitir|cancelar|danfse))$/;
  return (req, res, next) =>
    CARAS.test(req.path) ? limitar(req, res, next) : next();
})();

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by'); // não anunciar a stack para quem varre
  app.use(cabecalhosDeSeguranca);

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
  // Vale para todo /api, inclusive o webhook — que passa porque a Stripe não
  // manda Origin, e quem a autentica é a assinatura HMAC.
  app.use('/api', mesmaOrigem);

  // Teto geral: generoso para o uso normal do painel, mas impede que uma
  // sessão válida (ou um IP qualquer) rode a API em laço.
  app.use('/api', limitador({ maximo: 600, janelaMs: 5 * 60_000, nome: 'api' }));

  app.use('/api', authRoutes);
  app.use('/api/mfa', mfaRoutes);
  app.use('/api/auditoria', auditoriaRoutes);
  app.use('/api/tomadores', tomadoresRoutes);
  // Operações que falam com a SEFIN ou geram PDF custam muito mais que uma
  // listagem — e o teto geral é largo demais para segurá-las.
  app.use('/api/notas', limiteOperacoesCaras, notasRoutes);
  app.use('/api/config', configRoutes);
  // Sem sessão: quem autentica aqui é a assinatura da Stripe.
  app.use('/api/stripe', limitador({ maximo: 300, janelaMs: 60_000, nome: 'stripe' }), stripeRoutes);

  // A assinatura de 4 argumentos é o que faz o Express reconhecer isto como error handler.
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  });
  return app;
}
