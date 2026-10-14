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
                Authorization: "Bearer wrong-token"
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
            null
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

test("web status verifies pet ownership and never exposes unassociated telemetry", async () => {
    const queries = [];
    await withApi({
        deviceToken: TOKEN,
        readings: new Map([["other-device", telemetry]]),
        sessionMiddleware(req, res, next) {
            req.session = { usuario: { id: "17" } };
            next();
        },
        async executeReadWithRetry(query, params) {
            queries.push({ query, params });
            return params[0] === "22" ? [[{ id: params[0] }], []] : [[], []];
        }
    }, async (url) => {
        const ownedPet = await fetch(`${url}/status?pet_id=22`);
        assert.equal(ownedPet.status, 409);
        assert.doesNotMatch(await ownedPet.text(), /other-device|contador_deteccoes/);

        const anotherUsersPet = await fetch(`${url}/status?pet_id=99`);
        assert.equal(anotherUsersPet.status, 404);
        assert.deepEqual(queries.map(({ params }) => params), [["22", "17"], ["99", "17"]]);
    });

    await withApi({
        deviceToken: TOKEN,
        readings: new Map(),
        sessionMiddleware(req, res, next) {
            req.session = {};
            next();
        }
    }, async (url) => {
        const unauthorized = await fetch(`${url}/status?pet_id=22`);
        assert.equal(unauthorized.status, 401);
    });
});
