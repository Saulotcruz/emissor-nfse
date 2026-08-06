CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  senha_hash VARCHAR(100) NOT NULL,
  papel ENUM('admin','operador') NOT NULL DEFAULT 'operador',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dados fiscais do prestador. Linha única (id=1).
-- proximo_numero_dps é o contador da série: alocado com SELECT ... FOR UPDATE.
CREATE TABLE emitente (
  id INT AUTO_INCREMENT PRIMARY KEY,
  razao_social VARCHAR(190) NOT NULL,
  nome_fantasia VARCHAR(190) NULL,
  cnpj CHAR(14) NOT NULL,
  inscricao_municipal VARCHAR(20) NULL,
  codigo_municipio CHAR(7) NOT NULL COMMENT 'Codigo IBGE de 7 digitos',
  cnae CHAR(7) NULL,
  regime_tributario ENUM('simples_nacional','lucro_presumido','lucro_real') NOT NULL DEFAULT 'lucro_presumido',
  optante_simples_nacional TINYINT(1) NOT NULL DEFAULT 0,
  regime_especial VARCHAR(40) NULL,
  logradouro VARCHAR(190) NULL,
  numero VARCHAR(20) NULL,
  complemento VARCHAR(100) NULL,
  bairro VARCHAR(100) NULL,
  cep CHAR(8) NULL,
  uf CHAR(2) NULL,
  email VARCHAR(190) NULL,
  telefone VARCHAR(20) NULL,
  serie_dps VARCHAR(5) NOT NULL DEFAULT '1' COMMENT 'Faixa 1-49999 = emissao via webservice',
  proximo_numero_dps BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ambiente ENUM('producao_restrita','producao') NOT NULL DEFAULT 'producao_restrita',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emitente_cnpj (cnpj)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Metadados do certificado A1. A SENHA NAO FICA AQUI: vem de NFSE_CERT_PASSWORD (.env).
-- Esta tabela existe para o painel avisar do vencimento antes que a emissao pare.
CREATE TABLE certificado (
  id INT AUTO_INCREMENT PRIMARY KEY,
  caminho VARCHAR(255) NOT NULL,
  titular VARCHAR(190) NULL,
  fingerprint VARCHAR(95) NULL,
  valido_de DATE NULL,
  valido_ate DATE NULL,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  verificado_em TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tomador (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tipo_doc ENUM('cnpj','cpf') NOT NULL DEFAULT 'cnpj',
  documento VARCHAR(14) NOT NULL,
  razao_social VARCHAR(190) NOT NULL,
  nome_fantasia VARCHAR(190) NULL,
  inscricao_municipal VARCHAR(20) NULL,
  email VARCHAR(190) NULL,
  telefone VARCHAR(20) NULL,
  logradouro VARCHAR(190) NULL,
  numero VARCHAR(20) NULL,
  complemento VARCHAR(100) NULL,
  bairro VARCHAR(100) NULL,
  cep CHAR(8) NULL,
  codigo_municipio CHAR(7) NULL,
  uf CHAR(2) NULL,
  stripe_customer_id VARCHAR(64) NULL,
  origem ENUM('manual','stripe') NOT NULL DEFAULT 'manual',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tomador_documento (documento),
  UNIQUE KEY uq_tomador_stripe (stripe_customer_id),
  KEY idx_tomador_razao (razao_social)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE servico (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo_tributacao_nacional VARCHAR(10) NOT NULL COMMENT 'Ex: 010501',
  descricao VARCHAR(190) NOT NULL,
  codigo_nbs VARCHAR(20) NULL,
  aliquota_iss DECIMAL(7,5) NOT NULL DEFAULT 0,
  iss_retido TINYINT(1) NOT NULL DEFAULT 0,
  tipo_tributacao_issqn VARCHAR(40) NOT NULL DEFAULT 'operacao_tributavel' COMMENT 'DANFSe: Tipo de Tributacao do ISSQN',
  situacao_pis_cofins VARCHAR(40) NOT NULL DEFAULT 'STANDARD_TAXABLE_OPERATION',
  tipo_retencao_pis_cofins TINYINT NOT NULL DEFAULT 0 COMMENT '0 = PIS/COFINS/CSLL Nao Retidos',
  aliquota_pis DECIMAL(7,5) NOT NULL DEFAULT 0,
  aliquota_cofins DECIMAL(7,5) NOT NULL DEFAULT 0,
  ret_pis DECIMAL(7,5) NOT NULL DEFAULT 0,
  ret_cofins DECIMAL(7,5) NOT NULL DEFAULT 0,
  ret_csll DECIMAL(7,5) NOT NULL DEFAULT 0,
  ret_inss DECIMAL(7,5) NOT NULL DEFAULT 0,
  ret_ir DECIMAL(7,5) NOT NULL DEFAULT 0,
  padrao TINYINT(1) NOT NULL DEFAULT 0,
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- stripe_invoice_id UNIQUE e a garantia de idempotencia: a Stripe reenvia webhooks,
-- e o indice unico impede que um reenvio gere uma segunda nota.
-- Numa retentativa o mesmo numero_dps e reaproveitado, o que torna id_dps deterministico.
CREATE TABLE nota (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tomador_id INT NOT NULL,
  servico_id INT NOT NULL,
  stripe_invoice_id VARCHAR(64) NULL,
  stripe_subscription_id VARCHAR(64) NULL,
  origem ENUM('stripe','manual') NOT NULL DEFAULT 'stripe',
  serie VARCHAR(5) NOT NULL,
  numero_dps BIGINT UNSIGNED NOT NULL,
  id_dps VARCHAR(60) NOT NULL,
  competencia DATE NOT NULL,
  valor_servico DECIMAL(15,2) NOT NULL,
  descricao_servico TEXT NOT NULL,
  municipio_incidencia_iss CHAR(7) NULL COMMENT 'IBGE do local de prestacao',
  bc_issqn DECIMAL(15,2) NULL,
  valor_iss DECIMAL(15,2) NULL,
  valor_pis DECIMAL(15,2) NULL,
  valor_cofins DECIMAL(15,2) NULL,
  ambiente ENUM('producao_restrita','producao') NOT NULL DEFAULT 'producao_restrita',
  data_emissao_dps DATETIME NULL,
  status ENUM('pendente','enviando','autorizada','erro','cancelada') NOT NULL DEFAULT 'pendente',
  chave_acesso CHAR(50) NULL,
  numero_nfse VARCHAR(20) NULL,
  dps_xml MEDIUMTEXT NULL,
  nfse_xml MEDIUMTEXT NULL,
  erro_codigo VARCHAR(20) NULL,
  erro_mensagem TEXT NULL,
  tentativas INT NOT NULL DEFAULT 0,
  autorizada_em TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nota_stripe_invoice (stripe_invoice_id),
  UNIQUE KEY uq_nota_serie_numero (serie, numero_dps),
  UNIQUE KEY uq_nota_chave (chave_acesso),
  KEY idx_nota_status (status),
  KEY idx_nota_competencia (competencia),
  CONSTRAINT fk_nota_tomador FOREIGN KEY (tomador_id) REFERENCES tomador(id),
  CONSTRAINT fk_nota_servico FOREIGN KEY (servico_id) REFERENCES servico(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE nota_evento (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nota_id INT NOT NULL,
  tipo VARCHAR(20) NOT NULL COMMENT 'Ex: e101101 (cancelamento)',
  motivo VARCHAR(255) NULL,
  status ENUM('pendente','aceito','rejeitado') NOT NULL DEFAULT 'pendente',
  evento_xml MEDIUMTEXT NULL,
  retorno_xml MEDIUMTEXT NULL,
  erro_mensagem TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_evento_nota (nota_id),
  CONSTRAINT fk_evento_nota FOREIGN KEY (nota_id) REFERENCES nota(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Trilha bruta dos webhooks da Stripe: permite reprocessar sem depender de reenvio.
CREATE TABLE stripe_evento (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stripe_event_id VARCHAR(64) NOT NULL,
  tipo VARCHAR(60) NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  processado_em TIMESTAMP NULL,
  erro_mensagem TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stripe_evento (stripe_event_id),
  KEY idx_stripe_evento_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
