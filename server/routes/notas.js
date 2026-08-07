import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { emitirNota, cancelarNota, sincronizarNotas } from '../services/nfse/client.js';
import { SefinError } from '../services/nfse/errors.js';

const router = Router();
router.use(requireAuth);

/**
 * Listagem para o painel. A emissão, reemissão e cancelamento entram nas
 * Fases 3 e 6, quando o módulo services/nfse/ existir.
 */
router.get('/', async (req, res) => {
  const { status, ambiente, tomador_id: tomadorId, de, ate } = req.query;
  const where = [];
  const params = [];
  if (status) {
    where.push('n.status = ?');
    params.push(status);
  }
  if (ambiente) {
    where.push('n.ambiente = ?');
    params.push(ambiente);
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
            n.competencia, n.valor_servico, n.origem, n.ambiente, n.stripe_invoice_id,
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

/**
 * Pergunta à SEFIN se alguma nota foi cancelada fora do sistema.
 * Precisa vir antes de `/:id/...` para o Express não tratar "sincronizar"
 * como um id.
 */
router.post('/sincronizar', async (_req, res) => {
  try {
    const resultados = await sincronizarNotas();
    res.json({
      conferidas: resultados.length,
      mudadas: resultados.filter((r) => r.mudou),
      erros: resultados.filter((r) => r.erro),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Reemite uma nota que ficou em `erro` ou `pendente`.
 * Reaproveita o mesmo número de DPS, e o client consulta a SEFIN pelo idDPS
 * antes de reenviar — então clicar duas vezes não gera nota duplicada.
 */
router.post('/:id/reemitir', async (req, res) => {
  try {
    const r = await emitirNota(Number(req.params.id));
    res.json({ ok: true, jaAutorizada: r.jaAutorizada, chaveAcesso: r.chaveAcesso, nota: r.nota });
  } catch (e) {
    res.status(e instanceof SefinError ? 422 : 400).json({
      error: e.message,
      codigo: e.codigo ?? null,
      retentavel: e.retentavel ?? false,
    });
  }
});

router.post('/:id/cancelar', async (req, res) => {
  const { motivo, codigoMotivo } = req.body ?? {};
  try {
    const r = await cancelarNota(Number(req.params.id), { motivo, codigoMotivo });
    res.json({ ok: true, jaCancelada: r.jaCancelada, idPedido: r.idPedido ?? null });
  } catch (e) {
    res.status(e instanceof SefinError ? 422 : 400).json({
      error: e.message,
      codigo: e.codigo ?? null,
    });
  }
});

export default router;
