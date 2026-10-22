// Integração do controle dos motores com um MySQL local DESCARTÁVEL.
// Execute com `npm run test:db`. A URL vem de MABEL_TEST_DATABASE_URL ou do arquivo
// ~/.mabel-test-db-url (fora do repositório). O teste cria um schema mabel_ci_<aleatório>,
// aplica as migrations 001-007, a estrutura inicial de mabel_sessoes e a migração 008, e apaga
// somente o schema que ele mesmo criou. Ele recusa hosts que não sejam locais, recusa servidores
// que contenham o schema de produção e nunca usa schemas preexistentes.
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
    ...[
        "001_create_pets.sql.template",
        "002_create_pet_vacinas.sql.template",
        "003_add_user_avatar.sql.template",
        "004_add_pet_vaccine_catalog_state.sql.template",
        "005_create_mabel_pet_associations.sql.template",
        "006_create_mabel_device_status.sql.template",
        "007_create_mabel_motor_control.sql.template"
    ].map((file) => path.join(__dirname, "migrations", file)),
    // mabel_sessoes já existe nos bancos reais; aqui ela é recriada antes da migração 008.
    ...[
        "000_mabel_sessoes_estrutura_inicial.sql",
        "008_historico_sessoes.sql"
    ].map((file) => path.join(__dirname, "..", "database", "migrations", file))
];
// Prefixo próprio, distinto de mabel_teste_restauracao, para que permissões de teste não alcancem o banco restaurado.
const SCHEMA_PATTERN = /^mabel_ci_[0-9a-f]{10}$/;
const FORBIDDEN_SCHEMAS = new Set([EXPECTED_DATABASE, "mabel_teste_restauracao"]);
// O pool do aplicativo usa um fuso fixo diferente de UTC; a conexão administrativa usa UTC; um
// segundo pool do aplicativo, em outro fuso, comprova que os horários das sessões não dependem dele.
const APP_TIME_ZONE = "-03:00";
const OTHER_APP_TIME_ZONE = "+09:00";
const ADMIN_TIME_ZONE = "+00:00";
const APP_OFFSET_MS = 3 * 60 * 60 * 1000;
const OTHER_APP_OFFSET_MS = 9 * 60 * 60 * 1000;

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
    const sql = fs.readFileSync(file, "utf8");
    return sql.split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter((statement) => statement.replace(/^\s*--.*$/gm, "").trim());
}

const databaseUrl = readDatabaseUrl();
const skip = databaseUrl ? false : "Defina MABEL_TEST_DATABASE_URL ou ~/.mabel-test-db-url para um MySQL local descartável.";

let admin;
let pool;
let otherPool;
let server;
let baseUrl;
let otherBaseUrl;
let schemaCreated = false;
const schema = `mabel_ci_${crypto.randomBytes(5).toString("hex")}`;

before(async () => {
    if (skip) return;
    assert.match(schema, SCHEMA_PATTERN);
    assert.equal(FORBIDDEN_SCHEMAS.has(schema), false);
    const options = connectionOptions(databaseUrl);
    admin = await mysql.createConnection(options);
    await admin.query(`SET time_zone = '${ADMIN_TIME_ZONE}'`);

    // Um servidor com o schema de produção (por exemplo, um túnel para o servidor remoto) é recusado.
    const [production] = await admin.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [
        EXPECTED_DATABASE
    ]);
    if (production.length > 0) {
        throw new Error("O servidor de teste contém o schema de produção; use um MySQL local descartável.");
    }

    // Sem IF NOT EXISTS: um schema preexistente com o mesmo nome faz o teste parar sem tocá-lo.
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    schemaCreated = true;
    await admin.query(`USE \`${schema}\``);
    const [[current]] = await admin.query("SELECT DATABASE() AS name");
    assert.equal(current.name, schema, "as migrations só rodam no schema descartável");

    await admin.query("CREATE TABLE alunos_usuarios (id BIGINT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB");
    for (const file of MIGRATIONS) {
        for (const statement of migrationStatements(file)) await admin.query(statement);
    }

    pool = mysql.createPool({ ...options, database: schema, connectionLimit: 5 });
    // Um fuso diferente de UTC expõe conversões de horário incorretas.
    pool.pool.on("connection", (connection) => connection.query(`SET time_zone = '${APP_TIME_ZONE}'`));
    otherPool = mysql.createPool({ ...options, database: schema, connectionLimit: 2 });
    otherPool.pool.on("connection", (connection) => connection.query(`SET time_zone = '${OTHER_APP_TIME_ZONE}'`));

    await admin.query("INSERT INTO alunos_usuarios (id) VALUES (41), (77)");
    await admin.query("INSERT INTO pets (id, usuario_id, nome) VALUES (22, 41, 'Mabel'), (23, 41, 'Tito'), (99, 77, 'Outro')");
    await admin.query(
        "INSERT INTO mabel_pet_associations (device_id, pet_id) VALUES ('mabel-esp32-01', 22), ('mabel-esp32-02', 23)"
    );
    // linked_at tem precisão de segundos; comandos só valem a partir do segundo seguinte.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const app = express();
    app.use(express.json());
    const routerOptions = {
        deviceToken: TOKEN,
        sessionMiddleware(req, res, next) {
            const userId = req.get("x-test-user");
            req.session = userId ? { usuario: { id: userId } } : {};
            next();
        }
    };
    app.use("/api/mabel", createMabelMotorRouter({ ...routerOptions, pool }));
    // Mesma API e mesmo schema, mas com conexões em outro fuso.
    app.use("/api/mabel-outro-fuso", createMabelMotorRouter({ ...routerOptions, pool: otherPool }));
    app.use((error, req, res, next) => {
        res.status(500).json({ sucesso: false, codigo: error.code || "erro" });
    });
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/mabel`;
    otherBaseUrl = `http://127.0.0.1:${server.address().port}/api/mabel-outro-fuso`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (otherPool) await otherPool.end();
    if (admin) {
        // Apaga apenas o schema aleatório criado por este processo.
        if (schemaCreated && SCHEMA_PATTERN.test(schema) && !FORBIDDEN_SCHEMAS.has(schema)) {
            await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
        }
        await admin.end();
    }
});

async function request(method, route, { body, user, device, otherTimeZone = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (user) headers["x-test-user"] = user;
    if (device) headers.Authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${otherTimeZone ? otherBaseUrl : baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
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

    // Somente neste schema descartável: recua a associação antes de envelhecer o comando além da janela
    // de início, para que ele continue posterior à associação (comandos anteriores a ela seguem recusados).
    await admin.query(
        "UPDATE mabel_pet_associations SET linked_at = linked_at - INTERVAL 2 MINUTE WHERE device_id = 'mabel-esp32-01'"
    );
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

// ---------- Histórico de sessões reais (mabel_sessoes + migração 008) ----------

// Sessões vinculadas a comandos guardam inicio_em/termino_em em UTC: a leitura usa aritmética pura
// (independente do fuso da conexão) e também devolve o texto gravado, para conferência direta.
const SESSION_COLUMNS = `id, usuario_id, pet_id, device_id, command_id, tipo_sessao, estado, intensidade_geral,
    motor1, motor2, motor3, motor4, motor5, duracao_segundos, fisico,
    TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', inicio_em) * 1000 AS inicio_ms,
    TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', termino_em) * 1000 AS termino_ms,
    DATE_FORMAT(inicio_em, '%Y-%m-%d %H:%i:%s') AS inicio_texto,
    DATE_FORMAT(termino_em, '%Y-%m-%d %H:%i:%s') AS termino_texto`;

// Texto de DATETIME interpretado explicitamente como UTC.
const utcTextMs = (text) => (text === null ? null : Date.parse(`${text.replace(" ", "T")}Z`));

// Lê pelo pool do aplicativo (fuso -03:00); os valores não dependem desse fuso.
async function sessionsForCommand(commandId) {
    const [rows] = await pool.query(`SELECT ${SESSION_COLUMNS} FROM mabel_sessoes WHERE command_id = ?`, [commandId]);
    return rows;
}

async function commandStatus(commandId) {
    const [[row]] = await admin.query("SELECT status FROM mabel_motor_commands WHERE id = ?", [commandId]);
    return row.status;
}

async function applyTurnOn(intensidade, duracaoS) {
    await config();
    const on = await request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade, duracao_s: duracaoS }
    });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    await config();
    const ack = await confirm({
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade },
        motivo: "comando"
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    return on.body.comando.command_id;
}

const nullableMs = (value) => (value === null ? null : Number(value));

// O MySQL omite os detalhes da chave (variante sem _2) quando a conta não tem privilégios
// suficientes sobre as tabelas envolvidas; as duas variantes são a mesma violação.
const MISSING_PARENT_CODES = new Set(["ER_NO_REFERENCED_ROW", "ER_NO_REFERENCED_ROW_2"]);
const REFERENCED_ROW_CODES = new Set(["ER_ROW_IS_REFERENCED", "ER_ROW_IS_REFERENCED_2"]);

function foreignKeyViolation(codes, label) {
    return (error) => {
        assert.ok(codes.has(error.code), `${label}: violação de chave estrangeira esperada, recebido ${error.code} (${error.errno})`);
        return true;
    };
}

test("mabel_sessoes recebe a migração 008 com colunas, chaves e relacionamentos esperados", { skip }, async () => {
    const [columns] = await admin.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, DATETIME_PRECISION
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'mabel_sessoes'`,
        [schema]
    );
    const byName = Object.fromEntries(columns.map((column) => [column.COLUMN_NAME, column]));
    for (const name of [
        "id", "usuario_id", "device_id", "tipo_sessao", "estado", "intensidade_geral",
        "motor1", "motor2", "motor3", "motor4", "motor5", "duracao_segundos",
        "inicio_em", "termino_em", "criado_em", "atualizado_em", "pet_id", "command_id", "fisico"
    ]) {
        assert.ok(byName[name], `coluna ${name}`);
    }
    for (const absent of ["intensidade", "duracao_s", "status", "fim_em", "motivo"]) {
        assert.equal(byName[absent], undefined, `a coluna ${absent} não existe no esquema real`);
    }
    for (const name of ["pet_id", "command_id", "fisico", "inicio_em", "termino_em"]) {
        assert.equal(byName[name].IS_NULLABLE, "YES", name);
    }
    assert.equal(byName.usuario_id.IS_NULLABLE, "NO");
    assert.equal(byName.estado.COLUMN_TYPE, "varchar(20)");
    assert.equal(byName.tipo_sessao.COLUMN_TYPE, "varchar(30)");
    assert.equal(byName.inicio_em.DATA_TYPE, "datetime");
    assert.equal(Number(byName.inicio_em.DATETIME_PRECISION), 0, "DATETIME sem frações de segundo");

    const [references] = await admin.query(
        `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = 'mabel_sessoes' AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.COLUMN_NAME`,
        [schema]
    );
    assert.deepEqual(
        references.map((row) => [row.COLUMN_NAME, row.REFERENCED_TABLE_NAME, row.REFERENCED_COLUMN_NAME]),
        [
            ["command_id", "mabel_motor_commands", "id"],
            ["pet_id", "pets", "id"],
            ["usuario_id", "alunos_usuarios", "id"]
        ]
    );
    const rules = Object.fromEntries(references.map((row) => [row.COLUMN_NAME, row.DELETE_RULE]));
    assert.equal(rules.command_id, "RESTRICT");
    assert.equal(rules.pet_id, "RESTRICT");
    assert.ok(["RESTRICT", "NO ACTION"].includes(rules.usuario_id), rules.usuario_id);

    const [unique] = await admin.query(
        `SELECT NON_UNIQUE FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'mabel_sessoes' AND INDEX_NAME = 'uq_mabel_sessoes_command_id'`,
        [schema]
    );
    assert.equal(Number(unique[0]?.NON_UNIQUE), 0, "command_id é único");

    const insert = `INSERT INTO mabel_sessoes
        (usuario_id, pet_id, device_id, command_id, tipo_sessao, estado, intensidade_geral,
         motor1, motor2, motor3, motor4, motor5, duracao_segundos, fisico)
        VALUES (?, ?, 'mabel-esp32-02', ?, 'real', 'concluida', 10, 10, 10, 10, 10, 10, 30, 0)`;
    for (const [usuarioId, petId, label] of [["41", "12345", "pet inexistente"], ["999", "23", "usuário inexistente"]]) {
        await assert.rejects(admin.query(insert, [usuarioId, petId, null]), foreignKeyViolation(MISSING_PARENT_CODES, label));
    }
    await assert.rejects(
        admin.query(insert, ["41", "23", "999999999"]),
        foreignKeyViolation(MISSING_PARENT_CODES, "comando inexistente")
    );

    // Somente neste schema descartável: confirma os valores padrão e remove a linha em seguida.
    const [created] = await admin.query(insert, ["41", "23", null]);
    const [[defaults]] = await admin.query(
        "SELECT criado_em IS NOT NULL AS tem_criado, atualizado_em IS NOT NULL AS tem_atualizado, inicio_em, termino_em FROM mabel_sessoes WHERE id = ?",
        [created.insertId]
    );
    assert.deepEqual(
        { ...defaults, tem_criado: Number(defaults.tem_criado), tem_atualizado: Number(defaults.tem_atualizado) },
        { tem_criado: 1, tem_atualizado: 1, inicio_em: null, termino_em: null }
    );
    await admin.query("DELETE FROM mabel_sessoes WHERE id = ?", [created.insertId]);
});

test("a confirmação real cria a sessão uma única vez e o desligamento a encerra", { skip }, async () => {
    const startedAt = Date.now();
    const commandId = await applyTurnOn(40, 60);
    let rows = await sessionsForCommand(commandId);
    assert.equal(rows.length, 1);
    const [started] = rows;
    assert.deepEqual(
        {
            usuario_id: String(started.usuario_id),
            pet_id: String(started.pet_id),
            device_id: started.device_id,
            command_id: String(started.command_id),
            tipo_sessao: started.tipo_sessao,
            estado: started.estado,
            motores: [started.intensidade_geral, started.motor1, started.motor2, started.motor3, started.motor4, started.motor5].map(Number),
            duracao_segundos: Number(started.duracao_segundos),
            fisico: Number(started.fisico),
            termino_ms: started.termino_ms
        },
        {
            usuario_id: "41",
            pet_id: "22",
            device_id: "mabel-esp32-01",
            command_id: commandId,
            tipo_sessao: "real",
            estado: "ativa",
            motores: [40, 40, 40, 40, 40, 40],
            duracao_segundos: 60,
            fisico: 0,
            termino_ms: null
        }
    );
    const inicioMs = Number(started.inicio_ms);
    assert.equal(inicioMs % 1000, 0, "DATETIME guarda segundos");
    assert.ok(Math.abs(inicioMs - startedAt) < 5000, "início no horário da confirmação, sem deslocamento de fuso");

    const repeated = await confirm({
        command_id: commandId,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(repeated.status, 200);
    rows = await sessionsForCommand(commandId);
    assert.equal(rows.length, 1, "confirmação repetida não duplica a sessão");
    assert.equal(Number(rows[0].inicio_ms), inicioMs, "nem altera o início");

    const off = await request("POST", "/motores", { user: "41", body: { pet_id: "22", ligado: false } });
    assert.equal(off.status, 201);
    assert.equal(openSessionCount(await sessionsForCommand(commandId)), 1, "o pedido de desligar não encerra a sessão");
    await config();
    const offAck = await confirm({
        command_id: off.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comando"
    });
    assert.equal(offAck.status, 200);
    const [closed] = await sessionsForCommand(commandId);
    assert.equal(closed.estado, "interrompida");
    assert.ok(nullableMs(closed.termino_ms) >= inicioMs);
    assert.equal((await sessionsForCommand(off.body.comando.command_id)).length, 0, "desligar não cria sessão");
});

function openSessionCount(rows) {
    return rows.filter((row) => row.estado === "ativa").length;
}

test("a perda de comunicação gera sem_confirmacao sem horário e a confirmação posterior a encerra", { skip }, async () => {
    const commandId = await applyTurnOn(50, 120);
    // Somente neste schema descartável: simula 20 s sem contato da ESP32.
    await admin.query(
        "UPDATE mabel_motor_state SET ultimo_contato = ultimo_contato - INTERVAL 20 SECOND WHERE device_id = 'mabel-esp32-01'"
    );
    const status = await request("GET", "/motores?pet_id=22", { user: "41" });
    assert.equal(status.status, 200);
    assert.equal(status.body.online, false);

    const [inferred] = await sessionsForCommand(commandId);
    assert.equal(inferred.estado, "sem_confirmacao");
    assert.equal(inferred.termino_ms, null, "nenhum horário de término é inventado");
    assert.equal(Number(inferred.fisico), 0);
    assert.equal(await commandStatus(commandId), "aplicado", "o comando não recebe confirmação inventada");

    const interrupted = await confirm({
        command_id: commandId,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comunicacao"
    });
    assert.equal(interrupted.status, 200);
    const [confirmed] = await sessionsForCommand(commandId);
    assert.equal(confirmed.estado, "interrompida");
    assert.equal(confirmed.termino_ms, null);
    assert.equal(await commandStatus(commandId), "interrompido");
});

test("o histórico é consultado por pet e usuário, em ordem decrescente e sem cache", { skip }, async () => {
    const response = await request("GET", "/sessoes?pet_id=22", { user: "41" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.body.pet_id, "22");
    assert.equal(response.body.limite, 50);

    const [expected] = await pool.query(
        "SELECT id FROM mabel_sessoes WHERE pet_id = 22 AND usuario_id = 41 ORDER BY criado_em DESC, id DESC LIMIT 50"
    );
    assert.ok(expected.length >= 3);
    assert.deepEqual(response.body.sessoes.map((session) => session.id), expected.map((row) => String(row.id)));
    for (const session of response.body.sessoes) {
        assert.equal(session.tipo_sessao, "real");
        assert.equal(session.fisico, false);
        assert.deepEqual(session.motores, Array(5).fill(session.intensidade_geral));
        assert.ok(Math.abs(Date.parse(session.inicio_em) - Date.now()) < 10 * 60 * 1000, "horário em UTC correto");
    }
    const inferredThenConfirmed = response.body.sessoes.find((session) => session.termino_em === null && session.estado === "interrompida");
    assert.equal(inferredThenConfirmed?.encerramento, "confirmado");

    assert.equal((await request("GET", "/sessoes?pet_id=22", { user: "77" })).status, 404, "outro usuário não vê o histórico");
    assert.equal((await request("GET", "/sessoes?pet_id=22")).status, 401);
    const empty = await request("GET", "/sessoes?pet_id=23", { user: "41" });
    assert.deepEqual(empty.body.sessoes, []);
});

test("sessões novas guardam inicio_em em UTC; só UNIX_TIMESTAMP do DATETIME depende do fuso da conexão", { skip }, async () => {
    const query = `SELECT UNIX_TIMESTAMP(s.inicio_em) * 1000 AS unix_ms,
            TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', s.inicio_em) * 1000 AS utc_ms,
            UNIX_TIMESTAMP(c.solicitado_em) * 1000 AS solicitado_ms
        FROM mabel_sessoes s
        JOIN mabel_motor_commands c ON c.id = s.command_id
        WHERE s.inicio_em IS NOT NULL
        ORDER BY s.id DESC
        LIMIT 1`;
    const [[app]] = await pool.query(query);
    const [[other]] = await otherPool.query(query);
    const [[utc]] = await admin.query(query);
    const instantMs = Number(utc.utc_ms);

    for (const [label, row] of [[APP_TIME_ZONE, app], [OTHER_APP_TIME_ZONE, other]]) {
        assert.equal(Number(row.solicitado_ms), Number(utc.solicitado_ms), `${label}: TIMESTAMP é o mesmo instante`);
        assert.equal(Number(row.utc_ms), instantMs, `${label}: a leitura UTC do DATETIME não depende do fuso`);
    }
    const solicitadoMs = Number(utc.solicitado_ms);
    assert.ok(instantMs >= Math.floor(solicitadoMs / 1000) * 1000, "o início não é anterior ao comando");
    assert.ok(instantMs - solicitadoMs < 5000, "o início corresponde à confirmação do comando");

    // O texto gravado é o relógio UTC: só coincide com UNIX_TIMESTAMP numa conexão em UTC.
    assert.equal(Number(utc.unix_ms), instantMs, `em ${ADMIN_TIME_ZONE}, UNIX_TIMESTAMP coincide com a leitura UTC`);
    assert.equal(Number(app.unix_ms) - instantMs, APP_OFFSET_MS, `em ${APP_TIME_ZONE}, UNIX_TIMESTAMP ficaria 3 h adiante`);
    assert.equal(Number(other.unix_ms) - instantMs, -OTHER_APP_OFFSET_MS, `em ${OTHER_APP_TIME_ZONE}, ficaria 9 h antes`);
});

const confirmVia = (otherTimeZone, body) => request("POST", "/motores/confirmacao", {
    device: true,
    otherTimeZone,
    body: { device_id: "mabel-esp32-01", fisico: false, ...body }
});

async function historyEntry(sessionId, petId, otherTimeZone) {
    const response = await request("GET", `/sessoes?pet_id=${petId}`, { user: "41", otherTimeZone });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.sessoes.find((session) => session.id === String(sessionId));
}

test("início e término gravados por conexões em fusos diferentes são UTC e iguais nas duas APIs", { skip }, async () => {
    await config();
    const beforeStart = Date.now();
    const on = await request("POST", "/motores", {
        user: "41",
        body: { pet_id: "22", ligado: true, intensidade: 45, duracao_s: 120 }
    });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    const commandId = on.body.comando.command_id;
    await config();
    // A confirmação de início é gravada por uma conexão em +09:00.
    const ack = await confirmVia(true, {
        command_id: commandId,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 45 },
        motivo: "comando"
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    const afterStart = Date.now();

    let rows = await sessionsForCommand(commandId);
    assert.equal(rows.length, 1);
    const startMs = utcTextMs(rows[0].inicio_texto);
    assert.ok(startMs >= Math.floor(beforeStart / 1000) * 1000 && startMs <= afterStart, "inicio_em é o relógio UTC da confirmação");
    assert.equal(Number(rows[0].inicio_ms), startMs);
    assert.equal(rows[0].termino_texto, null, "sessão ativa não tem término");

    for (const otherTimeZone of [false, true]) {
        const entry = await historyEntry(rows[0].id, "22", otherTimeZone);
        assert.equal(entry.inicio_em, new Date(startMs).toISOString(), `início igual na API ${otherTimeZone ? OTHER_APP_TIME_ZONE : APP_TIME_ZONE}`);
        assert.equal(entry.termino_em, null, "término nulo permanece nulo");
    }

    const repeated = await confirm({
        command_id: commandId,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 45 },
        motivo: "comando"
    });
    assert.equal(repeated.status, 200);
    rows = await sessionsForCommand(commandId);
    assert.equal(rows.length, 1, "confirmação repetida em outro fuso não duplica a sessão");
    assert.equal(utcTextMs(rows[0].inicio_texto), startMs, "nem altera o início");

    // O término é gravado por uma conexão em -03:00.
    const off = await request("POST", "/motores", { user: "41", body: { pet_id: "22", ligado: false } });
    assert.equal(off.status, 201);
    await config();
    const beforeEnd = Date.now();
    const offAck = await confirmVia(false, {
        command_id: off.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comando"
    });
    assert.equal(offAck.status, 200);
    const afterEnd = Date.now();

    [rows[0]] = await sessionsForCommand(commandId);
    const endMs = utcTextMs(rows[0].termino_texto);
    assert.equal(rows[0].estado, "interrompida");
    assert.ok(endMs >= Math.floor(beforeEnd / 1000) * 1000 && endMs <= afterEnd, "termino_em é o relógio UTC da confirmação");
    assert.ok(endMs >= startMs);
    for (const otherTimeZone of [false, true]) {
        const entry = await historyEntry(rows[0].id, "22", otherTimeZone);
        assert.equal(entry.inicio_em, new Date(startMs).toISOString());
        assert.equal(entry.termino_em, new Date(endMs).toISOString(), `término igual na API ${otherTimeZone ? OTHER_APP_TIME_ZONE : APP_TIME_ZONE}`);
    }
});

test("sessões legadas (command_id NULL) mantêm a leitura anterior, sem conversão dos dados", { skip }, async () => {
    // Somente neste schema descartável: registros no formato antigo, com os valores padrão da tabela.
    const [dated] = await admin.query(
        "INSERT INTO mabel_sessoes (usuario_id, pet_id, duracao_segundos, inicio_em) VALUES (41, 23, 300, '2026-01-15 12:00:00')"
    );
    const [undated] = await admin.query(
        "INSERT INTO mabel_sessoes (usuario_id, pet_id, duracao_segundos) VALUES (41, 23, 300)"
    );

    // Leitura anterior: o DATETIME é interpretado no fuso da conexão que consulta.
    for (const [otherTimeZone, expected] of [[false, "2026-01-15T15:00:00.000Z"], [true, "2026-01-15T03:00:00.000Z"]]) {
        const entry = await historyEntry(dated.insertId, "23", otherTimeZone);
        assert.equal(entry.inicio_em, expected);
        assert.equal(entry.termino_em, null);
        assert.equal(entry.command_id, null);
        assert.equal(entry.estado, "configurada");
        assert.equal(entry.encerramento, null);
        const empty = await historyEntry(undated.insertId, "23", otherTimeZone);
        assert.equal(empty.inicio_em, null, "início nulo permanece nulo");
        assert.equal(empty.termino_em, null);
    }

    const [[stored]] = await admin.query(
        "SELECT DATE_FORMAT(inicio_em, '%Y-%m-%d %H:%i:%s') AS inicio_texto, termino_em FROM mabel_sessoes WHERE id = ?",
        [dated.insertId]
    );
    assert.deepEqual({ ...stored }, { inicio_texto: "2026-01-15 12:00:00", termino_em: null }, "o registro antigo não foi alterado");
});

test("ON DELETE RESTRICT impede excluir um pet com sessões e preserva o histórico", { skip }, async () => {
    const [[before]] = await admin.query("SELECT COUNT(*) AS total FROM mabel_sessoes WHERE pet_id = 22");
    assert.ok(Number(before.total) > 0);
    const [[session]] = await admin.query("SELECT command_id FROM mabel_sessoes WHERE pet_id = 22 AND command_id IS NOT NULL LIMIT 1");

    await assert.rejects(
        admin.query("DELETE FROM pets WHERE id = 22"),
        foreignKeyViolation(REFERENCED_ROW_CODES, "excluir pet com sessões")
    );
    await assert.rejects(
        admin.query("DELETE FROM mabel_motor_commands WHERE id = ?", [session.command_id]),
        foreignKeyViolation(REFERENCED_ROW_CODES, "excluir comando com sessão")
    );

    const [[pet]] = await admin.query("SELECT COUNT(*) AS total FROM pets WHERE id = 22");
    const [[after]] = await admin.query("SELECT COUNT(*) AS total FROM mabel_sessoes WHERE pet_id = 22");
    const [[association]] = await admin.query("SELECT COUNT(*) AS total FROM mabel_pet_associations WHERE pet_id = 22");
    assert.equal(Number(pet.total), 1, "o pet continua cadastrado");
    assert.equal(Number(after.total), Number(before.total), "nenhuma sessão foi apagada");
    assert.equal(Number(association.total), 1, "a exclusão recusada não removeu a associação em cascata");
});
