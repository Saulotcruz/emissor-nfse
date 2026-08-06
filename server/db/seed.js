import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { apenasDigitos } from '../services/documento.js';

/**
 * Dados do emitente e do serviço padrão vêm do ambiente, não do código:
 * este repositório é público e os dados fiscais são de quem opera o sistema.
 * Veja .env.example para a lista completa.
 */
export function emitenteDoAmbiente(env = process.env) {
  const obrigatorios = ['EMITENTE_CNPJ', 'EMITENTE_RAZAO_SOCIAL', 'EMITENTE_CODIGO_MUNICIPIO'];
  const faltando = obrigatorios.filter((k) => !env[k]);
  if (faltando.length) {
    throw new Error(`Configure no .env antes de rodar o seed: ${faltando.join(', ')}`);
  }

  return {
    razao_social: env.EMITENTE_RAZAO_SOCIAL,
    nome_fantasia: env.EMITENTE_NOME_FANTASIA || null,
    cnpj: apenasDigitos(env.EMITENTE_CNPJ),
    inscricao_municipal: env.EMITENTE_INSCRICAO_MUNICIPAL || null,
    codigo_municipio: env.EMITENTE_CODIGO_MUNICIPIO,
    cnae: env.EMITENTE_CNAE || null,
    regime_tributario: env.EMITENTE_REGIME_TRIBUTARIO || 'lucro_presumido',
    optante_simples_nacional: env.EMITENTE_OPTANTE_SIMPLES === '1' ? 1 : 0,
    regime_especial: env.EMITENTE_REGIME_ESPECIAL || null,
    logradouro: env.EMITENTE_LOGRADOURO || null,
    numero: env.EMITENTE_NUMERO || null,
    complemento: env.EMITENTE_COMPLEMENTO || null,
    bairro: env.EMITENTE_BAIRRO || null,
    cep: apenasDigitos(env.EMITENTE_CEP) || null,
    uf: env.EMITENTE_UF || null,
    email: env.EMITENTE_EMAIL || null,
    telefone: apenasDigitos(env.EMITENTE_TELEFONE) || null,
    // Faixa 1-49999 é a reservada para emissão via webservice.
    serie_dps: env.EMITENTE_SERIE_DPS || '1',
    ambiente: env.NFSE_AMBIENTE === 'producao' ? 'producao' : 'producao_restrita',
  };
}

export function servicoDoAmbiente(env = process.env) {
  if (!env.SERVICO_CODIGO || !env.SERVICO_DESCRICAO) {
    throw new Error('Configure SERVICO_CODIGO e SERVICO_DESCRICAO no .env antes de rodar o seed');
  }

  return {
    codigo_tributacao_nacional: env.SERVICO_CODIGO,
    descricao: env.SERVICO_DESCRICAO,
    codigo_nbs: env.SERVICO_NBS || null,
    aliquota_iss: Number(env.SERVICO_ALIQUOTA_ISS || 0),
    iss_retido: env.SERVICO_ISS_RETIDO === '1' ? 1 : 0,
    tipo_tributacao_issqn: env.SERVICO_TIPO_TRIBUTACAO_ISSQN || 'operacao_tributavel',
    situacao_pis_cofins: env.SERVICO_SITUACAO_PIS_COFINS || 'STANDARD_TAXABLE_OPERATION',
    tipo_retencao_pis_cofins: Number(env.SERVICO_TIPO_RETENCAO_PIS_COFINS || 0),
    // Alíquotas da operação própria — NÃO são retenção.
    aliquota_pis: Number(env.SERVICO_ALIQUOTA_PIS || 0),
    aliquota_cofins: Number(env.SERVICO_ALIQUOTA_COFINS || 0),
    ret_pis: Number(env.SERVICO_RET_PIS || 0),
    ret_cofins: Number(env.SERVICO_RET_COFINS || 0),
    ret_csll: Number(env.SERVICO_RET_CSLL || 0),
    ret_inss: Number(env.SERVICO_RET_INSS || 0),
    ret_ir: Number(env.SERVICO_RET_IR || 0),
    padrao: 1,
  };
}

/**
 * Cria emitente, serviço padrão e (opcionalmente) o usuário admin.
 * Idempotente: rodar de novo não duplica nada.
 *
 * Os testes passam `emitente` e `servico` explicitamente, para não dependerem
 * do .env da máquina.
 */
export async function seed({ emitente, servico, adminEmail, adminSenha } = {}) {
  const dadosEmitente = emitente ?? emitenteDoAmbiente();
  const dadosServico = servico ?? servicoDoAmbiente();

  await inserirSeAusente('emitente', dadosEmitente, 'cnpj');
  await inserirSeAusente('servico', dadosServico, 'codigo_tributacao_nacional');

  if (adminEmail && adminSenha) {
    const [[user]] = await pool.query('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!user) {
      const hash = await bcrypt.hash(adminSenha, 10);
      await pool.query(
        'INSERT INTO users (nome, email, senha_hash, papel) VALUES (?, ?, ?, ?)',
        [adminEmail.split('@')[0], adminEmail, hash, 'admin']
      );
    }
  }
}

async function inserirSeAusente(tabela, dados, chave) {
  const [[existente]] = await pool.query(
    `SELECT id FROM ${tabela} WHERE ${chave} = ?`,
    [dados[chave]]
  );
  if (existente) return existente.id;

  const cols = Object.keys(dados);
  const [r] = await pool.query(
    `INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => dados[c])
  );
  return r.insertId;
}
