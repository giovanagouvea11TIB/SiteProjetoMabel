const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const routeFile = path.resolve(__dirname, "mabel-motores.js");
const originalLoad = Module._load;
const TOKEN = "test-device-token-with-at-least-thirty-two-characters";
const DEVICE_ID = "mabel-esp32-01";
const OTHER_DEVICE_ID = "mabel-esp32-02";
const LINKED_AT_MS = Date.parse("2026-10-20T12:00:00.000Z");

Module._load = function loadWithExpressStub(request, parent, isMain) {
    if (request === "express" && parent.filename === routeFile) {
        return {
            Router() {
                const handlers = new Map();
                return {
                    handlers,
                    get(route, handler) { handlers.set(`GET ${route}`, handler); },
                    post(route, handler) { handlers.set(`POST ${route}`, handler); }
                };
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[routeFile];
const { createMabelMotorRouter, START_WINDOW_MS, OFFLINE_AFTER_MS, POLL_INTERVAL_MS } = require("./mabel-motores");
Module._load = originalLoad;

function createDatabase({ missingTables = false, failingQuery = null, failingCode = "ER_LOCK_WAIT_TIMEOUT" } = {}) {
    let state = {
        now: LINKED_AT_MS + 5000,
        pets: { "22": "41", "23": "41", "99": "77" },
        associations: {
            [DEVICE_ID]: { pet_id: "22", linked_ms: LINKED_AT_MS },
            [OTHER_DEVICE_ID]: { pet_id: "23", linked_ms: LINKED_AT_MS }
        },
        commands: [],
        motorState: {},
        sessions: [],
        nextCommandId: 1,
        nextSessionId: 1
    };

    function assertTables(sql) {
        if (missingTables && /mabel_(motor_commands|motor_state|sessoes)/.test(sql)) {
            throw Object.assign(new Error("Table doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
        }
    }

    function failIfRequested(sql) {
        if (failingQuery && failingQuery.test(sql)) {
            throw Object.assign(new Error("Simulated database failure"), { code: failingCode });
        }
    }

    function commandRow(command) {
        return command ? [{ ...command }] : [];
    }

    // Esquema real de mabel_sessoes, incluindo as colunas da migração 008. As consultas do backend ainda
    // não existem, então a tabela é simulada de forma genérica (INSERT [IGNORE], UPDATE e SELECT sem JOIN)
    // e recusa colunas inexistentes, NULL em colunas obrigatórias e valores fora do tipo.
    // Colunas *_em são guardadas em milissegundos como *_ms; DATETIME tem precisão de segundos.
    const TINYINT_UNSIGNED = { integer: true, min: 0, max: 255 };
    const SESSION_COLUMNS = {
        id: { integer: true, min: 1, max: Number.MAX_SAFE_INTEGER },
        usuario_id: { required: true },
        device_id: { required: true, maxLength: 64 },
        tipo_sessao: { required: true, maxLength: 30 },
        estado: { required: true, maxLength: 20 },
        intensidade_geral: { required: true, ...TINYINT_UNSIGNED },
        motor1: { required: true, ...TINYINT_UNSIGNED },
        motor2: { required: true, ...TINYINT_UNSIGNED },
        motor3: { required: true, ...TINYINT_UNSIGNED },
        motor4: { required: true, ...TINYINT_UNSIGNED },
        motor5: { required: true, ...TINYINT_UNSIGNED },
        duracao_segundos: { required: true, integer: true, min: 0, max: 4294967295 },
        inicio_em: { datetime: true },
        termino_em: { datetime: true },
        criado_em: { timestamp: true },
        atualizado_em: { timestamp: true },
        pet_id: {},
        command_id: {},
        fisico: { integer: true, min: -128, max: 127 }
    };

    function sqlError(code, message) {
        return Object.assign(new Error(message), { code });
    }

    function sessionColumn(column) {
        const name = column.trim().replace(/^\w+\./, "");
        if (!Object.hasOwn(SESSION_COLUMNS, name)) {
            throw sqlError("ER_BAD_FIELD_ERROR", `Unknown column '${name}' in 'mabel_sessoes'`);
        }
        return name;
    }

    function sessionKey(column) {
        const name = sessionColumn(column);
        return name.endsWith("_em") ? `${name.slice(0, -3)}_ms` : name;
    }

    function sessionValue(expression, nextParam) {
        const value = expression.trim();
        if (value === "?") return nextParam();
        // O relógio simulado é UTC, então UTC_TIMESTAMP() e CURRENT_TIMESTAMP coincidem aqui.
        const now = value.match(/^(?:CURRENT_TIMESTAMP|NOW|UTC_TIMESTAMP)(?:\((\d?)\))?$/i);
        if (now) return Number(now[1]) > 0 ? state.now : Math.floor(state.now / 1000) * 1000;
        if (/^FROM_UNIXTIME\(\?\)$/i.test(value)) return Number(nextParam()) * 1000;
        if (/^NULL$/i.test(value)) return null;
        if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
        if (/^-?\d+$/.test(value)) return Number(value);
        throw new Error(`Unsupported session value in motor test: ${value}`);
    }

    function storedSessionValue(column, value) {
        const spec = SESSION_COLUMNS[column];
        if (value === null || value === undefined) {
            if (spec.required) throw sqlError("ER_BAD_NULL_ERROR", `Column '${column}' cannot be null`);
            return null;
        }
        if (spec.datetime || spec.timestamp) {
            const milliseconds = value instanceof Date ? value.getTime() : value;
            if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
                throw new Error(`Use CURRENT_TIMESTAMP or FROM_UNIXTIME for '${column}' in motor test`);
            }
            return spec.datetime ? Math.round(milliseconds / 1000) * 1000 : milliseconds;
        }
        if (spec.integer) {
            const number = Number(value);
            if (typeof value === "boolean" || !Number.isInteger(number) || number < spec.min || number > spec.max) {
                throw sqlError("ER_WARN_DATA_OUT_OF_RANGE", `Out of range value for column '${column}'`);
            }
            return number;
        }
        if (spec.maxLength !== undefined && String(value).length > spec.maxLength) {
            throw sqlError("ER_DATA_TOO_LONG", `Data too long for column '${column}'`);
        }
        return value;
    }

    function sessionConditions(where, nextParam) {
        if (!where) return [];
        return where.split(/ AND /i).map((condition) => {
            const text = condition.trim();
            let match = text.match(/^([\w.]+) IS (NOT )?NULL$/i);
            if (match) {
                const key = sessionKey(match[1]);
                const negate = Boolean(match[2]);
                return (row) => (row[key] === null || row[key] === undefined) !== negate;
            }
            match = text.match(/^([\w.]+) IN ?\((.+)\)$/i);
            if (match) {
                const key = sessionKey(match[1]);
                const values = match[2].split(",").map((value) => String(sessionValue(value, nextParam)));
                return (row) => row[key] !== null && row[key] !== undefined && values.includes(String(row[key]));
            }
            match = text.match(/^([\w.]+) ?= ?(.+)$/);
            if (match) {
                const key = sessionKey(match[1]);
                const value = String(sessionValue(match[2], nextParam));
                return (row) => row[key] !== null && row[key] !== undefined && String(row[key]) === value;
            }
            throw new Error(`Unsupported session condition in motor test: ${text}`);
        });
    }

    function sessionClauses(sql, rest) {
        const match = rest.trim().match(
            /^(?:WHERE (.*?))?(?: ?ORDER BY ([\w.]+(?: (?:ASC|DESC))?(?:, ?[\w.]+(?: (?:ASC|DESC))?)*))?(?: ?LIMIT (\d+))?(?: ?FOR UPDATE)?$/i
        );
        if (!match) throw new Error(`Unexpected session query in motor test: ${sql}`);
        const [, where, orderBy, limit] = match;
        const ordering = (orderBy || "").split(",").filter(Boolean).map((item) => {
            const [column, direction] = item.trim().split(" ");
            return { key: sessionKey(column), descending: /DESC/i.test(direction || "") };
        });
        return { where, ordering, limit };
    }

    // Como no MySQL, NULL vem primeiro em ASC e por último em DESC.
    function compareSessionValues(a, b) {
        const left = a === null || a === undefined ? -Infinity : Number(a);
        const right = b === null || b === undefined ? -Infinity : Number(b);
        return left === right ? 0 : left < right ? -1 : 1;
    }

    function selectSessions(conditions, { ordering, limit }) {
        let rows = state.sessions.filter((row) => conditions.every((matches) => matches(row)));
        if (ordering.length) {
            rows = [...rows].sort((a, b) => {
                for (const { key, descending } of ordering) {
                    const order = compareSessionValues(a[key], b[key]) * (descending ? -1 : 1);
                    if (order !== 0) return order;
                }
                return 0;
            });
        }
        return limit === undefined ? rows : rows.slice(0, Number(limit));
    }

    function executeSessionQuery(sql, params) {
        let index = 0;
        const nextParam = () => {
            if (index >= params.length) throw new Error(`Missing parameter in motor test: ${sql}`);
            return params[index++];
        };
        const assertAllParamsUsed = () => {
            if (index !== params.length) throw new Error(`Unused parameters in motor test: ${sql}`);
        };

        let match = sql.match(/^INSERT (IGNORE )?INTO mabel_sessoes ?\(([^)]+)\) VALUES ?\((.+)\)$/i);
        if (match) {
            const columns = match[2].split(",").map(sessionColumn);
            const values = match[3].split(",");
            if (columns.length !== values.length) throw new Error(`Column count mismatch in motor test: ${sql}`);
            const session = Object.fromEntries(Object.keys(SESSION_COLUMNS).map((column) => [sessionKey(column), null]));
            Object.assign(session, { id: state.nextSessionId, criado_ms: state.now, atualizado_ms: state.now });
            columns.forEach((column, position) => {
                session[sessionKey(column)] = storedSessionValue(column, sessionValue(values[position], nextParam));
            });
            assertAllParamsUsed();
            const missing = Object.keys(SESSION_COLUMNS)
                .find((column) => SESSION_COLUMNS[column].required && !columns.includes(column));
            if (missing) throw sqlError("ER_NO_DEFAULT_FOR_FIELD", `Field '${missing}' doesn't have a default value`);
            const duplicate = session.command_id !== null
                && state.sessions.some((item) => String(item.command_id) === String(session.command_id));
            if (duplicate) {
                if (match[1]) return [{ insertId: 0, affectedRows: 0 }];
                throw sqlError("ER_DUP_ENTRY", "Duplicate entry for key 'uq_mabel_sessoes_command_id'");
            }
            state.nextSessionId = Math.max(state.nextSessionId, Number(session.id)) + 1;
            state.sessions.push(session);
            return [{ insertId: session.id, affectedRows: 1 }];
        }

        match = sql.match(/^UPDATE mabel_sessoes SET (.+?) (WHERE .+)$/i);
        if (match) {
            const assignments = match[1].split(",").map((assignment) => {
                const parts = assignment.trim().match(/^([\w.]+) ?= ?(.+)$/);
                if (!parts) throw new Error(`Unsupported session assignment in motor test: ${assignment}`);
                const column = sessionColumn(parts[1]);
                return [column, storedSessionValue(column, sessionValue(parts[2], nextParam))];
            });
            const clauses = sessionClauses(sql, match[2]);
            const conditions = sessionConditions(clauses.where, nextParam);
            assertAllParamsUsed();
            const rows = selectSessions(conditions, clauses);
            for (const row of rows) {
                row.atualizado_ms = state.now;
                for (const [column, value] of assignments) row[sessionKey(column)] = value;
            }
            return [{ affectedRows: rows.length }];
        }

        match = sql.match(/^SELECT .+? FROM mabel_sessoes\b(.*)$/i);
        if (match) {
            const rest = match[1].trim().replace(/^(?:AS )?(?!WHERE\b|ORDER\b|LIMIT\b|FOR\b)\w+ ?/i, "");
            const clauses = sessionClauses(sql, rest);
            const conditions = sessionConditions(clauses.where, nextParam);
            assertAllParamsUsed();
            return [selectSessions(conditions, clauses).map((row) => ({ ...row }))];
        }

        throw new Error(`Unexpected session query in motor test: ${sql}`);
    }

    async function execute(query, params = []) {
        const sql = query.replace(/\s+/g, " ").trim();
        assertTables(sql);
        failIfRequested(sql);

        if (/\bmabel_sessoes\b/.test(sql)) return executeSessionQuery(sql, params);

        if (sql.startsWith("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))")) {
            return [[{ agora_ms: `${state.now}.000` }]];
        }
        if (sql.startsWith("SELECT id FROM pets WHERE id = ? AND usuario_id = ?")) {
            const [petId, usuarioId] = params;
            return [state.pets[String(petId)] === String(usuarioId) ? [{ id: String(petId) }] : []];
        }
        if (sql.includes("FROM mabel_pet_associations WHERE pet_id = ?")) {
            const entry = Object.entries(state.associations)
                .find(([, association]) => association.pet_id === String(params[0]));
            return [entry ? [{ device_id: entry[0], pet_id: entry[1].pet_id, linked_ms: String(entry[1].linked_ms) }] : []];
        }
        if (sql.includes("FROM mabel_pet_associations WHERE device_id = ?")) {
            const association = state.associations[params[0]];
            return [association ? [{ device_id: params[0], pet_id: association.pet_id, linked_ms: String(association.linked_ms) }] : []];
        }
        if (sql.includes("FROM mabel_motor_commands WHERE device_id = ? AND pet_id = ? AND solicitado_em >= FROM_UNIXTIME(?)")) {
            const [deviceId, petId, fromSeconds] = params;
            const matches = state.commands.filter((command) => command.device_id === deviceId
                && command.pet_id === String(petId)
                && command.solicitado_ms >= fromSeconds * 1000);
            return [commandRow(matches[matches.length - 1])];
        }
        if (sql.startsWith("SELECT MAX(id) AS id FROM mabel_motor_commands WHERE device_id = ?")) {
            const ids = state.commands.filter((command) => command.device_id === params[0]).map((command) => command.id);
            return [[{ id: ids.length ? String(Math.max(...ids)) : null }]];
        }
        if (sql.includes("FROM mabel_motor_commands WHERE id = ?")) {
            return [commandRow(state.commands.find((command) => command.id === Number(params[0])))];
        }
        if (sql.startsWith("INSERT INTO mabel_motor_commands")) {
            const [deviceId, petId, usuarioId, ligado, intensidade, duracaoS] = params;
            const command = {
                id: state.nextCommandId++,
                device_id: deviceId,
                pet_id: String(petId),
                usuario_id: String(usuarioId),
                ligado,
                intensidade,
                duracao_s: duracaoS,
                status: "pendente",
                motivo: null,
                solicitado_ms: state.now,
                atualizado_ms: null
            };
            state.commands.push(command);
            return [{ insertId: command.id, affectedRows: 1 }];
        }
        if (sql.includes("SET status = 'substituido'")) {
            const [deviceId, insertId] = params;
            let affectedRows = 0;
            for (const command of state.commands) {
                if (command.device_id === deviceId && command.id < insertId && command.status === "pendente") {
                    Object.assign(command, { status: "substituido", atualizado_ms: state.now });
                    affectedRows++;
                }
            }
            return [{ affectedRows }];
        }
        if (sql.includes("SET status = 'aplicado'")) {
            const command = state.commands.find((item) => item.id === Number(params[0]) && item.status === "pendente");
            if (command) Object.assign(command, { status: "aplicado", motivo: "comando", atualizado_ms: state.now });
            return [{ affectedRows: command ? 1 : 0 }];
        }
        if (sql.includes("SET status = ?, motivo = ?")) {
            const [status, motivo, id] = params;
            const command = state.commands.find((item) => item.id === Number(id)
                && ["pendente", "aplicado"].includes(item.status));
            if (command) Object.assign(command, { status, motivo, atualizado_ms: state.now });
            return [{ affectedRows: command ? 1 : 0 }];
        }
        if (sql.startsWith("INSERT INTO mabel_motor_state (device_id) VALUES (?)")) {
            const current = state.motorState[params[0]];
            state.motorState[params[0]] = current
                ? { ...current, ultimo_contato_ms: state.now }
                : {
                    device_id: params[0],
                    command_id: null,
                    ligado: 0,
                    intensidade: 0,
                    fisico: 0,
                    motivo: null,
                    ultimo_contato_ms: state.now,
                    confirmado_ms: null
                };
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO mabel_motor_state (device_id, command_id")) {
            const [deviceId, commandId, ligado, intensidade, fisico, motivo] = params;
            state.motorState[deviceId] = {
                device_id: deviceId,
                command_id: commandId,
                ligado,
                intensidade,
                fisico,
                motivo,
                ultimo_contato_ms: state.now,
                confirmado_ms: state.now
            };
            return [{ affectedRows: 1 }];
        }
        if (sql.includes("FROM mabel_motor_state WHERE device_id = ?")) {
            const row = state.motorState[params[0]];
            return [row ? [{ ...row }] : []];
        }
        throw new Error(`Unexpected query in motor test: ${sql}`);
    }

    const pool = {
        execute,
        async getConnection() {
            let snapshot = null;
            return {
                execute,
                async beginTransaction() { snapshot = structuredClone(state); },
                async commit() { snapshot = null; },
                async rollback() { if (snapshot) state = snapshot; },
                release() {}
            };
        }
    };

    return {
        pool,
        get state() { return state; },
        advance(milliseconds) { state.now += milliseconds; },
        failOn(pattern, code = "ER_LOCK_WAIT_TIMEOUT") {
            failingQuery = pattern;
            failingCode = code;
        },
        seedSession(overrides = {}) {
            const row = {
                id: state.nextSessionId,
                usuario_id: "41",
                pet_id: "22",
                device_id: DEVICE_ID,
                command_id: null,
                tipo_sessao: "real",
                estado: "concluida",
                intensidade_geral: 40,
                motor1: 40,
                motor2: 40,
                motor3: 40,
                motor4: 40,
                motor5: 40,
                duracao_segundos: 60,
                fisico: 0,
                inicio_ms: state.now,
                termino_ms: state.now + 60000,
                criado_ms: state.now,
                atualizado_ms: state.now,
                ...overrides
            };
            state.nextSessionId = Math.max(state.nextSessionId, row.id) + 1;
            state.sessions.push(row);
            return row;
        },
        relink(deviceId, petId) {
            for (const key of Object.keys(state.associations)) {
                if (state.associations[key].pet_id === petId) delete state.associations[key];
            }
            state.associations[deviceId] = { pet_id: petId, linked_ms: Math.floor(state.now / 1000) * 1000 };
        }
    };
}

function createRouter(database, { deviceToken = TOKEN } = {}) {
    return createMabelMotorRouter({
        deviceToken,
        sessionMiddleware(req, res, next) { return next(); },
        pool: database.pool
    });
}

async function invoke(router, method, route, {
    body,
    query = {},
    session = { usuario: { id: "41" } },
    authorization
} = {}) {
    const handler = router.handlers.get(`${method} ${route}`);
    assert.ok(handler, `Handler ${method} ${route} exists`);
    const result = { status: 200, body: null, headers: {} };
    const res = {
        status(code) { result.status = code; return this; },
        json(payload) { result.body = payload; return this; },
        set(name, value) { result.headers[name] = value; return this; }
    };
    const req = {
        body,
        query,
        session,
        get(name) {
            return name.toLowerCase() === "authorization" ? authorization || "" : "";
        }
    };
    await handler(req, res, (error) => {
        result.status = 500;
        result.body = { sucesso: false, mensagem: "Erro interno ao processar a requisição.", erro: error?.code };
    });
    return result;
}

const device = { authorization: `Bearer ${TOKEN}` };

function pollConfig(router, deviceId = DEVICE_ID) {
    return invoke(router, "GET", "/config", { ...device, query: { device_id: deviceId } });
}

function confirm(router, body) {
    return invoke(router, "POST", "/motores/confirmacao", {
        ...device,
        body: { device_id: DEVICE_ID, fisico: false, ...body }
    });
}

function turnOn(router, intensidade = 40, duracaoS = 60, petId = "22") {
    return invoke(router, "POST", "/motores", {
        body: { pet_id: petId, ligado: true, intensidade, duracao_s: duracaoS }
    });
}

function turnOff(router, petId = "22") {
    return invoke(router, "POST", "/motores", { body: { pet_id: petId, ligado: false } });
}

function appStatus(router, petId = "22", session) {
    return invoke(router, "GET", "/motores", { query: { pet_id: petId }, ...(session ? { session } : {}) });
}

function ackApplied(router, comando, extra = {}) {
    return confirm(router, {
        command_id: comando.command_id,
        resultado: "aplicado",
        motores: { ligado: comando.ligado, intensidade: comando.intensidade },
        motivo: "comando",
        ...extra
    });
}

function ackInterrupted(router, commandId, motivo, extra = {}) {
    return confirm(router, {
        command_id: commandId,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo,
        ...extra
    });
}

// Faz o tempo passar com a ESP32 consultando no intervalo normal, sem lacunas de comunicação.
async function keepPolling(router, database, milliseconds, deviceId = DEVICE_ID) {
    for (let elapsed = 0; elapsed < milliseconds;) {
        const step = Math.min(POLL_INTERVAL_MS, milliseconds - elapsed);
        database.advance(step);
        elapsed += step;
        await pollConfig(router, deviceId);
    }
}

// Valores propostos para as colunas VARCHAR de mabel_sessoes:
// tipo_sessao 'real' (até 30); estado 'ativa' | 'concluida' | 'interrompida' | 'sem_confirmacao' (até 20).
// termino_em só recebe horário quando a confirmação recebida marca o próprio instante do término
// (desligamento, nova intensidade ou duração); quando o instante é desconhecido, fica NULL.
const SESSION_TYPE = "real";

function sessionSummary(session) {
    const nullableNumber = (value) => (value === null || value === undefined ? null : Number(value));
    return {
        usuario_id: String(session.usuario_id),
        pet_id: String(session.pet_id),
        device_id: session.device_id,
        command_id: String(session.command_id),
        tipo_sessao: session.tipo_sessao,
        estado: session.estado,
        intensidade_geral: Number(session.intensidade_geral),
        motores: [1, 2, 3, 4, 5].map((motor) => Number(session[`motor${motor}`])),
        duracao_segundos: Number(session.duracao_segundos),
        fisico: nullableNumber(session.fisico),
        inicio_ms: nullableNumber(session.inicio_ms),
        termino_ms: nullableNumber(session.termino_ms)
    };
}

function openSessions(database) {
    return database.state.sessions.filter((session) => session.estado === "ativa");
}

// DATETIME guarda segundos: o horário registrado deve ser o da confirmação, arredondado ao segundo.
function assertConfirmationTime(actualMs, confirmationMs, message) {
    assert.equal(typeof actualMs, "number", message);
    assert.equal(actualMs % 1000, 0, `${message} (precisão de segundos)`);
    assert.ok(Math.abs(actualMs - confirmationMs) < 1000, `${message}: ${actualMs} vs ${confirmationMs}`);
}

test("1. ligar pelo aplicativo cria um comando pendente que a ESP32 recebe e confirma", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    assert.equal((await pollConfig(router)).status, 200);

    const created = await turnOn(router, 40, 60);
    assert.equal(created.status, 201);
    assert.equal(created.body.device_id, DEVICE_ID);
    assert.equal(created.body.comando.estado, "pendente");
    assert.equal(created.body.comando.ligado, true);
    assert.equal(created.body.comando.intensidade, 40);
    assert.equal(created.headers["Cache-Control"], "private, no-store");

    const before = await appStatus(router);
    assert.equal(before.body.solicitado.estado, "pendente");
    assert.equal(before.body.confirmado, null, "receber o comando não significa aplicá-lo");

    database.advance(1000);
    const config = await pollConfig(router);
    assert.equal(config.status, 200);
    assert.equal(config.body.command_id, created.body.comando.command_id);
    assert.deepEqual(config.body.motores, { ligado: true, intensidade: 40, duracao_restante_ms: 59000 });
    assert.equal(config.body.estado_comando, "pendente");

    const ack = await confirm(router, {
        command_id: config.body.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.estado_comando, "aplicado");
    assert.equal(database.state.commands[0].status, "aplicado");
});

test("2. desligar pelo aplicativo é servido à ESP32 e confirmado como desligado", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    const on = await turnOn(router);
    await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });

    database.advance(2000);
    const off = await turnOff(router);
    assert.equal(off.status, 201);
    assert.equal(off.body.comando.ligado, false);
    assert.equal(off.body.comando.intensidade, 0);

    const config = await pollConfig(router);
    assert.equal(config.body.command_id, off.body.comando.command_id);
    assert.deepEqual(config.body.motores, { ligado: false, intensidade: 0, duracao_restante_ms: 0 });

    const ack = await confirm(router, {
        command_id: off.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comando"
    });
    assert.equal(ack.status, 200);
    const status = await appStatus(router);
    assert.equal(status.body.solicitado.estado, "aplicado");
    assert.equal(status.body.confirmado.ligado, false);
});

test("3. alterar a intensidade substitui o comando pendente e recusa a confirmação do comando antigo", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    const first = await turnOn(router, 40);
    database.advance(500);
    const second = await turnOn(router, 70);
    assert.equal(database.state.commands[0].status, "substituido");

    const config = await pollConfig(router);
    assert.equal(config.body.command_id, second.body.comando.command_id);
    assert.equal(config.body.motores.intensidade, 70);

    const staleAck = await confirm(router, {
        command_id: first.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(staleAck.status, 409);

    const mismatch = await confirm(router, {
        command_id: second.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(mismatch.status, 409, "o estado confirmado precisa ser igual ao solicitado");

    const ack = await confirm(router, {
        command_id: second.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 70 },
        motivo: "comando"
    });
    assert.equal(ack.status, 200);
    assert.equal((await appStatus(router)).body.confirmado.intensidade, 70);
});

test("4. comandos e confirmações inválidos são recusados sem persistir nada", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    const invalidCommands = [
        { pet_id: "22", ligado: true, intensidade: 101, duracao_s: 60 },
        { pet_id: "22", ligado: true, intensidade: 0, duracao_s: 60 },
        { pet_id: "22", ligado: true, intensidade: 40.5, duracao_s: 60 },
        { pet_id: "22", ligado: true, intensidade: 40, duracao_s: 4 },
        { pet_id: "22", ligado: true, intensidade: 40, duracao_s: 601 },
        { pet_id: "22", ligado: true, intensidade: 40 },
        { pet_id: "22", ligado: "sim" },
        { pet_id: "22", ligado: false, intensidade: 10 },
        { pet_id: "22", ligado: false, usuario_id: "77" },
        { pet_id: "abc", ligado: false },
        []
    ];
    for (const body of invalidCommands) {
        const response = await invoke(router, "POST", "/motores", { body });
        assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(database.state.commands.length, 0);

    const on = await turnOn(router);
    const invalidConfirmations = [
        { command_id: on.body.comando.command_id, resultado: "ok", motores: { ligado: false, intensidade: 0 }, motivo: "comando" },
        { command_id: Number(on.body.comando.command_id), resultado: "aplicado", motores: { ligado: true, intensidade: 40 }, motivo: "comando" },
        { command_id: on.body.comando.command_id, resultado: "aplicado", motores: { ligado: true, intensidade: 0 }, motivo: "comando" },
        { command_id: on.body.comando.command_id, resultado: "interrompido", motores: { ligado: true, intensidade: 40 }, motivo: "duracao" },
        { command_id: null, resultado: "aplicado", motores: { ligado: false, intensidade: 0 }, motivo: "comando" }
    ];
    for (const body of invalidConfirmations) {
        const response = await confirm(router, body);
        assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(database.state.commands[0].status, "pendente");

    const rejected = await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "rejeitado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "invalido"
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.estado_comando, "rejeitado");
    assert.deepEqual((await pollConfig(router)).body.motores, { ligado: false, intensidade: 0, duracao_restante_ms: 0 });
    assert.equal((await appStatus(router)).body.solicitado.estado, "rejeitado");
});

test("5. perda de comunicação deixa a ESP32 offline, bloqueia ligar e registra a interrupção", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    const on = await turnOn(router);
    await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });

    database.advance(OFFLINE_AFTER_MS + 1);
    const offline = await appStatus(router);
    assert.equal(offline.body.online, false);
    const blocked = await turnOn(router, 50);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.mensagem, /offline/);
    assert.equal((await turnOff(router)).status, 201, "desligar continua disponível offline");

    const interrupted = await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo: "comunicacao"
    });
    assert.equal(interrupted.status, 200);
    assert.equal(database.state.commands[0].status, "interrompido");
    const status = await appStatus(router);
    assert.equal(status.body.online, true);
    assert.equal(status.body.confirmado.ligado, false);
    assert.equal(status.body.confirmado.motivo, "comunicacao");
});

test("6. reinício, comandos antigos e duração esgotada nunca religam os motores", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const boot = await confirm(router, {
        command_id: null,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo: "reinicio"
    });
    assert.equal(boot.status, 200);

    const on = await turnOn(router, 40, 60);
    await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    const afterReboot = await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo: "reinicio"
    });
    assert.equal(afterReboot.body.estado_comando, "interrompido");
    assert.equal((await pollConfig(router)).body.motores.ligado, false);

    database.advance(1000);
    const late = await turnOn(router, 30, 60);
    database.advance(START_WINDOW_MS + 1);
    const expired = await pollConfig(router);
    assert.equal(expired.body.command_id, late.body.comando.command_id);
    assert.equal(expired.body.estado_comando, "expirado");
    assert.equal(expired.body.motores.ligado, false);
    assert.equal(database.state.commands[1].status, "expirado");
    const lateAck = await confirm(router, {
        command_id: late.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 30 },
        motivo: "comando"
    });
    assert.equal(lateAck.status, 409);

    const short = await turnOn(router, 20, 5);
    await pollConfig(router);
    await confirm(router, {
        command_id: short.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 20 },
        motivo: "comando"
    });
    database.advance(5000);
    const finished = await pollConfig(router);
    assert.equal(finished.body.motores.ligado, false);
    assert.equal(finished.body.estado_comando, "concluido");
});

test("7. um dispositivo não recebe nem confirma comandos de outro dispositivo ou de associação anterior", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    await pollConfig(router, OTHER_DEVICE_ID);
    const on = await turnOn(router, 40, 60, "22");

    const other = await pollConfig(router, OTHER_DEVICE_ID);
    assert.equal(other.body.command_id, null);
    assert.equal(other.body.motores.ligado, false);

    const crossAck = await invoke(router, "POST", "/motores/confirmacao", {
        ...device,
        body: {
            device_id: OTHER_DEVICE_ID,
            command_id: on.body.comando.command_id,
            resultado: "aplicado",
            motores: { ligado: true, intensidade: 40 },
            fisico: false,
            motivo: "comando"
        }
    });
    assert.equal(crossAck.status, 404);
    assert.equal(database.state.commands[0].status, "pendente");

    database.advance(2000);
    database.relink(DEVICE_ID, "23");
    database.advance(2000);
    const relinked = await pollConfig(router);
    assert.equal(relinked.body.command_id, null, "comandos do pet anterior não são servidos");
    const staleAck = await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 40 },
        motivo: "comando"
    });
    assert.equal(staleAck.status, 409);
});

test("8. sem sessão, sem token ou com pet de outra conta o controle é negado", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    assert.equal((await invoke(router, "POST", "/motores", {
        session: {},
        body: { pet_id: "22", ligado: false }
    })).status, 401);
    assert.equal((await appStatus(router, "22", {})).status, 401);
    assert.equal((await turnOn(router, 40, 60, "99")).status, 404);
    assert.equal((await appStatus(router, "99")).status, 404);
    assert.equal(database.state.commands.length, 0);

    assert.equal((await invoke(router, "GET", "/config", { query: { device_id: DEVICE_ID } })).status, 401);
    assert.equal((await invoke(router, "GET", "/config", {
        query: { device_id: DEVICE_ID },
        authorization: `Bearer ${"x".repeat(TOKEN.length)}`
    })).status, 401);
    assert.equal((await invoke(router, "POST", "/motores/confirmacao", {
        body: { device_id: DEVICE_ID, command_id: null, resultado: "interrompido", motores: { ligado: false, intensidade: 0 }, fisico: false, motivo: "reinicio" }
    })).status, 401);

    const unconfigured = createRouter(database, { deviceToken: "" });
    assert.equal((await pollConfig(unconfigured)).status, 503);

    const unassociated = await pollConfig(router, "mabel-esp32-99");
    assert.equal(unassociated.status, 403);
    assert.deepEqual(unassociated.body.motores, { ligado: false, intensidade: 0, duracao_restante_ms: 0 });
});

test("9. o aplicativo vê o estado solicitado separado do confirmado e oculta confirmações de associação anterior", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);
    await confirm(router, {
        command_id: null,
        resultado: "interrompido",
        motores: { ligado: false, intensidade: 0 },
        motivo: "reinicio"
    });

    const on = await turnOn(router, 55, 120);
    let status = await appStatus(router);
    assert.equal(status.body.online, true);
    assert.equal(status.body.solicitado.estado, "pendente");
    assert.equal(status.body.confirmado.ligado, false);
    assert.equal(status.body.confirmado.motivo, "reinicio");

    await confirm(router, {
        command_id: on.body.comando.command_id,
        resultado: "aplicado",
        motores: { ligado: true, intensidade: 55 },
        motivo: "comando"
    });
    status = await appStatus(router);
    assert.equal(status.body.solicitado.estado, "aplicado");
    assert.deepEqual(
        { ligado: status.body.confirmado.ligado, intensidade: status.body.confirmado.intensidade, fisico: status.body.confirmado.fisico },
        { ligado: true, intensidade: 55, fisico: false }
    );

    database.advance(3000);
    database.relink(DEVICE_ID, "23");
    const otherPet = await appStatus(router, "23");
    assert.equal(otherPet.body.solicitado, null);
    assert.equal(otherPet.body.confirmado, null);
    const noDevice = await appStatus(router, "22");
    assert.equal(noDevice.body.tem_associacao, false);
});

test("o esquema ausente é informado como indisponível em vez de erro interno", async () => {
    const router = createRouter(createDatabase({ missingTables: true }));
    const config = await pollConfig(router);
    assert.equal(config.status, 503);
    assert.deepEqual(config.body.motores, { ligado: false, intensidade: 0, duracao_restante_ms: 0 });
    assert.equal((await appStatus(router)).status, 503);
});

test("10. a sessão só é criada quando a ESP32 confirma a aplicação do comando de ligar", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 60);
    assert.equal(on.status, 201);
    assert.equal(database.state.sessions.length, 0, "o clique em Ligar motores não cria sessão");
    database.advance(1000);
    await pollConfig(router);
    assert.equal(database.state.sessions.length, 0, "a ESP32 receber o comando não cria sessão");

    database.advance(500);
    const ack = await ackApplied(router, on.body.comando);
    assert.equal(ack.status, 200);
    assert.equal(database.state.sessions.length, 1);
    const { inicio_ms: inicioMs, ...session } = sessionSummary(database.state.sessions[0]);
    assert.deepEqual(session, {
        usuario_id: "41",
        pet_id: "22",
        device_id: DEVICE_ID,
        command_id: on.body.comando.command_id,
        tipo_sessao: SESSION_TYPE,
        estado: "ativa",
        intensidade_geral: 40,
        motores: [40, 40, 40, 40, 40],
        duracao_segundos: 60,
        fisico: 0,
        termino_ms: null
    });
    assertConfirmationTime(inicioMs, database.state.now, "o início é o horário da confirmação da ESP32");
});

test("11. a sessão registra fisico = 0 em simulação e fisico = 1 no acionamento físico", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const simulated = await turnOn(router, 30, 60);
    await ackApplied(router, simulated.body.comando);
    database.advance(1000);
    const off = await turnOff(router);
    await ackApplied(router, off.body.comando);

    database.advance(1000);
    const physical = await turnOn(router, 60, 60);
    await ackApplied(router, physical.body.comando, { fisico: true });

    assert.deepEqual(
        database.state.sessions.map((session) => [String(session.command_id), Number(session.fisico)]),
        [[simulated.body.comando.command_id, 0], [physical.body.comando.command_id, 1]]
    );
});

test("12. confirmações repetidas do mesmo comando não duplicam nem alteram a sessão", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 60);
    await ackApplied(router, on.body.comando);
    assert.equal(database.state.sessions.length, 1);
    const started = sessionSummary(database.state.sessions[0]);

    await keepPolling(router, database, 2000);
    const repeated = await ackApplied(router, on.body.comando);
    assert.equal(repeated.status, 200, "a confirmação reenviada pela ESP32 continua aceita");
    assert.equal(repeated.body.estado_comando, "aplicado");
    assert.equal(database.state.sessions.length, 1);
    assert.deepEqual(sessionSummary(database.state.sessions[0]), started, "o início não é reiniciado");

    await keepPolling(router, database, 58000);
    await ackInterrupted(router, on.body.comando.command_id, "duracao");
    const finished = sessionSummary(database.state.sessions[0]);
    assert.equal(finished.estado, "concluida");
    assertConfirmationTime(finished.termino_ms, database.state.now, "o término é o horário da confirmação");

    await keepPolling(router, database, 1000);
    const repeatedInterruption = await ackInterrupted(router, on.body.comando.command_id, "duracao");
    assert.equal(repeatedInterruption.status, 200);
    assert.equal(database.state.sessions.length, 1);
    assert.deepEqual(sessionSummary(database.state.sessions[0]), finished, "o término não é sobrescrito");
});

test("13. a confirmação do desligamento encerra a sessão ativa sem criar outra", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 120);
    await ackApplied(router, on.body.comando);
    await keepPolling(router, database, 20000);

    const off = await turnOff(router);
    assert.notEqual(off.body.comando.command_id, on.body.comando.command_id, "desligar é um comando próprio");
    assert.equal(openSessions(database).length, 1, "o clique em Desligar não encerra a sessão");
    await pollConfig(router);
    database.advance(500);
    const ack = await ackApplied(router, off.body.comando);
    assert.equal(ack.status, 200);

    assert.equal(database.state.sessions.length, 1);
    assert.equal(
        database.state.sessions.some((session) => String(session.command_id) === off.body.comando.command_id),
        false
    );
    const closed = sessionSummary(database.state.sessions[0]);
    assert.equal(closed.command_id, on.body.comando.command_id);
    assert.equal(closed.estado, "interrompida");
    assertConfirmationTime(closed.termino_ms, database.state.now, "o término é o horário da confirmação do desligamento");

    database.advance(1000);
    assert.equal((await ackApplied(router, off.body.comando)).status, 200);
    const offAgain = await turnOff(router);
    await pollConfig(router);
    await ackApplied(router, offAgain.body.comando);
    assert.equal(database.state.sessions.length, 1, "desligar sem sessão ativa não cria sessão");
    assert.deepEqual(sessionSummary(database.state.sessions[0]), closed);
});

test("14. interrupções confirmadas por duração e por comunicação atualizam a sessão existente", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const short = await turnOn(router, 20, 5);
    await ackApplied(router, short.body.comando);
    await keepPolling(router, database, 5000);
    const byDuration = await ackInterrupted(router, short.body.comando.command_id, "duracao");
    assert.equal(byDuration.status, 200);
    assert.equal(database.state.sessions.length, 1);
    const concluded = sessionSummary(database.state.sessions[0]);
    assert.equal(concluded.estado, "concluida");
    assertConfirmationTime(concluded.termino_ms, database.state.now, "o término por duração é o horário da confirmação");
    assert.equal(database.state.commands[0].motivo, "duracao", "o motivo técnico fica no histórico de comandos");

    database.advance(1000);
    const on = await turnOn(router, 50, 120);
    await ackApplied(router, on.body.comando);
    database.advance(OFFLINE_AFTER_MS + 1);
    // A ESP32 desligou sozinha ao perder a comunicação e só informa isso quando reconecta.
    const byCommunication = await ackInterrupted(router, on.body.comando.command_id, "comunicacao");
    assert.equal(byCommunication.status, 200);
    assert.equal(database.state.sessions.length, 2);
    const interrupted = sessionSummary(database.state.sessions[1]);
    assert.equal(interrupted.command_id, on.body.comando.command_id);
    assert.equal(interrupted.estado, "interrompida");
    assert.equal(interrupted.termino_ms, null, "a confirmação tardia não informa quando os motores pararam");
    assert.equal(interrupted.fisico, 0);
    assert.equal(database.state.commands[1].motivo, "comunicacao");
    assert.equal(openSessions(database).length, 0);
});

test("15. o reinício da ESP32 encerra a sessão ativa mesmo quando a confirmação chega sem command_id", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 120);
    await ackApplied(router, on.body.comando);
    await keepPolling(router, database, 3000);

    // Ao ligar, o firmware envia primeiro uma interrupção por reinício com command_id null.
    const boot = await ackInterrupted(router, null, "reinicio");
    assert.equal(boot.status, 200);
    assert.equal(database.state.sessions.length, 1);
    const closed = sessionSummary(database.state.sessions[0]);
    assert.equal(closed.estado, "interrompida");
    assert.equal(closed.termino_ms, null, "o firmware não informa o instante do reinício");

    // Na primeira consulta após o reinício, o comando anterior também é informado como interrompido.
    database.advance(1000);
    await pollConfig(router);
    const baseline = await ackInterrupted(router, on.body.comando.command_id, "reinicio");
    assert.equal(baseline.status, 200);
    assert.equal(database.state.sessions.length, 1);
    assert.deepEqual(sessionSummary(database.state.sessions[0]), closed);
});

test("16. a ausência de comunicação gera só um encerramento inferido, sem horário nem confirmação física", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 120);
    await ackApplied(router, on.body.comando);
    await keepPolling(router, database, 6000);
    assert.equal((await appStatus(router)).body.online, true);
    assert.equal(database.state.sessions[0]?.estado, "ativa", "com a ESP32 online nada é inferido");

    database.advance(OFFLINE_AFTER_MS + 1);
    const offline = await appStatus(router);
    assert.equal(offline.body.online, false);
    const inferred = sessionSummary(database.state.sessions[0]);
    assert.equal(inferred.estado, "sem_confirmacao");
    assert.equal(inferred.termino_ms, null, "o horário do término não é inventado");
    assert.equal(inferred.fisico, 0, "a inferência não altera o registro físico");
    assert.equal(database.state.commands[0].status, "aplicado", "nenhuma confirmação é inventada nos comandos");

    const confirmed = await ackInterrupted(router, on.body.comando.command_id, "comunicacao");
    assert.equal(confirmed.status, 200);
    const afterConfirmation = sessionSummary(database.state.sessions[0]);
    assert.equal(afterConfirmation.estado, "interrompida", "a confirmação da ESP32 substitui a inferência");
    assert.equal(afterConfirmation.termino_ms, null);

    // A ESP32 volta sem que o aplicativo tenha consultado: o servidor percebe a lacuna na consulta seguinte.
    database.advance(1000);
    const second = await turnOn(router, 50, 120);
    await ackApplied(router, second.body.comando);
    database.advance(OFFLINE_AFTER_MS + 1);
    const off = await turnOff(router);
    assert.equal(off.status, 201);
    await pollConfig(router);
    assert.equal(database.state.sessions[1]?.estado, "sem_confirmacao", "a lacuna de comunicação é só uma inferência");
    assert.equal(database.state.sessions[1].termino_ms, null);

    // O firmware substitui a interrupção pendente pela confirmação do desligamento.
    await ackApplied(router, off.body.comando);
    const closed = sessionSummary(database.state.sessions[1]);
    assert.equal(closed.estado, "interrompida");
    assert.equal(closed.termino_ms, null, "o desligamento confirma que parou, não quando parou");
    assert.equal(database.state.sessions.length, 2);
});

test("17. comandos rejeitados, expirados, substituídos ou nunca aplicados não geram sessões", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const rejected = await turnOn(router, 40, 60);
    await pollConfig(router);
    const rejection = await confirm(router, {
        command_id: rejected.body.comando.command_id,
        resultado: "rejeitado",
        motores: { ligado: false, intensidade: 0 },
        motivo: "invalido"
    });
    assert.equal(rejection.status, 200);

    database.advance(1000);
    const first = await turnOn(router, 40, 60);
    database.advance(500);
    const second = await turnOn(router, 70, 60);
    assert.equal((await ackApplied(router, first.body.comando)).status, 409);
    assert.equal((await ackApplied(router, { ...second.body.comando, intensidade: 40 })).status, 409);
    const notApplied = await ackInterrupted(router, second.body.comando.command_id, "reinicio");
    assert.equal(notApplied.status, 200, "comando pendente interrompido antes de ser aplicado");
    assert.equal(database.state.commands[2].status, "interrompido");

    database.advance(1000);
    const late = await turnOn(router, 30, 60);
    database.advance(START_WINDOW_MS + 1);
    assert.equal((await pollConfig(router)).body.estado_comando, "expirado");
    assert.equal((await ackApplied(router, late.body.comando)).status, 409);

    assert.equal((await ackApplied(router, { ...late.body.comando, ligado: false, intensidade: 0 })).status, 409);
    assert.equal(database.state.sessions.length, 0);
});

test("18. um novo comando de ligar aplicado durante a sessão encerra a anterior antes de abrir a nova", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const first = await turnOn(router, 40, 120);
    await ackApplied(router, first.body.comando);
    database.advance(2000);
    const second = await turnOn(router, 70, 120);
    assert.equal(database.state.sessions.length, 1, "o novo comando ainda não foi aplicado");
    assert.equal(openSessions(database).length, 1);

    await pollConfig(router);
    // O firmware aplica a nova intensidade sem enviar interrupção do comando anterior.
    await ackApplied(router, second.body.comando);
    assert.equal(database.state.sessions.length, 2);
    const [previous, current] = database.state.sessions.map(sessionSummary);
    assert.equal(previous.command_id, first.body.comando.command_id);
    assert.equal(previous.estado, "interrompida");
    assertConfirmationTime(previous.termino_ms, database.state.now, "a troca acontece na confirmação do novo comando");
    assert.equal(current.command_id, second.body.comando.command_id);
    assert.equal(current.estado, "ativa");
    assert.equal(current.intensidade_geral, 70);
    assert.deepEqual(current.motores, [70, 70, 70, 70, 70]);
    assert.deepEqual(openSessions(database).map((session) => String(session.command_id)), [second.body.comando.command_id]);
});

test("19. o histórico continua associado ao pet original após a troca de dispositivo", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const original = await turnOn(router, 40, 120, "22");
    await ackApplied(router, original.body.comando);
    assert.equal(database.state.sessions.length, 1);
    const beforeRelink = sessionSummary(database.state.sessions[0]);

    database.advance(2000);
    database.relink(DEVICE_ID, "23");
    database.advance(2000);
    await pollConfig(router);
    // O firmware desliga ao não receber comando e informa a interrupção do comando antigo, que continua recusada.
    const stale = await ackInterrupted(router, original.body.comando.command_id, "recusado_servidor");
    assert.equal(stale.status, 409);
    assert.deepEqual(sessionSummary(database.state.sessions[0]), beforeRelink, "confirmação recusada não altera a sessão");

    const otherPet = await turnOn(router, 35, 60, "23");
    await ackApplied(router, otherPet.body.comando);
    assert.equal(
        database.state.sessions[0].termino_ms,
        null,
        "o término da sessão da associação anterior não é deduzido da confirmação de outro pet"
    );

    database.relink(OTHER_DEVICE_ID, "22");
    database.advance(2000);
    await pollConfig(router, OTHER_DEVICE_ID);
    const newDevice = await turnOn(router, 45, 60, "22");
    assert.equal(newDevice.body.device_id, OTHER_DEVICE_ID);
    await invoke(router, "POST", "/motores/confirmacao", {
        ...device,
        body: {
            device_id: OTHER_DEVICE_ID,
            command_id: newDevice.body.comando.command_id,
            resultado: "aplicado",
            motores: { ligado: true, intensidade: 45 },
            fisico: false,
            motivo: "comando"
        }
    });

    assert.deepEqual(
        database.state.sessions.map((session) => {
            const { pet_id: petId, usuario_id: usuarioId, device_id: deviceId, command_id: commandId } = sessionSummary(session);
            return [petId, usuarioId, deviceId, commandId];
        }),
        [
            ["22", "41", DEVICE_ID, original.body.comando.command_id],
            ["23", "41", DEVICE_ID, otherPet.body.comando.command_id],
            ["22", "41", OTHER_DEVICE_ID, newDevice.body.comando.command_id]
        ]
    );
});

test("20. falhas ao gravar a sessão desfazem a confirmação inteira", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    await pollConfig(router);

    const on = await turnOn(router, 40, 60);
    const beforeApply = structuredClone(database.state);
    database.failOn(/^INSERT (IGNORE )?INTO mabel_sessoes/i);
    const failedApply = await ackApplied(router, on.body.comando);
    assert.equal(failedApply.status, 500);
    assert.deepEqual(database.state, beforeApply, "comando, estado confirmado e sessões voltam ao estado anterior");

    database.failOn(null);
    assert.equal((await ackApplied(router, on.body.comando)).status, 200);
    assert.equal(database.state.sessions.length, 1);

    database.advance(2000);
    const off = await turnOff(router);
    await pollConfig(router);
    const beforeClose = structuredClone(database.state);
    database.failOn(/^UPDATE mabel_sessoes/i);
    const failedClose = await ackApplied(router, off.body.comando);
    assert.equal(failedClose.status, 500);
    assert.deepEqual(database.state, beforeClose);
    assert.equal(openSessions(database).length, 1);
});

function listSessions(router, petId = "22", session) {
    return invoke(router, "GET", "/sessoes", { query: { pet_id: petId }, ...(session ? { session } : {}) });
}

const HISTORY_ENTRY_KEYS = [
    "id", "tipo_sessao", "estado", "encerramento", "device_id", "command_id", "fisico",
    "intensidade_geral", "motores", "duracao_solicitada_s", "inicio_em", "termino_em", "criado_em"
].sort();

test("21. o histórico exige sessão web autenticada e um pet_id válido", async () => {
    const database = createDatabase();
    database.seedSession();
    const router = createRouter(database);

    const anonymous = await listSessions(router, "22", {});
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.sessoes, undefined);
    const deviceOnly = await invoke(router, "GET", "/sessoes", { ...device, session: {}, query: { pet_id: "22" } });
    assert.equal(deviceOnly.status, 401, "o token da ESP32 não substitui a sessão web");

    assert.equal((await invoke(router, "GET", "/sessoes", { query: {} })).status, 400, "pet_id ausente");
    for (const petId of ["", "abc", "0", "-3", "1.5", " 22", ["22", "23"], "9223372036854775808"]) {
        const response = await listSessions(router, petId);
        assert.equal(response.status, 400, JSON.stringify(petId));
        assert.equal(response.body.sessoes, undefined);
    }
});

test("22. o histórico de outro usuário não é revelado, mesmo manipulando o pet_id", async () => {
    const database = createDatabase();
    database.seedSession({ pet_id: "99", usuario_id: "77", device_id: OTHER_DEVICE_ID });
    database.seedSession({ pet_id: "22", usuario_id: "77" });
    const own = database.seedSession({ pet_id: "22", usuario_id: "41" });
    const router = createRouter(database);

    for (const petId of ["99", "12345"]) {
        const response = await listSessions(router, petId);
        assert.equal(response.status, 404, petId);
        assert.equal(response.body.sessoes, undefined);
    }
    const mine = await listSessions(router, "22");
    assert.deepEqual(mine.body.sessoes.map((session) => session.id), [String(own.id)], "só registros do próprio usuário");

    const otherUser = { usuario: { id: "77" } };
    assert.equal((await listSessions(router, "22", otherUser)).status, 404);
    assert.equal((await listSessions(router, "99", otherUser)).body.sessoes.length, 1);
});

test("23. o histórico é ordenado do mais recente e continua disponível após a desassociação", async () => {
    const database = createDatabase();
    const base = LINKED_AT_MS;
    const first = database.seedSession({ criado_ms: base + 10000, inicio_ms: base + 10000 });
    const inferred = database.seedSession({
        criado_ms: base + 30000,
        inicio_ms: base + 30000,
        estado: "sem_confirmacao",
        termino_ms: null
    });
    const middle = database.seedSession({ criado_ms: base + 20000, inicio_ms: base + 20000, device_id: OTHER_DEVICE_ID });
    const tie = database.seedSession({ criado_ms: base + 30000, inicio_ms: base + 30000, estado: "interrompida" });
    database.seedSession({ pet_id: "23", criado_ms: base + 40000 });
    const router = createRouter(database);

    database.advance(2000);
    database.relink(DEVICE_ID, "23");
    assert.equal((await appStatus(router, "22")).body.tem_associacao, false);

    const response = await listSessions(router, "22");
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.equal(response.body.pet_id, "22");
    assert.equal(response.body.limite, 50);
    assert.equal(response.body.mais_registros, false);
    assert.deepEqual(
        response.body.sessoes.map((session) => session.id),
        [tie, inferred, middle, first].map((session) => String(session.id))
    );
    assert.deepEqual(
        response.body.sessoes.map((session) => [session.estado, session.encerramento, session.device_id]),
        [
            ["interrompida", "confirmado", DEVICE_ID],
            ["sem_confirmacao", "inferido", DEVICE_ID],
            ["concluida", "confirmado", OTHER_DEVICE_ID],
            ["concluida", "confirmado", DEVICE_ID]
        ]
    );
    assert.equal(response.body.sessoes[1].termino_em, null, "a inferência não ganha horário de término");
});

test("24. o histórico vazio e o limite fixo são informados explicitamente", async () => {
    const database = createDatabase();
    const router = createRouter(database);

    const empty = await listSessions(router, "23");
    assert.equal(empty.status, 200);
    assert.deepEqual(
        { ...empty.body },
        { sucesso: true, pet_id: "23", limite: 50, mais_registros: false, sessoes: [] }
    );

    for (let index = 0; index < 50; index++) database.seedSession({ criado_ms: LINKED_AT_MS + index * 1000 });
    const full = await listSessions(router, "22");
    assert.equal(full.body.sessoes.length, 50);
    assert.equal(full.body.mais_registros, false);

    database.seedSession({ criado_ms: LINKED_AT_MS + 60 * 1000 });
    const more = await listSessions(router, "22");
    assert.equal(more.body.sessoes.length, 50);
    assert.equal(more.body.mais_registros, true);
    assert.equal(more.body.sessoes[0].id, "51", "o mais recente entra e o mais antigo fica de fora");
    assert.equal(more.body.sessoes[49].id, "2");
});

test("25. registros simulados, físicos e incompletos são apresentados sem inventar valores", async () => {
    const database = createDatabase();
    const router = createRouter(database);
    database.seedSession({
        criado_ms: LINKED_AT_MS - 86400000,
        estado: "finalizada",
        command_id: null,
        fisico: null,
        inicio_ms: null,
        termino_ms: null
    });
    await pollConfig(router);

    const simulated = await turnOn(router, 30, 60);
    database.advance(500);
    await ackApplied(router, simulated.body.comando);
    const startedMs = database.state.now;
    await keepPolling(router, database, 6000);
    const off = await turnOff(router);
    await pollConfig(router);
    await ackApplied(router, off.body.comando);
    const stoppedMs = database.state.now;

    database.advance(1000);
    const physical = await turnOn(router, 60, 120);
    await ackApplied(router, physical.body.comando, { fisico: true });

    const response = await listSessions(router, "22");
    assert.equal(response.status, 200);
    const [active, finished, legacy] = response.body.sessoes;
    for (const session of response.body.sessoes) {
        assert.deepEqual(Object.keys(session).sort(), HISTORY_ENTRY_KEYS);
    }

    // UTC_TIMESTAMP() trunca no segundo: o horário registrado nunca fica depois da confirmação.
    const toSecondIso = (milliseconds) => new Date(Math.floor(milliseconds / 1000) * 1000).toISOString();
    assert.deepEqual(finished, {
        id: String(database.state.sessions[1].id),
        tipo_sessao: "real",
        estado: "interrompida",
        encerramento: "confirmado",
        device_id: DEVICE_ID,
        command_id: simulated.body.comando.command_id,
        fisico: false,
        intensidade_geral: 30,
        motores: [30, 30, 30, 30, 30],
        duracao_solicitada_s: 60,
        inicio_em: toSecondIso(startedMs),
        termino_em: toSecondIso(stoppedMs),
        criado_em: new Date(startedMs).toISOString()
    });

    assert.equal(active.command_id, physical.body.comando.command_id);
    assert.equal(active.fisico, true);
    assert.equal(active.estado, "ativa");
    assert.equal(active.encerramento, null);
    assert.equal(active.termino_em, null);
    assert.equal(active.duracao_solicitada_s, 120, "a duração solicitada não é apresentada como realizada");

    assert.equal(legacy.estado, "finalizada");
    assert.equal(legacy.encerramento, null, "estado desconhecido não é tratado como confirmado");
    assert.equal(legacy.fisico, null, "registro sem indicação de simulação continua desconhecido");
    assert.equal(legacy.command_id, null);
    assert.equal(legacy.inicio_em, null);
    assert.equal(legacy.termino_em, null);
});

test("26. indisponibilidade da tabela ou do banco não expõe detalhes internos", async () => {
    const assertSafeUnavailable = (response) => {
        assert.equal(response.status, 503);
        assert.deepEqual(Object.keys(response.body).sort(), ["mensagem", "sucesso"]);
        assert.doesNotMatch(response.body.mensagem, /ER_|mabel_sessoes|Table|column/i);
    };

    assertSafeUnavailable(await listSessions(createRouter(createDatabase({ missingTables: true }))));

    const withoutMigration = createDatabase();
    withoutMigration.failOn(/FROM mabel_sessoes/, "ER_BAD_FIELD_ERROR");
    assertSafeUnavailable(await listSessions(createRouter(withoutMigration)));

    const offline = createDatabase();
    offline.failOn(/FROM mabel_sessoes/, "ECONNREFUSED");
    const failed = await listSessions(createRouter(offline));
    assert.equal(failed.status, 500, "falhas de conexão seguem para o tratador de erros do servidor");
    assert.equal(failed.body.sessoes, undefined);
});
