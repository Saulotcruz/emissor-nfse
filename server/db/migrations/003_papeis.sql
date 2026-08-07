-- Três papéis no lugar de admin/operador.
--
-- A troca é feita em três passos porque MySQL não deixa reescrever um ENUM
-- descartando um valor que ainda está em uso: primeiro os valores novos
-- convivem com o antigo, depois as linhas migram, e só então o antigo sai.

ALTER TABLE users
  MODIFY papel ENUM('visualizacao','emissao','admin','operador') NOT NULL DEFAULT 'visualizacao';

-- Quem era "operador" já emitia e cancelava; virar 'visualizacao' tiraria
-- acesso de quem trabalha.
UPDATE users SET papel = 'emissao' WHERE papel = 'operador';

-- O padrão passa a ser o papel de menor privilégio: um usuário criado sem
-- papel explícito deve ver, não emitir.
ALTER TABLE users
  MODIFY papel ENUM('visualizacao','emissao','admin') NOT NULL DEFAULT 'visualizacao';

ALTER TABLE users
  -- Senha definida por um admin é conhecida por ele. Forçar a troca no primeiro
  -- acesso faz a senha voltar a ser segredo de uma pessoa só — que é o que a
  -- trilha de auditoria pressupõe ao dizer "fulano cancelou a nota".
  ADD COLUMN deve_trocar_senha TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN ultimo_acesso_em TIMESTAMP NULL,
  ADD COLUMN criado_por INT NULL;
