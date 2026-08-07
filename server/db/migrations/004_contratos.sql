-- Contratos de serviço recorrente: emissão por calendário, sem depender de
-- pagamento. Convive com a Stripe — um mesmo cliente pode ter assinatura do
-- SaaS (nota pela Stripe) e contrato de suporte (nota por aqui). São serviços
-- diferentes, então são duas notas legítimas.

CREATE TABLE contrato (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tomador_id INT NOT NULL,
  -- Cada contrato aponta para o seu serviço: suporte de TI pode ter código de
  -- tributação e alíquota diferentes do SaaS. As alíquotas vêm daqui, da
  -- tabela `servico`, e não são copiadas para o contrato — mudar a alíquota na
  -- Configuração precisa valer para as notas seguintes.
  servico_id INT NOT NULL,
  descricao VARCHAR(500) NOT NULL COMMENT 'Vai para a descrição da NFS-e',
  valor DECIMAL(15,2) NOT NULL,
  dia_emissao TINYINT NOT NULL COMMENT '1 a 31; meses curtos usam o último dia',
  vigencia_inicio DATE NOT NULL,
  vigencia_fim DATE NULL COMMENT 'NULL = sem prazo',
  ativo TINYINT(1) NOT NULL DEFAULT 1,
  observacao VARCHAR(500) NULL,
  criado_por INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_contrato_tomador FOREIGN KEY (tomador_id) REFERENCES tomador(id),
  CONSTRAINT fk_contrato_servico FOREIGN KEY (servico_id) REFERENCES servico(id),
  CONSTRAINT ck_contrato_dia CHECK (dia_emissao BETWEEN 1 AND 31),
  CONSTRAINT ck_contrato_valor CHECK (valor > 0),
  INDEX idx_contrato_ativo (ativo, dia_emissao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotência da emissão recorrente.
--
-- `competencia_ref` é o mês de referência em texto ('2026-08'), separado do
-- campo fiscal `competencia` de propósito: aquele é uma data que vai no XML e
-- tem semântica própria, este é só a chave que impede emitir duas vezes o mesmo
-- mês. Misturar os dois amarraria a idempotência a uma decisão fiscal.
--
-- O índice único aceita vários NULL no MySQL, então as notas vindas da Stripe
-- (sem contrato) não conflitam entre si.
ALTER TABLE nota
  ADD COLUMN contrato_id INT NULL,
  ADD COLUMN competencia_ref CHAR(7) NULL COMMENT 'AAAA-MM do mês de referência',
  ADD CONSTRAINT fk_nota_contrato FOREIGN KEY (contrato_id) REFERENCES contrato(id),
  ADD UNIQUE KEY uk_nota_contrato_competencia (contrato_id, competencia_ref);

-- `origem` da nota precisa distinguir a emissão por contrato: sem isso ela
-- entraria como 'manual' e o painel não saberia dizer de onde a nota veio.
ALTER TABLE nota
  MODIFY origem ENUM('stripe','manual','contrato') NOT NULL DEFAULT 'stripe';
