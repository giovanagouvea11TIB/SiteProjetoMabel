const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { beforeEach, test } = require("node:test");

const routeFile = path.resolve(__dirname, "pets.js");
const handlers = new Map();
let executeMock;
const originalLoad = Module._load;

Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "express") {
        return {
            Router() {
                return {
                    use() {},
                    get(route, handler) { handlers.set(`GET ${route}`, handler); },
                    post(route, handler) { handlers.set(`POST ${route}`, handler); },
                    put(route, handler) { handlers.set(`PUT ${route}`, handler); },
                    delete(route, handler) { handlers.set(`DELETE ${route}`, handler); }
                };
            }
        };
    }
    if (request === "../db" && parent.filename === routeFile) {
        return {
            pool: { execute: (...args) => executeMock(...args) },
            executeReadWithRetry: (...args) => executeMock(...args)
        };
    }
    if (request === "../middleware/require-auth" && parent.filename === routeFile) {
        return () => {};
    }
    if (request === "../database-errors" && parent.filename === routeFile) {
        return {
            sendDatabaseError(res) {
                return res.status(500).json({ sucesso: false });
            }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[routeFile];
require("./pets");
Module._load = originalLoad;

function responseHarness() {
    const result = { status: 200, body: null };
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
            set() {
                return this;
            }
        }
    };
}

async function invoke(method, route, request = {}) {
    const handler = handlers.get(`${method} ${route}`);
    assert.ok(handler, `Handler ${method} ${route} exists`);
    const { result, res } = responseHarness();
    await handler({
        params: {},
        body: {
            nome: "Mabel",
            identificacao: null,
            idade_meses: null,
            peso_kg: null,
            condicao_saude: null
        },
        session: { usuario: { id: "41" } },
        ...request
    }, res);
    return result;
}

beforeEach(() => {
    executeMock = async () => {
        throw new Error("Unexpected database query in test");
    };
});

test("pet routes expose list, create, update, and delete under the profile router", () => {
    assert.ok(handlers.has("GET /pet"));
    assert.ok(handlers.has("POST /pet"));
    assert.ok(handlers.has("PUT /pet/:id"));
    assert.ok(handlers.has("DELETE /pet/:id"));
});

test("pet creation requires an authenticated session and never accepts a client user id", async () => {
    let queryCount = 0;
    executeMock = async () => {
        queryCount++;
        return [{ insertId: "83" }, []];
    };

    const unauthenticated = await invoke("POST", "/pet", { session: null });
    assert.equal(unauthenticated.status, 401);

    const clientSelectedUser = await invoke("POST", "/pet", {
        body: { nome: "Mabel", usuario_id: "999" }
    });
    assert.equal(clientSelectedUser.status, 400);
    assert.equal(queryCount, 0);
});

test("pet creation associates the record with the authenticated session user", async () => {
    let query;
    executeMock = async (...args) => {
        query = args;
        return [{ insertId: "83" }, []];
    };

    const result = await invoke("POST", "/pet");

    assert.equal(result.status, 201);
    assert.equal(result.body.pet.id, "83");
    assert.equal(query[1][0], "41");
    assert.match(query[0], /INSERT INTO pets/);
});
