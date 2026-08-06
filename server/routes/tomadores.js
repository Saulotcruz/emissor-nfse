import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { apenasDigitos, tipoDocumento } from '../services/documento.js';
import { consultarCnpj, CnpjNaoEncontradoError } from '../services/brasilapi.js';

const router = Router();
router.use(requireAuth);

const CAMPOS = [
  'tipo_doc', 'documento', 'razao_social', 'nome_fantasia', 'inscricao_municipal',
  'email', 'telefone', 'logradouro', 'numero', 'complemento', 'bairro',
  'cep', 'codigo_municipio', 'uf', 'stripe_customer_id', 'origem', 'ativo',
];

router.get('/', async (req, res) => {
  const { busca = '', ativo } = req.query;
  const where = [];
  const params = [];
  if (busca) {
    where.push('(razao_social LIKE ? OR documento LIKE ?)');
    params.push(`%${busca}%`, `%${apenasDigitos(busca) || busca}%`);
  }
  if (ativo === '0' || ativo === '1') {
    where.push('ativo = ?');
    params.push(Number(ativo));
  }
  const sql = `SELECT * FROM tomador ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY razao_social LIMIT 500`;
  const [rows] = await pool.query(sql, params);
  res.json({ tomadores: rows });
});

router.get('/:id', async (req, res) => {
  const [[tomador]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [req.params.id]);
  if (!tomador) return res.status(404).json({ error: 'Tomador não encontrado' });
  res.json({ tomador });
});

/**
 * Consulta um CNPJ na BrasilAPI sem gravar nada — alimenta o botão
 * "buscar por CNPJ" do formulário de cadastro no painel.
 */
router.get('/consulta/:cnpj', async (req, res) => {
  try {
    res.json({ dados: await consultarCnpj(req.params.cnpj) });
  } catch (e) {
    if (e instanceof CnpjNaoEncontradoError) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const dados = montarPayload(req.body ?? {}, { origem: 'manual' });
  const erro = validar(dados);
  if (erro) return res.status(400).json({ error: erro });

  const [[existente]] = await pool.query('SELECT id FROM tomador WHERE documento = ?', [dados.documento]);
  if (existente) {
    return res.status(409).json({ error: 'Já existe um tomador com este documento', id: existente.id });
  }

  const cols = CAMPOS.filter((c) => dados[c] !== undefined);
  const [r] = await pool.query(
    `INSERT INTO tomador (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => dados[c])
  );
  const [[tomador]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [r.insertId]);
  res.status(201).json({ tomador });
});

router.put('/:id', async (req, res) => {
  const [[atual]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [req.params.id]);
  if (!atual) return res.status(404).json({ error: 'Tomador não encontrado' });

  const dados = montarPayload(req.body ?? {}, { origem: atual.origem });
  const erro = validar(dados);
  if (erro) return res.status(400).json({ error: erro });

  const cols = CAMPOS.filter((c) => dados[c] !== undefined);
  await pool.query(
    `UPDATE tomador SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => dados[c]), req.params.id]
  );
  const [[tomador]] = await pool.query('SELECT * FROM tomador WHERE id = ?', [req.params.id]);
  res.json({ tomador });
});

// Inativa em vez de apagar: notas emitidas referenciam o tomador.
router.delete('/:id', async (req, res) => {
  const [r] = await pool.query('UPDATE tomador SET ativo = 0 WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Tomador não encontrado' });
  res.json({ ok: true });
});

function montarPayload(body, { origem }) {
  const documento = apenasDigitos(body.documento);
  const dados = { ...body, documento, origem: body.origem ?? origem };
  if (documento) dados.tipo_doc = tipoDocumento(documento) ?? body.tipo_doc;
  if (dados.cep) dados.cep = apenasDigitos(dados.cep);
  if (dados.telefone) dados.telefone = apenasDigitos(dados.telefone);
  return dados;
}

function validar(dados) {
  if (!dados.documento) return 'Documento é obrigatório';
  if (!tipoDocumento(dados.documento)) return 'CNPJ ou CPF inválido';
  if (!dados.razao_social) return 'Razão social é obrigatória';
  return null;
}

export default router;
