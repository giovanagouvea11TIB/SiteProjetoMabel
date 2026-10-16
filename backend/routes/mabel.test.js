const assert = require("node:assert/strict");
const express = require("express");
const { test } = require("node:test");
const { createMabelRouter } = require("./mabel");

const TOKEN = "test-device-token-that-is-at-least-32-characters";
const telemetry = {
    device_id: "mabel-esp32-01",
    sensor_detectou: true,
    contador_deteccoes: 4,
    uptime_ms: 18000
};
const OLD_READING_TIME = "2026-10-13T21:00:00.000Z";
const LINKED_AT_MS = Date.parse("2026-10-13T20:00:00.000Z");

function createDatabase({
    pets = { "22": "17", "23": "17", "99": "88" },
    associations = [],
    linkedAtMs = LINKED_AT_MS,
    queries = []
} = {}) {
    const petOwners = new Map(Object.entries(pets));
    const petAssociations = new Map(associations.map(({ petId, deviceId, linkedAt = linkedAtMs }) => [
        String(petId),
        { device_id: deviceId, linked_at_ms: linkedAt }
    ]));

    async function executeReadWithRetry(query, params) {
        queries.push({ query, params });
        if (/FROM pets/i.test(query)) {
            const [petId, userId] = params;
            return [petOwners.get(String(petId)) === String(userId) ? [{ id: String(petId) }] : [], []];
        }
        if (/FROM mabel_pet_associations/i.test(query)) {
            const association = petAssociations.get(String(params[0]));
            return [association ? [{ ...association }] : [], []];
        }
        throw new Error(`Unexpected read query: ${query}`);
    }

    async function executeWrite(query, params) {
        if (/^INSERT INTO mabel_pet_associations/i.test(query)) {
            const [deviceId, petId] = params;
            if ([...petAssociations.values()].some((item) => item.device_id === deviceId)
                || petAssociations.has(String(petId))) {
                const error = new Error("Duplicate association");
                error.code = "ER_DUP_ENTRY";
                throw error;
            }
            petAssociations.set(String(petId), {
                device_id: deviceId,
                linked_at_ms: linkedAtMs
            });
            return [{ affectedRows: 1 }, []];
        }
        if (/^DELETE FROM mabel_pet_associations/i.test(query)) {
            return [{ affectedRows: Number(petAssociations.delete(String(params[0]))) }, []];
        }
        throw new Error(`Unexpected write query: ${query}`);
    }

    return { executeReadWithRetry, executeWrite, petAssociations, queries };
}

async function withApi(options, run) {
    const app = express();
    app.use(express.json());
    app.use("/api/mabel", createMabelRouter(options));
    const server = await new Promise((resolve) => {
        const listeningServer = app.listen(0, () => resolve(listeningServer));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/mabel`;

    try {
        await run(baseUrl);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

function sessionOptions(database, options = {}) {
    return {
        deviceToken: TOKEN,
        ...database,
        sessionMiddleware(req, res, next) {
            req.session = options.sessionUserId === null
                ? {}
                : { usuario: { id: options.sessionUserId || "17" } };
            next();
        },
        ...options
    };
}

function postAssociation(url, body, options = {}) {
    return fetch(`${url}/associacoes`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options.authorization ? { Authorization: options.authorization } : {})
        },
        body: JSON.stringify(body)
    });
}

test("device telemetry requires a configured bearer token and strict payload validation", async () => {
    await withApi({
        deviceToken: "",
        readings: new Map()
    }, async (url) => {
        const noToken = await fetch(`${url}/dados`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(telemetry)
        });
        assert.equal(noToken.status, 503);
        assert.doesNotMatch(await noToken.text(), /test-device-token/);
    });

    await withApi({
        deviceToken: TOKEN,
        readings: new Map()
    }, async (url) => {
        const unauthorized = await fetch(`${url}/dados`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer invalid"
            },
            body: JSON.stringify(telemetry)
        });
        assert.equal(unauthorized.status, 401);

        const invalidBodies = [
            { ...telemetry, usuario_id: 7 },
            { ...telemetry, sensor_detectou: 1 },
            { ...telemetry, contador_deteccoes: -1 },
            { ...telemetry, uptime_ms: 1.5 },
            { ...telemetry, device_id: "bad device id" },
            []
        ];
        for (const body of invalidBodies) {
            const response = await fetch(`${url}/dados`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${TOKEN}`
                },
                body: JSON.stringify(body)
            });
            assert.equal(response.status, 400);
        }
    });
});

test("device telemetry is accepted and status does not invent an initial reading", async () => {
    const readings = new Map();
    await withApi({
        deviceToken: TOKEN,
        readings,
        now: () => new Date("2026-10-13T22:00:00.000Z")
    }, async (url) => {
        const empty = await fetch(`${url}/status`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });
        assert.deepEqual(await empty.json(), {
            sucesso: true,
            tem_dados: false,
            ultimo_contato: null,
            dados: null
        });

        const accepted = await fetch(`${url}/dados`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${TOKEN}`
            },
            body: JSON.stringify(telemetry)
        });
        assert.equal(accepted.status, 202);
        assert.equal((await accepted.json()).persistida, false);

        const status = await fetch(`${url}/status`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });
        assert.deepEqual(await status.json(), {
            sucesso: true,
            tem_dados: true,
            ultimo_contato: "2026-10-13T22:00:00.000Z",
            dados: {
                ...telemetry,
                ultimo_contato: "2026-10-13T22:00:00.000Z"
            }
        });
    });
});

test("association requires a session and only accepts pet_id and device_id", async () => {
    const database = createDatabase();
    await withApi(sessionOptions(database, { sessionUserId: null }), async (url) => {
        const unauthorized = await postAssociation(url, {
            pet_id: "22",
            device_id: telemetry.device_id
        });
        assert.equal(unauthorized.status, 401);

        const forgedUser = await postAssociation(url, {
            pet_id: "22",
            device_id: telemetry.device_id,
            usuario_id: "17"
        });
        assert.equal(forgedUser.status, 401);
    });
    assert.equal(database.queries.length, 0);

    await withApi(sessionOptions(createDatabase()), async (url) => {
        const extraField = await postAssociation(url, {
            pet_id: "22",
            device_id: telemetry.device_id,
            usuario_id: "17"
        });
        assert.equal(extraField.status, 400);
    });
});

test("association validates pet ownership and device_id", async () => {
    const database = createDatabase();
    await withApi(sessionOptions(database), async (url) => {
        const anotherUsersPet = await postAssociation(url, {
            pet_id: "99",
            device_id: telemetry.device_id
        });
        assert.equal(anotherUsersPet.status, 404);

        const invalidDevice = await postAssociation(url, {
            pet_id: "22",
            device_id: "bad device id"
        });
        assert.equal(invalidDevice.status, 400);

        const invalidPet = await postAssociation(url, {
            pet_id: "9223372036854775808",
            device_id: telemetry.device_id
        });
        assert.equal(invalidPet.status, 400);
    });
    assert.deepEqual(database.queries.map(({ params }) => params), [["99", "17"]]);
});

test("association rejects an already associated device or pet", async () => {
    for (const associations of [
        [{ petId: "23", deviceId: telemetry.device_id }],
        [{ petId: "22", deviceId: "another-device" }]
    ]) {
        const database = createDatabase({ associations });
        await withApi(sessionOptions(database), async (url) => {
            const response = await postAssociation(url, {
                pet_id: "22",
                device_id: telemetry.device_id
            });
            assert.equal(response.status, 409);
            assert.match((await response.json()).mensagem, /associação ativa/);
        });
    }
});

test("valid association is persisted for the pet owned by the authenticated user", async () => {
    const database = createDatabase();
    const readings = new Map([[telemetry.device_id, { ...telemetry, ultimo_contato: OLD_READING_TIME }]]);
    await withApi(sessionOptions(database, { readings }), async (url) => {
        const response = await postAssociation(url, {
            pet_id: "22",
            device_id: telemetry.device_id
        });
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), {
            sucesso: true,
            associacao: { device_id: telemetry.device_id, pet_id: "22" }
        });
        assert.equal(database.petAssociations.get("22").device_id, telemetry.device_id);
        assert.equal(readings.has(telemetry.device_id), false);
    });
});

test("association lookup returns the association or a safe empty state", async () => {
    const database = createDatabase({
        associations: [{ petId: "22", deviceId: telemetry.device_id }]
    });
    await withApi(sessionOptions(database), async (url) => {
        const associated = await fetch(`${url}/associacoes?pet_id=22`);
        assert.deepEqual(await associated.json(), {
            sucesso: true,
            tem_associacao: true,
            associacao: { device_id: telemetry.device_id, pet_id: "22" }
        });

        const unassociated = await fetch(`${url}/associacoes?pet_id=23`);
        assert.deepEqual(await unassociated.json(), {
            sucesso: true,
            tem_associacao: false,
            associacao: null
        });
    });
});

test("association endpoints report the migration as unavailable when its table is absent", async () => {
    const database = createDatabase();
    database.executeReadWithRetry = async (query, params) => {
        if (/FROM pets/i.test(query)) return [[{ id: String(params[0]) }], []];
        const error = new Error("Table does not exist");
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
    };
    await withApi(sessionOptions(database), async (url) => {
        const response = await fetch(`${url}/associacoes?pet_id=22`);
        assert.equal(response.status, 503);
        assert.match((await response.json()).mensagem, /estrutura do banco precisa ser preparada/);
    });
});

test("association lookup and deletion do not expose or remove another user's association", async () => {
    const database = createDatabase({
        associations: [{ petId: "99", deviceId: "private-device" }]
    });
    await withApi(sessionOptions(database), async (url) => {
        const lookup = await fetch(`${url}/associacoes?pet_id=99`);
        assert.equal(lookup.status, 404);
        assert.doesNotMatch(await lookup.text(), /private-device/);

        const deletion = await fetch(`${url}/associacoes?pet_id=99`, { method: "DELETE" });
        assert.equal(deletion.status, 404);
        assert.equal(database.petAssociations.get("99").device_id, "private-device");
    });
});

test("deleting an association allows the device to be reassociated with another owned pet", async () => {
    const database = createDatabase({
        associations: [{ petId: "22", deviceId: telemetry.device_id }]
    });
    const readings = new Map([[telemetry.device_id, { ...telemetry, ultimo_contato: OLD_READING_TIME }]]);
    await withApi(sessionOptions(database, { readings }), async (url) => {
        const deletion = await fetch(`${url}/associacoes?pet_id=22`, { method: "DELETE" });
        assert.equal(deletion.status, 200);
        assert.equal(database.petAssociations.has("22"), false);
        assert.equal(readings.has(telemetry.device_id), false);

        const reassociation = await postAssociation(url, {
            pet_id: "23",
            device_id: telemetry.device_id
        });
        assert.equal(reassociation.status, 201);
        assert.equal(database.petAssociations.get("23").device_id, telemetry.device_id);
    });
});

test("web status returns only telemetry for the device associated with the owned pet", async () => {
    const associatedReading = {
        ...telemetry,
        ultimo_contato: "2026-10-13T22:00:00.000Z"
    };
    const unrelatedReading = {
        ...telemetry,
        device_id: "unrelated-device",
        contador_deteccoes: 999,
        ultimo_contato: "2026-10-13T23:00:00.000Z"
    };
    await withApi(sessionOptions(createDatabase({
        associations: [{ petId: "22", deviceId: telemetry.device_id }]
    }), {
        readings: new Map([
            [telemetry.device_id, associatedReading],
            ["unrelated-device", unrelatedReading]
        ])
    }), async (url) => {
        const response = await fetch(`${url}/status?pet_id=22`);
        assert.deepEqual(await response.json(), {
            sucesso: true,
            tem_associacao: true,
            tem_dados: true,
            device_id: telemetry.device_id,
            ultimo_contato: associatedReading.ultimo_contato,
            dados: associatedReading
        });
    });
});

test("web status distinguishes no association from an associated device without telemetry", async () => {
    const database = createDatabase({
        associations: [{ petId: "23", deviceId: "silent-device" }]
    });
    await withApi(sessionOptions(database, {
        readings: new Map([["other-device", { ...telemetry, ultimo_contato: OLD_READING_TIME }]])
    }), async (url) => {
        const unassociated = await fetch(`${url}/status?pet_id=22`);
        assert.deepEqual(await unassociated.json(), {
            sucesso: true,
            tem_associacao: false,
            tem_dados: false,
            device_id: null,
            ultimo_contato: null,
            dados: null
        });

        const noTelemetry = await fetch(`${url}/status?pet_id=23`);
        assert.deepEqual(await noTelemetry.json(), {
            sucesso: true,
            tem_associacao: true,
            tem_dados: false,
            device_id: "silent-device",
            ultimo_contato: null,
            dados: null
        });
    });
});

test("web status rejects readings received before the current association", async () => {
    const staleReading = {
        ...telemetry,
        ultimo_contato: "2026-10-13T20:00:00.999Z"
    };
    await withApi(sessionOptions(createDatabase({
        associations: [{
            petId: "22",
            deviceId: telemetry.device_id,
            linkedAt: LINKED_AT_MS
        }]
    }), {
        readings: new Map([[telemetry.device_id, staleReading]])
    }), async (url) => {
        const response = await fetch(`${url}/status?pet_id=22`);
        const result = await response.json();
        assert.equal(result.tem_associacao, true);
        assert.equal(result.tem_dados, false);
        assert.equal(result.dados, null);
    });
});

test("web status verifies pet ownership and requires an authenticated session", async () => {
    const database = createDatabase({
        associations: [{ petId: "22", deviceId: telemetry.device_id }]
    });
    await withApi(sessionOptions(database), async (url) => {
        const anotherUsersPet = await fetch(`${url}/status?pet_id=99`);
        assert.equal(anotherUsersPet.status, 404);
        assert.deepEqual(database.queries.map(({ params }) => params), [["99", "17"]]);
    });

    await withApi(sessionOptions(createDatabase(), { sessionUserId: null }), async (url) => {
        const unauthorized = await fetch(`${url}/status?pet_id=22`);
        assert.equal(unauthorized.status, 401);
    });
});
