import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/**
 * Listagem para o painel. A emissão, reemissão e cancelamento entram nas
 * Fases 3 e 6, quando o módulo services/nfse/ existir.
 */
router.get('/', async (req, res) => {
  const { status, tomador_id: tomadorId, de, ate } = req.query;
  const where = [];
  const params = [];
  if (status) {
    where.push('n.status = ?');
    params.push(status);
  }
  if (tomadorId) {
    where.push('n.tomador_id = ?');
    params.push(tomadorId);
  }
  if (de) {
    where.push('n.competencia >= ?');
    params.push(de);
  }
  if (ate) {
    where.push('n.competencia <= ?');
    params.push(ate);
  }

  const [rows] = await pool.query(
    `SELECT n.id, n.serie, n.numero_dps, n.id_dps, n.status, n.chave_acesso, n.numero_nfse,
            n.competencia, n.valor_servico, n.origem, n.stripe_invoice_id,
            n.erro_codigo, n.erro_mensagem, n.autorizada_em, n.created_at,
            t.razao_social AS tomador_razao_social, t.documento AS tomador_documento
       FROM nota n
       JOIN tomador t ON t.id = n.tomador_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY n.id DESC
      LIMIT 500`,
    params
  );
  res.json({ notas: rows });
});

router.get('/:id', async (req, res) => {
  const [[nota]] = await pool.query(
    `SELECT n.*, t.razao_social AS tomador_razao_social, t.documento AS tomador_documento
       FROM nota n JOIN tomador t ON t.id = n.tomador_id
      WHERE n.id = ?`,
    [req.params.id]
  );
  if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });

  const [eventos] = await pool.query(
    'SELECT id, tipo, motivo, status, erro_mensagem, created_at FROM nota_evento WHERE nota_id = ? ORDER BY id',
    [req.params.id]
  );
  res.json({ nota, eventos });
});

router.get('/:id/xml', async (req, res) => {
  const [[nota]] = await pool.query(
    'SELECT serie, numero_dps, nfse_xml, dps_xml FROM nota WHERE id = ?',
    [req.params.id]
  );
  if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });

  const xml = nota.nfse_xml ?? nota.dps_xml;
  if (!xml) return res.status(404).json({ error: 'Nota ainda não possui XML' });

  res.type('application/xml');
  res.attachment(`nfse-${nota.serie}-${nota.numero_dps}.xml`);
  res.send(xml);
});

export default router;
