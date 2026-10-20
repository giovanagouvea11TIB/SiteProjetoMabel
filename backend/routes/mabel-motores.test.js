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
const { createMabelMotorRouter, START_WINDOW_MS, OFFLINE_AFTER_MS } = require("./mabel-motores");
Module._load = originalLoad;

function createDatabase({ missingTables = false } = {}) {
    let state = {
        now: LINKED_AT_MS + 5000,
        pets: { "22": "41", "23": "41", "99": "77" },
        associations: {
            [DEVICE_ID]: { pet_id: "22", linked_ms: LINKED_AT_MS },
            [OTHER_DEVICE_ID]: { pet_id: "23", linked_ms: LINKED_AT_MS }
        },
        commands: [],
        motorState: {},
        nextCommandId: 1
    };

    function assertTables(sql) {
        if (missingTables && /mabel_motor_(commands|state)/.test(sql)) {
            throw Object.assign(new Error("Table doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
        }
    }

    function commandRow(command) {
        return command ? [{ ...command }] : [];
    }

    async function execute(query, params = []) {
        const sql = query.replace(/\s+/g, " ").trim();
        assertTables(sql);

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
