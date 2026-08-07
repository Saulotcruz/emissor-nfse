import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { registrar, ACOES } from '../services/auditoria.js';

const router = Router();
router.use(requireAuth);

const CAMPOS_EMITENTE = [
  'razao_social', 'nome_fantasia', 'inscricao_municipal', 'codigo_municipio', 'cnae',
  'regime_tributario', 'regime_especial', 'logradouro', 'numero', 'complemento',
  'bairro', 'cep', 'uf', 'email', 'telefone', 'serie_dps', 'ambiente',
];

const CAMPOS_SERVICO = [
  'codigo_tributacao_nacional', 'descricao', 'codigo_nbs', 'aliquota_iss', 'iss_retido',
  'situacao_pis_cofins', 'aliquota_pis', 'aliquota_cofins',
  'ret_pis', 'ret_cofins', 'ret_csll', 'ret_inss', 'ret_ir', 'padrao', 'ativo',
];

router.get('/emitente', async (_req, res) => {
  const [[emitente]] = await pool.query('SELECT * FROM emitente ORDER BY id LIMIT 1');
  if (!emitente) return res.status(404).json({ error: 'Emitente não configurado. Rode npm run seed.' });
  res.json({ emitente });
});

// O CNPJ não é editável: trocar de CNPJ é outra empresa, não uma edição de cadastro.
// A série também fica de fora — mudar série no meio da operação quebra a numeração.
router.put('/emitente', requireAdmin, async (req, res) => {
  const [[emitente]] = await pool.query('SELECT id FROM emitente ORDER BY id LIMIT 1');
  if (!emitente) return res.status(404).json({ error: 'Emitente não configurado' });

  const body = req.body ?? {};
  const cols = CAMPOS_EMITENTE.filter((c) => body[c] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nada para atualizar' });

  await pool.query(
    `UPDATE emitente SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => body[c]), emitente.id]
  );
  const [[atualizado]] = await pool.query('SELECT * FROM emitente WHERE id = ?', [emitente.id]);
  await registrar(req, {
    acao: ACOES.EMITENTE_ALTERADO,
    entidade: 'emitente',
    entidadeId: emitente.id,
    detalhe: { campos: cols },
  });
  res.json({ emitente: atualizado });
});

router.get('/servicos', async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM servico ORDER BY padrao DESC, descricao');
  res.json({ servicos: rows });
});

router.post('/servicos', requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  if (!body.codigo_tributacao_nacional) {
    return res.status(400).json({ error: 'Código de tributação nacional é obrigatório' });
  }
  if (!body.descricao) return res.status(400).json({ error: 'Descrição é obrigatória' });

  const cols = CAMPOS_SERVICO.filter((c) => body[c] !== undefined);
  const [r] = await pool.query(
    `INSERT INTO servico (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => body[c])
  );
  const [[servico]] = await pool.query('SELECT * FROM servico WHERE id = ?', [r.insertId]);
  await registrar(req, {
    acao: ACOES.SERVICO_CRIADO,
    entidade: 'servico',
    entidadeId: servico.id,
    detalhe: { codigo: servico.codigo_tributacao_nacional, descricao: servico.descricao },
  });
  res.status(201).json({ servico });
});

router.put('/servicos/:id', requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const cols = CAMPOS_SERVICO.filter((c) => body[c] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nada para atualizar' });

  const [r] = await pool.query(
    `UPDATE servico SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => body[c]), req.params.id]
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'Serviço não encontrado' });
  const [[servico]] = await pool.query('SELECT * FROM servico WHERE id = ?', [req.params.id]);
  // Alíquota alterada muda o imposto de toda nota futura: é o registro mais
  // importante desta trilha depois dos de nota.
  await registrar(req, {
    acao: ACOES.SERVICO_ALTERADO,
    entidade: 'servico',
    entidadeId: req.params.id,
    detalhe: { campos: cols, valores: Object.fromEntries(cols.map((c) => [c, body[c]])) },
  });
  res.json({ servico });
});

/**
 * Situação do certificado A1. A senha nunca sai daqui — vem de NFSE_CERT_PASSWORD.
 * A leitura real do .pfx (validade, titular) entra na Fase 2, junto do signer.
 */
router.get('/certificado', async (_req, res) => {
  const [[cert]] = await pool.query(
    'SELECT id, caminho, titular, fingerprint, valido_de, valido_ate, ativo, verificado_em FROM certificado WHERE ativo = 1 ORDER BY id DESC LIMIT 1'
  );
  const caminhoEnv = process.env.NFSE_CERT_PATH || null;
  const diasParaVencer = cert?.valido_ate
    ? Math.ceil((new Date(cert.valido_ate) - new Date()) / 86400000)
    : null;
  res.json({
    certificado: cert ?? null,
    caminho_configurado: caminhoEnv,
    senha_configurada: Boolean(process.env.NFSE_CERT_PASSWORD),
    dias_para_vencer: diasParaVencer,
  });
});

export default router;
