/**
 * Dados fictícios para os testes. Os dados fiscais reais vivem no .env
 * (veja .env.example) e nunca entram no repositório.
 *
 * O CNPJ 11.222.333/0001-81 é inventado, mas tem dígitos verificadores válidos —
 * a validação de documento precisa passar.
 */
export const EMITENTE_FIXTURE = {
  razao_social: 'EMPRESA DE TESTE LTDA',
  nome_fantasia: 'TESTE',
  cnpj: '11222333000181',
  inscricao_municipal: null,
  codigo_municipio: '3106200',
  cnae: '6202300',
  regime_tributario: 'lucro_presumido',
  optante_simples_nacional: 0,
  regime_especial: null,
  logradouro: 'RUA DE TESTE',
  numero: '100',
  complemento: null,
  bairro: 'CENTRO',
  cep: '30000000',
  uf: 'MG',
  email: 'teste@example.com',
  telefone: '3130000000',
  convenio_municipio_ativo: 1,
  serie_dps: '1',
  ambiente: 'producao_restrita',
};

/**
 * Tributação equivalente à de um prestador de software no Lucro Presumido:
 * ISS não retido, PIS/COFINS de operação própria, nenhuma retenção federal.
 */
export const SERVICO_FIXTURE = {
  codigo_tributacao_nacional: '010501',
  descricao: 'Licenciamento ou cessão de direito de uso de programas de computação.',
  codigo_nbs: null,
  aliquota_iss: 2,
  iss_retido: 0,
  tipo_tributacao_issqn: 'operacao_tributavel',
  situacao_pis_cofins: 'STANDARD_TAXABLE_OPERATION',
  tipo_retencao_pis_cofins: 0,
  aliquota_pis: 0.65,
  aliquota_cofins: 3,
  ret_pis: 0,
  ret_cofins: 0,
  ret_csll: 0,
  ret_inss: 0,
  ret_ir: 0,
  padrao: 1,
};
