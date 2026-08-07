import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { listar, ACOES } from '../services/auditoria.js';

const router = Router();

/**
 * Consulta da trilha.
 *
 * Só admin: a trilha mostra de onde cada pessoa entrou e o que fez, e não é
 * informação que todo operador precise ver.
 *
 * Existe só GET aqui, de propósito — a trilha é append-only. Não há rota que
 * altere ou apague linha, nem deve haver.
 */
router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  const { acao, entidade, entidade_id: entidadeId, de, ate, limite, offset } = req.query;
  res.json(await listar({ acao, entidade, entidadeId, de, ate, limite, offset }));
});

/** Para o filtro do painel não precisar repetir a lista de ações. */
router.get('/acoes', (_req, res) => res.json({ acoes: Object.values(ACOES).sort() }));

export default router;
