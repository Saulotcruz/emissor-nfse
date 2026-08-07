-- Segundo fator, códigos de recuperação e trilha de auditoria.

-- O segredo TOTP fica pendente até o usuário provar que conseguiu ler o QR:
-- gravar como ativo antes disso trancaria a conta de quem errou a leitura.
ALTER TABLE users
  ADD COLUMN mfa_segredo VARCHAR(64) NULL,
  ADD COLUMN mfa_ativo TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN mfa_confirmado_em TIMESTAMP NULL,
  -- Contador do último código aceito. Sem isto, um código capturado pode ser
  -- reapresentado dentro dos seus 30 segundos de validade.
  ADD COLUMN mfa_ultimo_contador BIGINT NULL;

-- Códigos de recuperação, para quando o celular se perde. Guardados como hash
-- pelo mesmo motivo das senhas, e marcados ao usar: cada um vale uma vez.
CREATE TABLE mfa_codigo_backup (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  codigo_hash VARCHAR(100) NOT NULL,
  usado_em TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_backup_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_backup_user (user_id, usado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Trilha de auditoria: quem fez o quê, quando e de onde.
--
-- É append-only por decisão: não existe rota que altere ou apague linha daqui.
-- Uma trilha que o próprio sistema edita não serve como prova de nada.
--
-- O e-mail é copiado além do user_id porque a resposta a "quem cancelou esta
-- nota?" não pode depender de o usuário ainda existir.
CREATE TABLE auditoria (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  usuario_email VARCHAR(190) NULL,
  acao VARCHAR(60) NOT NULL,
  entidade VARCHAR(40) NULL,
  entidade_id VARCHAR(60) NULL,
  detalhe JSON NULL,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_auditoria_data (created_at),
  INDEX idx_auditoria_acao (acao, created_at),
  INDEX idx_auditoria_entidade (entidade, entidade_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
