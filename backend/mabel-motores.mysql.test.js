// Integração do controle dos motores com um MySQL local DESCARTÁVEL.
// Execute com `npm run test:db`. A URL vem de MABEL_TEST_DATABASE_URL ou do arquivo
// ~/.mabel-test-db-url (fora do repositório). O teste cria um schema mabel_teste_<aleatório>,
// aplica as migrations 001-007 e apaga o schema ao final. Ele recusa hosts que não sejam locais
// e nunca usa o schema de produção.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const express = require("express");
const mysql = require("mysql2/promise");
const { createMabelMotorRouter } = require("./routes/mabel-motores");
const { EXPECTED_DATABASE } = require("./database-config");

const TOKEN = "integration-device-token-with-32-plus-characters";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MIGRATIONS = [
    "001_create_pets.sql.template",
    "002_create_pet_vacinas.sql.template",
    "003_add_user_avatar.sql.template",
    "004_add_pet_vaccine_catalog_state.sql.template",
    "005_create_mabel_pet_associations.sql.template",
    "006_create_mabel_device_status.sql.template",
    "007_create_mabel_motor_control.sql.template"
];

function readDatabaseUrl() {
    if (process.env.MABEL_TEST_DATABASE_URL) return process.env.MABEL_TEST_DATABASE_URL.trim();
    const file = path.join(os.homedir(), ".mabel-test-db-url");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function connectionOptions(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== "mysql:") throw new Error("A URL de teste deve usar mysql://.");
    if (!LOCAL_HOSTS.has(url.hostname)) {
        throw new Error("O teste de banco só roda contra um MySQL local (localhost/127.0.0.1).");
    }
    return {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        charset: "utf8mb4"
    };
}

function migrationStatements(file) {
    const sql = fs.readFileSync(path.join(__dirname, "migrations", file), "utf8");
    return sql.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
}

const databaseUrl = readDatabaseUrl();
const skip = databaseUrl ? false : "Defina MABEL_TEST_DATABASE_URL ou ~/.mabel-test-db-url para um MySQL local descartável.";

let admin;
let pool;
let server;
let baseUrl;
const schema = `mabel_teste_${crypto.randomBytes(5).toString("hex")}`;

before(async () => {
    if (skip) return;
    assert.notEqual(schema, EXPECTED_DATABASE);
    const options = connectionOptions(databaseUrl);
    admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    await admin.query(`USE \`${schema}\``);
    await admin.query("CREATE TABLE alunos_usuarios (id BIGINT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB");
    for (const file of MIGRATIONS) {
        for (const statement of migrationStatements(file)) await admin.query(statement);
    }

    pool = mysql.createPool({ ...options, database: schema, connectionLimit: 5 });
    // Um fuso diferente de UTC expõe conversões de horário incorretas.
    pool.pool.on("connection", (connection) => connection.query("SET time_zone = '-03:00'"));

    await admin.query("INSERT INTO alunos_usuarios (id) VALUES (41), (77)");
    await admin.query("INSERT INTO pets (id, usuario_id, nome) VALUES (22, 41, 'Mabel'), (23, 41, 'Tito'), (99, 77, 'Outro')");
    await admin.query(
        "INSERT INTO mabel_pet_associations (device_id, pet_id) VALUES ('mabel-esp32-01', 22), ('mabel-esp32-02', 23)"
    );
    // linked_at tem precisão de segundos; comandos só valem a partir do segundo seguinte.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const app = express();
    app.use(express.json());
    app.use("/api/mabel", createMabelMotorRouter({
        deviceToken: TOKEN,
        sessionMiddleware(req, res, next) {
            const userId = req.get("x-test-user");
            req.session = userId ? { usuario: { id: userId } } : {};
            next();
        },
        pool
    }));
    app.use((error, req, res, next) => {
        res.status(500).json({ sucesso: false, codigo: error.code || "erro" });
    });
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/mabel`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
        await admin.end();
    }
});

async function request(method, route, { body, user, device } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (user) headers["x-test-user"] = user;
    if (device) headers.Authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
}

const config = (deviceId = "mabel-esp32-01") => request("GET", `/config?device_id=${deviceId}`, { device: true });
const confirm = (body) => request("POST", "/motores/confirmacao", {
    device: true,
    body: { device_id: "mabel-esp32-01", fisico: false, ...body }
});

test("as migrations criam as restrições esperadas no MySQL", { skip }, async () => {
    const [columns] = await admin.query(
        `SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME, DATETIME_PRECISION
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('mabel_motor_commands', 'mabel_motor_state')`,
        [schema]
    );
    const byName = Object.fromEntries(columns.map((column) => [`${column.TABLE_NAME}.${column.COLUMN_NAME}`, column]));
    assert.equal(byName["mabel_motor_commands.device_id"].COLLATION_NAME, "ascii_bin");
    assert.equal(Number(byName["mabel_motor_commands.solicitado_em"].DATETIME_PRECISION), 3);
    assert.equal(Number(byName["mabel_motor_state.ultimo_contato"].DATETIME_PRECISION), 3);

    await assert.rejects(
        admin.query("INSERT INTO mabel_motor_commands (device_id, pet_id, usuario_id, ligado, intensidade, duracao_s) VALUES ('x', 22, 41, 1, 101, 60)"),
        (error) => error.code === "ER_CHECK_CONSTRAINT_VIOLATED"
    );
    await assert.rejects(
        admin.query("INSERT INTO mabel_motor_commands (device_id, pet_id, usuario_id, ligado, intensidade, duracao_s) VALUES ('x', 22, 41, 0, 10, 0)"),
        (error) => error.code === "ER_CHECK_CONSTRAINT_VIOLATED"
    );
});

test("ligar, confirmar, consultar e desligar com SQL real e fuso diferente de UTC", { skip }, async () => {
    assert.equal((await config()).status, 200);
    const on = await request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade: 40, duracao_s: 60 }
    });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.ok(Math.abs(Date.parse(on.body.comando.solicitado_em) - Date.now()) < 5000, "horário em UTC correto");

    const served = await config();
    assert.equal(served.body.command_id, on.body.comando.command_id);
    assert.equal(served.body.motores.ligado, true);
    assert.ok(served.body.motores.duracao_restante_ms > 55000 && served.body.motores.duracao_restante_ms <= 60000);

    const ack = await confirm({
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(ack.status, 200);
    const status = await request("GET", "/motores?pet_id=22", { user: "41" });
    assert.equal(status.body.online, true);
    assert.equal(status.body.solicitado.estado, "aplicado");
    assert.equal(status.body.confirmado.intensidade, 40);

    const off = await request("POST", "/motores", { user: "41", body: { pet_id: "22", ligado: false } });
    assert.equal(off.status, 201);
    assert.equal((await config()).body.motores.ligado, false);
    assert.equal((await confirm({
        command_id: off.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comando"
    })).status, 200);
});

test("comandos simultâneos deixam um único comando pendente e o antigo é recusado", { skip }, async () => {
    await config();
    const responses = await Promise.all([10, 20, 30, 40, 50].map((intensidade) => request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade, duracao_s: 30 }
    })));
    assert.deepEqual(responses.map((response) => response.status), [201, 201, 201, 201, 201]);
    const [pending] = await admin.query(
        "SELECT id FROM mabel_motor_commands WHERE device_id = 'mabel-esp32-01' AND status = 'pendente'"
    );
    assert.equal(pending.length, 1);

    const served = await config();
    assert.equal(served.body.command_id, String(pending[0].id));
    const oldest = responses.map((response) => response.body.comando.command_id)
        .find((id) => id !== served.body.command_id);
    const old = await confirm({
        command_id: oldest,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 10 },
        motivo: "comando"
    });
    assert.equal(old.status, 409);
});

test("isolamento entre dispositivos, comando expirado e ESP32 offline", { skip }, async () => {
    const on = await request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade: 35, duracao_s: 60 }
    });
    const other = await config("mabel-esp32-02");
    assert.equal(other.body.command_id, null);
    const cross = await request("POST", "/motores/confirmacao", {
        device: true,
        body: {
            device_id: "mabel-esp32-02",
            command_id: on.body.comando.command_id,
            resultado: "aplicado",
            motores: { ligado: true, intensidade: 35 },
            fisico: false,
            motivo: "comando"
        }
    });
    assert.equal(cross.status, 404);
    assert.equal((await config("mabel-esp32-99")).status, 403);
    assert.equal((await request("POST", "/motores", {
        user: "77",
        body: { pet_id: "22", ligado: false }
    })).status, 404);

    // Somente neste schema descartável: envelhece o comando além da janela de início.
    await admin.query(
        "UPDATE mabel_motor_commands SET solicitado_em = solicitado_em - INTERVAL 31 SECOND WHERE id = ?",
        [on.body.comando.command_id]
    );
    const expired = await config();
    assert.equal(expired.body.estado_comando, "expirado");
    assert.equal(expired.body.motores.ligado, false);

    await admin.query("UPDATE mabel_motor_state SET ultimo_contato = ultimo_contato - INTERVAL 20 SECOND");
    const offline = await request("GET", "/motores?pet_id=22", { user: "41" });
    assert.equal(offline.body.online, false);
    assert.equal((await request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade: 35, duracao_s: 60 }
    })).status, 409);
});

test("excluir o pet remove seus comandos em cascata", { skip }, async () => {
    await admin.query("INSERT INTO pets (id, usuario_id, nome) VALUES (24, 41, 'Temporário')");
    await admin.query("INSERT INTO mabel_motor_commands (device_id, pet_id, usuario_id, ligado, intensidade, duracao_s) VALUES ('mabel-esp32-03', 24, 41, 0, 0, 0)");
    await admin.query("DELETE FROM pets WHERE id = 24");
    const [rows] = await admin.query("SELECT id FROM mabel_motor_commands WHERE pet_id = 24");
    assert.equal(rows.length, 0);
});
