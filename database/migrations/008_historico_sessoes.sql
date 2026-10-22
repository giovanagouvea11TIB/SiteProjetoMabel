
-- Projeto Mabel
-- Migração 008: Histórico de Sessões Reais
--
-- Aplicar somente em bancos que ainda não receberam esta migração.
-- O banco local mabel_teste_restauracao já foi atualizado
-- manualmente em 21/10/2026.
--
-- Antes da aplicação em produção:
-- 1. Realizar backup.
-- 2. Conferir as colunas e restrições existentes.
-- 3. Validar o backend e os testes automatizados.

ALTER TABLE mabel_sessoes
    ADD COLUMN pet_id BIGINT NULL,
    ADD COLUMN command_id BIGINT NULL,
    ADD COLUMN fisico TINYINT NULL,

    ADD UNIQUE KEY
        uq_mabel_sessoes_command_id (command_id),

    ADD KEY
        idx_mabel_sessoes_pet_id (pet_id),

    ADD CONSTRAINT fk_mabel_sessoes_pet
        FOREIGN KEY (pet_id)
        REFERENCES pets(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    ADD CONSTRAINT fk_mabel_sessoes_command
        FOREIGN KEY (command_id)
        REFERENCES mabel_motor_commands(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE;
