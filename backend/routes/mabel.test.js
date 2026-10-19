const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const routeFile = path.resolve(__dirname, "mabel.js");
const originalLoad = Module._load;
const TOKEN = "test-device-token-with-at-least-thirty-two-characters";
const DEVICE_ID = "mabel-esp32-01";
const READING_TIME = "2026-10-13T22:00:00.000Z";
const telemetry = {
    device_id: DEVICE_ID,
    sensor_detectou: true,
    contador_deteccoes: 4,
    uptime_ms: 12000
};

Module._load = function loadWithExpressStub(request, parent, isMain) {
    if (request === "express" && parent.filename === routeFile) {
        return {
            Router() {
                const handlers = new Map();
                return {
                    handlers,
                    get(route, handler) { handlers.set(`GET ${route}`, handler); },
                    post(route, handler) { handlers.set(`POST ${route}`, handler); },
                    delete(route, handler) { handlers.set(`DELETE ${route}`, handler); }
                };
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[routeFile];
const { createMabelRouter } = require("./mabel");
Module._load = originalLoad;

function createDatabase({
    ownedPets = { "22": "41" },
    associations = [],
    statuses = [],
    writeError = null
} = {}) {
    const petOwners = new Map(Object.entries(ownedPets));
    const petAssociations = new Map();
    const deviceStatuses = new Map();
    for (const association of associations) {
        petAssociations.set(String(association.petId), {
            device_id: association.deviceId,
            pet_id: String(association.petId),
            linked_at: association.linkedAt || "2026-10-13T21:00:00.000Z"
        });
    }
    for (const status of statuses) {
        deviceStatuses.set(status.device_id, { ...status });
    }

    function statusRow(status) {
        if (!status) return null;
        return {
            ...status,
            ultimo_contato_ms: new Date(status.ultimo_contato).getTime()
        };
    }

    async function executeReadWithRetry(query, params) {
        if (query.includes("FROM pets")) {
            const [petId, userId] = params;
            return [petOwners.get(String(petId)) === String(userId) ? [{ id: petId }] : [], []];
        }
        if (query.includes("INNER JOIN mabel_device_status")) {
            const [petId, deviceId] = params;
            const association = petAssociations.get(String(petId));
            const status = deviceStatuses.get(deviceId);
            const isCurrent = association?.device_id === deviceId
                && status
                && new Date(status.ultimo_contato).getTime()
                >= new Date(association.linked_at).getTime() + 1000;
            return [isCurrent ? [statusRow(status)] : [], []];
        }
        if (query.includes("FROM mabel_pet_associations")) {
            const [petId] = params;
            const association = petAssociations.get(String(petId));
            return [association ? [{ device_id: association.device_id }] : [], []];
        }
        if (query.includes("FROM mabel_device_status")) {
            if (query.includes("ORDER BY ultimo_contato DESC")) {
                const latest = [...deviceStatuses.values()]
                    .sort((left, right) => new Date(right.ultimo_contato) - new Date(left.ultimo_contato))[0];
                return [latest ? [statusRow(latest)] : [], []];
            }
            const [deviceId] = params;
            return [deviceStatuses.has(deviceId) ? [statusRow(deviceStatuses.get(deviceId))] : [], []];
        }
        throw new Error(`Unexpected database read: ${query}`);
    }

    async function executeWrite(query, params) {
        if (writeError) throw writeError;
        if (query.includes("INSERT INTO mabel_device_status")) {
            const [deviceId, detected, count, uptime] = params;
            deviceStatuses.set(deviceId, {
                device_id: deviceId,
                sensor_detectou: detected,
                contador_deteccoes: count,
                uptime_ms: uptime,
                ultimo_contato: READING_TIME
            });
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes("INSERT INTO mabel_pet_associations")) {
            const [deviceId, petId] = params;
            if (
                [...petAssociations.values()].some((association) =>
                    association.device_id === deviceId
                    || association.pet_id === String(petId))
            ) {
                throw Object.assign(new Error("Duplicate association"), { code: "ER_DUP_ENTRY" });
            }
            petAssociations.set(String(petId), {
                device_id: deviceId,
                pet_id: String(petId),
                linked_at: "2026-10-13T21:00:00.000Z"
            });
            return [{ affectedRows: 1 }, []];
        }
        if (query.includes("DELETE FROM mabel_pet_associations")) {
            const [petId, deviceId] = params;
            if (petAssociations.get(String(petId))?.device_id === deviceId) {
                petAssociations.delete(String(petId));
            }
            return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected database write: ${query}`);
    }

    return {
        executeReadWithRetry,
        executeWrite,
        petAssociations,
        deviceStatuses
    };
}

function createRouter(database, { deviceToken = TOKEN } = {}) {
    return createMabelRouter({
        deviceToken,
        sessionMiddleware(req, res, next) { return next(); },
        executeReadWithRetry: database.executeReadWithRetry,
        executeWrite: database.executeWrite
    });
}

function responseHarness() {
    const result = { status: 200, body: null, headers: {} };
    return {
        result,
        res: {
            status(code) {
                result.status = code;
                return this;
            },
            json(body) {
                result.body = body;
                return this;
            },
            set(name, value) {
                result.headers[name] = value;
                return this;
            }
        }
    };
}

async function invoke(router, method, route, {
    body = telemetry,
    query = {},
    session = { usuario: { id: "41" } },
    authorization,
    databaseErrorHandler = true
} = {}) {
    const handler = router.handlers.get(`${method} ${route}`);
    assert.ok(handler, `Handler ${method} ${route} exists`);
    const { result, res } = responseHarness();
    const req = {
        body,
        query,
        session,
        get(name) {
            return name.toLowerCase() === "authorization" ? authorization || "" : "";
        }
    };
    await handler(req, res, (error) => {
        if (!databaseErrorHandler) throw error;
        result.status = 500;
        result.body = {
            sucesso: false,
            mensagem: "Erro interno ao processar a requisição."
        };
    });
    return result;
}

function createDeviceRouter(database, options) {
    return createRouter(database, options);
}

function createWebRouter(database) {
    return createRouter(database);
}

function statusFixture(overrides = {}) {
    return {
        ...telemetry,
        sensor_detectou: 1,
        ultimo_contato: READING_TIME,
        ...overrides
    };
}

test("telemetry requires a configured token and a valid bearer", async () => {
    const database = createDatabase();
    const unconfiguredRouter = createDeviceRouter(database, { deviceToken: "" });
    const unconfigured = await invoke(unconfiguredRouter, "POST", "/dados", { authorization: `Bearer ${TOKEN}` });
    assert.equal(unconfigured.status, 503);

    const router = createDeviceRouter(database);
    const invalid = await invoke(router, "POST", "/dados", { authorization: "Bearer invalid-token" });
    assert.equal(invalid.status, 401);
    assert.equal(database.deviceStatuses.size, 0);
});

test("telemetry validates payload fields and ranges before writing", async () => {
    const database = createDatabase();
    const router = createDeviceRouter(database);
    const invalidBodies = [
        { ...telemetry, sensor_detectou: 1 },
        { ...telemetry, contador_deteccoes: -1 },
        { ...telemetry, uptime_ms: 1.2 },
        { ...telemetry, device_id: "bad device id" },
        { ...telemetry, usuario_id: "41" },
        []
    ];

    for (const body of invalidBodies) {
        const response = await invoke(router, "POST", "/dados", {
            body,
            authorization: `Bearer ${TOKEN}`
        });
        assert.equal(response.status, 400);
    }
    assert.equal(database.deviceStatuses.size, 0);
});

test("first telemetry reading is persisted and returned from persistent storage", async () => {
    const database = createDatabase();
    const router = createDeviceRouter(database);
    const response = await invoke(router, "POST", "/dados", {
        authorization: `Bearer ${TOKEN}`
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.persistida, true);
    assert.equal(response.body.device_id, DEVICE_ID);
    assert.equal(response.body.ultimo_contato, READING_TIME);
    assert.equal(database.deviceStatuses.size, 1);

    const status = await invoke(router, "GET", "/status", {
        authorization: `Bearer ${TOKEN}`
    });
    assert.equal(status.body.tem_dados, true);
    assert.deepEqual(status.body.dados, {
        ...telemetry,
        ultimo_contato: READING_TIME
    });
});

test("UPSERT updates the same device row and keeps different devices separate", async () => {
    const database = createDatabase();
    const router = createDeviceRouter(database);
    await invoke(router, "POST", "/dados", { authorization: `Bearer ${TOKEN}` });
    const updated = {
        ...telemetry,
        sensor_detectou: false,
        contador_deteccoes: 5,
        uptime_ms: 24000
    };
    await invoke(router, "POST", "/dados", {
        body: updated,
        authorization: `Bearer ${TOKEN}`
    });
    await invoke(router, "POST", "/dados", {
        body: { ...telemetry, device_id: "mabel-esp32-02" },
        authorization: `Bearer ${TOKEN}`
    });

    assert.equal(database.deviceStatuses.size, 2);
    assert.deepEqual(database.deviceStatuses.get(DEVICE_ID), {
        device_id: DEVICE_ID,
        sensor_detectou: 0,
        contador_deteccoes: 5,
        uptime_ms: 24000,
        ultimo_contato: READING_TIME
    });
    assert.equal(database.deviceStatuses.has("mabel-esp32-02"), true);
});

test("database write failure is sanitized and never reports persisted telemetry", async () => {
    const database = createDatabase({
        writeError: Object.assign(new Error("internal SQL and connection detail"), {
            code: "ER_ACCESS_DENIED_ERROR"
        })
    });
    const response = await invoke(createDeviceRouter(database), "POST", "/dados", {
        authorization: `Bearer ${TOKEN}`
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
        sucesso: false,
        mensagem: "Erro interno ao processar a requisição."
    });
    assert.equal(database.deviceStatuses.size, 0);
});

test("an unassociated device can persist telemetry", async () => {
    const database = createDatabase();
    const response = await invoke(createDeviceRouter(database), "POST", "/dados", {
        authorization: `Bearer ${TOKEN}`
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.persistida, true);
    assert.equal(database.deviceStatuses.has(DEVICE_ID), true);
    assert.equal(database.petAssociations.size, 0);
});

test("web status requires an authenticated session", async () => {
    const database = createDatabase();
    const response = await invoke(createWebRouter(database), "GET", "/status", {
        query: { pet_id: "22" },
        session: null
    });
    assert.equal(response.status, 401);
});

test("association requires a session and rejects extra client identity fields", async () => {
    const router = createWebRouter(createDatabase());
    const unauthenticated = await invoke(router, "POST", "/associacoes", {
        session: null,
        body: { pet_id: "22", device_id: DEVICE_ID }
    });
    assert.equal(unauthenticated.status, 401);

    const extraField = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "22", device_id: DEVICE_ID, usuario_id: "99" }
    });
    assert.equal(extraField.status, 400);
});

test("association validates pet ownership and device identifier", async () => {
    const database = createDatabase({ ownedPets: { "22": "99" } });
    const router = createWebRouter(database);
    const foreignPet = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "22", device_id: DEVICE_ID }
    });
    assert.equal(foreignPet.status, 404);

    const invalidDevice = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "22", device_id: "invalid device" }
    });
    assert.equal(invalidDevice.status, 400);
    assert.equal(database.petAssociations.size, 0);
});

test("association is persisted and can be queried by its owned pet", async () => {
    const database = createDatabase();
    const router = createWebRouter(database);
    const created = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "22", device_id: DEVICE_ID }
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.associacao, {
        device_id: DEVICE_ID,
        pet_id: "22"
    });

    const lookup = await invoke(router, "GET", "/associacoes", {
        query: { pet_id: "22" }
    });
    assert.deepEqual(lookup.body, {
        sucesso: true,
        tem_associacao: true,
        associacao: { device_id: DEVICE_ID, pet_id: "22" }
    });
});

test("association rejects a device or pet that already has an association", async () => {
    const database = createDatabase({
        ownedPets: { "22": "41", "23": "41" },
        associations: [{ petId: "22", deviceId: DEVICE_ID }]
    });
    const router = createWebRouter(database);
    const petAlreadyLinked = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "22", device_id: "mabel-esp32-02" }
    });
    assert.equal(petAlreadyLinked.status, 409);

    const deviceAlreadyLinked = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "23", device_id: DEVICE_ID }
    });
    assert.equal(deviceAlreadyLinked.status, 409);
});

test("association lookup and deletion do not expose another user's pet", async () => {
    const database = createDatabase({
        ownedPets: { "22": "99" },
        associations: [{ petId: "22", deviceId: DEVICE_ID }]
    });
    const router = createWebRouter(database);
    const lookup = await invoke(router, "GET", "/associacoes", {
        query: { pet_id: "22" }
    });
    assert.equal(lookup.status, 404);
    const removed = await invoke(router, "DELETE", "/associacoes", {
        query: { pet_id: "22" }
    });
    assert.equal(removed.status, 404);
    assert.equal(database.petAssociations.get("22").device_id, DEVICE_ID);
});

test("unlinking allows the device to be reassociated with another owned pet", async () => {
    const database = createDatabase({
        ownedPets: { "22": "41", "23": "41" },
        associations: [{ petId: "22", deviceId: DEVICE_ID }]
    });
    const router = createWebRouter(database);
    const removed = await invoke(router, "DELETE", "/associacoes", {
        query: { pet_id: "22" }
    });
    assert.equal(removed.status, 200);
    assert.equal(database.petAssociations.has("22"), false);

    const reassociated = await invoke(router, "POST", "/associacoes", {
        body: { pet_id: "23", device_id: DEVICE_ID }
    });
    assert.equal(reassociated.status, 201);
    assert.equal(database.petAssociations.get("23").device_id, DEVICE_ID);
});

test("pet status distinguishes no association from an association without telemetry", async () => {
    const unassociatedDatabase = createDatabase();
    const unassociated = await invoke(createWebRouter(unassociatedDatabase), "GET", "/status", {
        query: { pet_id: "22" }
    });
    assert.deepEqual(unassociated.body, {
        sucesso: true,
        tem_associacao: false,
        tem_dados: false,
        device_id: null,
        ultimo_contato: null,
        dados: null
    });

    const database = createDatabase({
        associations: [{ petId: "22", deviceId: DEVICE_ID }]
    });
    const router = createWebRouter(database);
    const noReading = await invoke(router, "GET", "/status", {
        query: { pet_id: "22" }
    });
    assert.deepEqual(noReading.body, {
        sucesso: true,
        tem_associacao: true,
        tem_dados: false,
        device_id: DEVICE_ID,
        ultimo_contato: null,
        dados: null
    });
});

test("pet status returns the associated device's persisted telemetry", async () => {
    const database = createDatabase({
        associations: [{ petId: "22", deviceId: DEVICE_ID }],
        statuses: [statusFixture()]
    });
    const response = await invoke(createWebRouter(database), "GET", "/status", {
        query: { pet_id: "22" }
    });

    assert.deepEqual(response.body, {
        sucesso: true,
        tem_associacao: true,
        tem_dados: true,
        device_id: DEVICE_ID,
        ultimo_contato: READING_TIME,
        dados: { ...telemetry, ultimo_contato: READING_TIME }
    });
});

test("pet status does not show a reading from before the current linked_at", async () => {
    const database = createDatabase({
        associations: [{
            petId: "22",
            deviceId: DEVICE_ID,
            linkedAt: "2026-10-13T22:00:00.001Z"
        }],
        statuses: [statusFixture()]
    });
    const response = await invoke(createWebRouter(database), "GET", "/status", {
        query: { pet_id: "22" }
    });

    assert.equal(response.body.tem_associacao, true);
    assert.equal(response.body.tem_dados, false);
    assert.equal(response.body.dados, null);
});

test("pet status rejects pets owned by another user", async () => {
    const database = createDatabase({
        ownedPets: { "22": "99" },
        associations: [{ petId: "22", deviceId: DEVICE_ID }],
        statuses: [statusFixture()]
    });
    const response = await invoke(createWebRouter(database), "GET", "/status", {
        query: { pet_id: "22" }
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.tem_dados, undefined);
});

test("POST and GET in separate router instances share the persistent database", async () => {
    const database = createDatabase({
        associations: [{ petId: "22", deviceId: DEVICE_ID }]
    });
    const postRouter = createDeviceRouter(database);
    const post = await invoke(postRouter, "POST", "/dados", {
        authorization: `Bearer ${TOKEN}`
    });
    assert.equal(post.body.persistida, true);

    const getRouter = createWebRouter(database);
    const status = await invoke(getRouter, "GET", "/status", {
        query: { pet_id: "22" }
    });
    assert.equal(status.body.tem_dados, true);
    assert.equal(status.body.device_id, DEVICE_ID);
});
