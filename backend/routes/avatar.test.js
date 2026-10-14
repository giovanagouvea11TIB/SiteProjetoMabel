const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { beforeEach, test } = require("node:test");

const routeFile = path.resolve(__dirname, "avatar.js");
const handlers = new Map();
let executeMock;
let usersTableMock;
const originalLoad = Module._load;

Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "express") {
        return {
            Router() {
                return {
                    use() {},
                    get(route, handler) { handlers.set(`GET ${route}`, handler); },
                    put(route, handler) { handlers.set(`PUT ${route}`, handler); }
                };
            }
        };
    }
    if (request === "../db" && parent.filename === routeFile) {
        return {
            pool: { execute: (...args) => executeMock(...args) },
            executeReadWithRetry(query, params, action) {
                const { runReadWithRetry } = require("../database-reads");
                return runReadWithRetry(
                    () => executeMock(query, params),
                    action,
                    () => {}
                );
            },
            getUsersTableName: (...args) => usersTableMock(...args)
        };
    }
    if (request === "../middleware/require-auth" && parent.filename === routeFile) {
        return () => {};
    }
    return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[routeFile];
require("./avatar");
Module._load = originalLoad;

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

async function invoke(method, route, request = {}) {
    const handler = handlers.get(`${method} ${route}`);
    assert.ok(handler, `Handler ${method} ${route} exists`);
    const { result, res } = responseHarness();
    await handler({
        body: { avatar: "cat" },
        session: { usuario: { id: "42" } },
        ...request
    }, res);
    return result;
}

beforeEach(() => {
    usersTableMock = async () => "alunos_usuarios";
    executeMock = async () => {
        throw new Error("Unexpected database query in test");
    };
});

test("requires an authenticated session and ignores browser-supplied user IDs", async () => {
    let calls = 0;
    executeMock = async () => {
        calls++;
        return [[{ avatar_id: "paw" }], []];
    };

    const result = await invoke("PUT", "/", {
        session: null,
        body: { avatar: "cat", usuario_id: "99" }
    });

    assert.equal(result.status, 401);
    assert.equal(calls, 0);
});

test("loads the current user's stored avatar using the session ID", async () => {
    let query;
    executeMock = async (sql, params) => {
        query = { sql, params };
        return [[{ avatar_id: "butterfly" }], []];
    };

    const result = await invoke("GET", "/");

    assert.equal(result.status, 200);
    assert.equal(result.body.avatar, "butterfly");
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    assert.match(query.sql, /WHERE id = \? LIMIT 1/);
    assert.deepEqual(query.params, ["42"]);
});

test("saves only an allowlisted avatar to the authenticated account", async () => {
    let query;
    executeMock = async (sql, params) => {
        query = { sql, params };
        return [{ affectedRows: 1 }, []];
    };

    const result = await invoke("PUT", "/", {
        body: { avatar: "horse" }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.avatar, "horse");
    assert.match(query.sql, /SET avatar_id = \? WHERE id = \?/);
    assert.deepEqual(query.params, ["horse", "42"]);
});

test("rejects arbitrary avatar IDs and additional identity fields before database access", async () => {
    let calls = 0;
    executeMock = async () => {
        calls++;
        return [{ affectedRows: 1 }, []];
    };

    for (const body of [
        { avatar: "<svg onload=alert(1)>" },
        { avatar: "not-in-the-list" },
        { avatar: "cat", usuario_id: "99" }
    ]) {
        const result = await invoke("PUT", "/", { body });
        assert.equal(result.status, 400);
    }
    assert.equal(calls, 0);
});

test("uses the default paw when no valid avatar has been stored", async () => {
    executeMock = async () => [[{ avatar_id: null }], []];

    const result = await invoke("GET", "/");

    assert.equal(result.status, 200);
    assert.equal(result.body.avatar, "paw");
});

test("returns the saved avatar on a later authenticated read", async () => {
    let storedAvatar = "paw";
    executeMock = async (sql, params) => {
        if (/SELECT avatar_id/.test(sql)) return [[{ avatar_id: storedAvatar }], []];
        if (/UPDATE `alunos_usuarios` SET avatar_id/.test(sql)) {
            storedAvatar = params[0];
            return [{ affectedRows: 1 }, []];
        }
        throw new Error("Unexpected SQL");
    };

    const saved = await invoke("PUT", "/", {
        body: { avatar: "flower" }
    });
    const restored = await invoke("GET", "/");

    assert.equal(saved.body.avatar, "flower");
    assert.equal(restored.body.avatar, "flower");
});

test("reports that avatar persistence requires the schema migration", async () => {
    executeMock = async () => {
        const error = new Error("unknown avatar column");
        error.code = "ER_BAD_FIELD_ERROR";
        throw error;
    };

    const result = await invoke("GET", "/");

    assert.equal(result.status, 503);
    assert.equal(result.body.mensagem, "A personalização de avatar ainda não está disponível.");
});
