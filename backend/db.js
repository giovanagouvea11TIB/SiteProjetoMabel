const path = require("node:path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const { resolveDatabaseConfig } = require("./database-config");
const { runReadWithRetry } = require("./database-reads");

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const pool = mysql.createPool(resolveDatabaseConfig(process.env));

function executeReadWithRetry(query, params, action) {
    return runReadWithRetry(
        () => pool.execute(query, params),
        action
    );
}

async function getUsersTableName() {
    const [tables] = await executeReadWithRetry(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        ["alunos_usuarios"],
        "consultar a tabela de usuários"
    );
    if (tables.length > 0) return "alunos_usuarios";

    const erro = new Error("Tabela de usuários não encontrada.");
    erro.code = "USERS_TABLE_NOT_FOUND";
    throw erro;
}

module.exports = { pool, executeReadWithRetry, getUsersTableName };
