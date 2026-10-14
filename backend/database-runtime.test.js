const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveDatabaseConfig, EXPECTED_DATABASE } = require("./database-config");
const { runReadWithRetry, createSessionPoolAdapter } = require("./database-reads");
const { createSessionStore } = require("./session-store");
const { sendDatabaseError } = require("./database-errors");
const { createErrorHandler } = require("./error-handler");

const baseEnv = {
    DB_HOST: "db.local.test",
    DB_USER: "mabel-test",
    DB_PASSWORD: "test-only",
    DB_DATABASE: EXPECTED_DATABASE
};

test("database config applies consistent schema, pool limits, timeout, and optional TLS", () => {
    const local = resolveDatabaseConfig(baseEnv);
    assert.equal(local.database, EXPECTED_DATABASE);
    assert.equal(local.port, 3306);
    assert.equal(local.connectionLimit, 10);
    assert.equal(local.queueLimit, 50);
    assert.equal(local.waitForConnections, true);
    assert.equal(local.connectTimeout, 10000);
    assert.equal(local.ssl, undefined);

    const vercel = resolveDatabaseConfig({
        ...baseEnv,
        VERCEL: "1",
        DB_PORT: "3307",
        DB_CONNECTION_LIMIT: "2",
        DB_QUEUE_LIMIT: "8",
        DB_SSL: "true"
    });
    assert.equal(vercel.connectionLimit, 2);
    assert.equal(vercel.port, 3307);
    assert.equal(vercel.queueLimit, 8);
    assert.deepEqual(vercel.ssl, {});

    assert.throws(
        () => resolveDatabaseConfig({ ...baseEnv, DB_NAME: "different_schema" }),
        /DB_DATABASE e DB_NAME/
    );
    assert.throws(
        () => resolveDatabaseConfig({ ...baseEnv, DB_PORT: "invalid" }),
        /DB_PORT/
    );
    assert.throws(
        () => resolveDatabaseConfig({ DB_USER: "user" }),
        /DB_HOST e DB_USER/
    );
});

test("transient reads retry once, but a failed second attempt is surfaced", async () => {
    let attempts = 0;
    const result = await runReadWithRetry(async () => {
        attempts++;
        if (attempts === 1) {
            const error = new Error("reset");
            error.code = "ECONNRESET";
            throw error;
        }
        return "read-result";
    }, "test read", () => {});
    assert.equal(result, "read-result");
    assert.equal(attempts, 2);

    attempts = 0;
    await assert.rejects(runReadWithRetry(async () => {
        attempts++;
        const error = new Error("reset");
        error.code = "ECONNRESET";
        throw error;
    }, "test read", () => {}), { code: "ECONNRESET" });
    assert.equal(attempts, 2);
});

test("session adapter retries only idempotent SELECTs, never session writes", async () => {
    const calls = [];
    const pool = {
        query(sql, params) {
            calls.push(sql);
            if (calls.length === 1) {
                const error = new Error("reset");
                error.code = "ECONNRESET";
                return Promise.reject(error);
            }
            return Promise.resolve([[{ ok: 1 }], []]);
        }
    };
    const sessionPool = createSessionPoolAdapter(pool);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const [rows] = await sessionPool.query("SELECT data FROM sessions WHERE id = ?", ["id"]);
        assert.deepEqual(rows, [{ ok: 1 }]);
        assert.equal(calls.length, 2);
    } finally {
        console.warn = originalWarn;
    }

    calls.length = 0;
    await assert.rejects(
        sessionPool.query("UPDATE sessions SET data = ? WHERE id = ?", ["value", "id"]),
        { code: "ECONNRESET" }
    );
    assert.equal(calls.length, 1);
});

test("session store shares the supplied pool adapter and performs no schema initialization", async () => {
    let constructorOptions;
    let constructorConnection;
    class FakeStore {
        constructor(options, connection) {
            constructorOptions = options;
            constructorConnection = connection;
        }
    }
    const expected = [[{ ok: 1 }], []];
    let queryCount = 0;
    const pool = {
        async query() {
            queryCount++;
            return expected;
        }
    };
    const store = createSessionStore({}, pool, () => FakeStore);

    assert.ok(store instanceof FakeStore);
    assert.equal(constructorOptions.createDatabaseTable, false);
    assert.equal(constructorOptions.endConnectionOnClose, false);
    assert.equal(constructorOptions.schema.tableName, "mabel_web_sessions");
    assert.equal(queryCount, 0);
    assert.deepEqual(await constructorConnection.query("SELECT 1", []), expected);
    assert.equal(queryCount, 1);
});

test("express-mysql-session accepts the promise-pool adapter without opening another pool", async () => {
    const calls = [];
    const sessionData = {
        cookie: { expires: new Date(Date.now() + 60000).toISOString() },
        usuario: { id: 7 }
    };
    const pool = {
        query(sql, params) {
            calls.push({ sql, params });
            const rows = /^\s*SELECT\b/i.test(sql)
                ? [{ data: JSON.stringify(sessionData), expires: Math.round(Date.now() / 1000) + 60 }]
                : [];
            return Promise.resolve([rows, []]);
        }
    };
    const store = createSessionStore(require("express-session"), pool);
    try {
        await store.onReady();
        assert.deepEqual(await store.get("session-test-id"), sessionData);
        await store.set("session-test-id", sessionData);
        await store.touch("session-test-id", sessionData);
        await store.destroy("session-test-id");
        assert.equal(calls.length, 4);
        assert.match(calls[0].sql, /SELECT/);
        assert.match(calls[1].sql, /INSERT/);
        assert.match(calls[2].sql, /UPDATE/);
        assert.match(calls[3].sql, /DELETE/);
    } finally {
        store.clearExpirationInterval();
    }
});

test("database failures map to service unavailable without exposing details", () => {
    const result = { status: 200, body: null };
    const res = {
        status(value) {
            result.status = value;
            return this;
        },
        json(body) {
            result.body = body;
            return this;
        }
    };
    const privateError = new Error("private endpoint credentials");
    privateError.code = "ECONNRESET";
    const originalError = console.error;
    console.error = () => {};
    try {
        sendDatabaseError(res, privateError, "testing", "generic failure");
    } finally {
        console.error = originalError;
    }

    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result.body), /private endpoint credentials/);
});

test("global middleware handles an absent error and transient connection failures", () => {
    const handler = createErrorHandler();
    const responses = [];
    const res = {
        headersSent: false,
        status(status) {
            this.statusCode = status;
            return this;
        },
        json(body) {
            responses.push({ status: this.statusCode, body });
            return this;
        }
    };
    const originalError = console.error;
    console.error = () => {};
    try {
        handler(undefined, {}, res, () => {});
        const connectionError = new Error("private connection metadata");
        connectionError.code = "ECONNRESET";
        handler(connectionError, {}, res, () => {});
    } finally {
        console.error = originalError;
    }

    assert.equal(responses[0].status, 500);
    assert.equal(responses[1].status, 503);
    assert.doesNotMatch(JSON.stringify(responses), /private connection metadata/);
});
