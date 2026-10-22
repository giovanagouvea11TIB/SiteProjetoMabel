-- Projeto Mabel
-- Estrutura inicial de mabel_sessoes, anterior à migração 008.
--
-- A tabela JÁ EXISTE nos bancos do projeto. Este arquivo NÃO deve ser aplicado
-- em produção nem no banco restaurado: ele reproduz a estrutura apenas para o
-- teste de integração em banco descartável (backend/mabel-motores.mysql.test.js),
-- que aplica em seguida a migração 008 (pet_id, command_id e fisico).
--
-- Estrutura conferida com o SHOW CREATE TABLE original de mabel_sessoes:
-- colunas, valores padrão, índices, chave estrangeira de usuario_id e collation.

CREATE TABLE `mabel_sessoes` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint NOT NULL,
  `device_id` varchar(64) NOT NULL DEFAULT 'MABEL-ESP32-01',
  `tipo_sessao` varchar(30) NOT NULL DEFAULT 'MODERADA',
  `estado` varchar(20) NOT NULL DEFAULT 'configurada',
  `intensidade_geral` tinyint unsigned NOT NULL DEFAULT '35',
  `motor1` tinyint unsigned NOT NULL DEFAULT '0',
  `motor2` tinyint unsigned NOT NULL DEFAULT '0',
  `motor3` tinyint unsigned NOT NULL DEFAULT '0',
  `motor4` tinyint unsigned NOT NULL DEFAULT '0',
  `motor5` tinyint unsigned NOT NULL DEFAULT '0',
  `duracao_segundos` int unsigned NOT NULL,
  `inicio_em` datetime DEFAULT NULL,
  `termino_em` datetime DEFAULT NULL,
  `criado_em` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `atualizado_em` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sessoes_usuario` (`usuario_id`),
  KEY `idx_sessoes_estado` (`estado`),
  KEY `idx_sessoes_inicio` (`inicio_em`),
  CONSTRAINT `fk_mabel_sessoes_usuario`
    FOREIGN KEY (`usuario_id`)
    REFERENCES `alunos_usuarios` (`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
