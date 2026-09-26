const path = require("node:path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const database = process.env.DB_DATABASE || process.env.DB_NAME || "alunos_projetoMabel";
if (database !== "alunos_projetoMabel") {
    throw new Error("DB_DATABASE deve apontar para alunos_projetoMabel.");
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || (process.env.VERCEL ? 1 : 10)),
    queueLimit: 0,
    charset: "utf8mb4"
});

async function ensureAvaliacaoTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS alunos_avaliacoes (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(120) NOT NULL,
            email VARCHAR(255) NOT NULL,
            mensagem TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

async function getUsersTableName() {
    const [tables] = await pool.execute(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        ["alunos_usuarios"]
    );
    if (tables.length > 0) return "alunos_usuarios";

    const erro = new Error("Tabela de usuários não encontrada.");
    erro.code = "USERS_TABLE_NOT_FOUND";
    throw erro;
}

module.exports = { pool, ensureAvaliacaoTable, getUsersTableName };
