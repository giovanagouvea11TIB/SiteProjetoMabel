const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { beforeEach, test } = require("node:test");

const routeFile = path.resolve(__dirname, "vacinas.js");
const handlers = new Map();
let executeMock;
let connectionMock;
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
            pool: {
                execute: (...args) => executeMock(...args),
                getConnection: (...args) => connectionMock(...args)
            },
            executeReadWithRetry(query, params, action) {
                const { runReadWithRetry } = require("../database-reads");
                return runReadWithRetry(
                    () => executeMock(query, params),
                    action,
                    () => {}
                );
            }
        };
    }
    if (request === "../middleware/require-auth" && parent.filename === routeFile) {
        return () => {};
    }
    return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[routeFile];
require("./vacinas");
Module._load = originalLoad;

const session = { usuario: { id: "41" } };
const baseRecord = {
    nome_vacina: "Vacina A",
    status: "prevista",
    data_prevista: "2026-12-20",
    data_aplicacao: null,
    veterinario: null,
    clinica: null,
    observacoes: null
};

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
        params: {},
        body: baseRecord,
        session,
        ...request
    }, res);
    return result;
}

beforeEach(() => {
    executeMock = async () => {
        throw new Error("Unexpected database query in test");
    };
    connectionMock = async () => {
        throw new Error("Unexpected transaction in test");
    };
});

test("rejects unauthenticated requests without querying the database", async () => {
    let queryCount = 0;
    executeMock = async () => {
        queryCount++;
        return [[], []];
    };

    const result = await invoke("GET", "/pets/:petId/registros", {
        params: { petId: "8" },
        session: null
    });

    assert.equal(result.status, 401);
    assert.equal(queryCount, 0);
});

test("validates status, required dates, and calendar dates before database access", async () => {
    let queryCount = 0;
    executeMock = async () => {
        queryCount++;
        return [[], []];
    };

    const cases = [
        { ...baseRecord, status: "desconhecida" },
        { ...baseRecord, data_prevista: null },
        { ...baseRecord, data_prevista: "2026-02-30" },
        { ...baseRecord, status: "prevista", data_aplicacao: "2026-12-21" }
    ];

    for (const body of cases) {
        const result = await invoke("POST", "/pets/:petId/registros", {
            params: { petId: "8" },
            body
        });
        assert.equal(result.status, 400);
        assert.ok(Array.isArray(result.body.erros));
    }
    assert.equal(queryCount, 0);
});

test("catalogue returns the initial recommendations without creating saved rows", async () => {
    const calls = [];
    executeMock = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/FROM pet_vacina_catalogo/.test(sql)) return [[], []];
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("GET", "/pets/:petId/catalogo", {
        params: { petId: "8" }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.catalogo.map(({ id, status }) => [id, status]), [
        ["polivalente_v8_v10", null],
        ["antirrabica", null]
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, ["8"]);
});

test("catalogue retries an idempotent read once after ECONNRESET", async () => {
    let petChecks = 0;
    let catalogueReads = 0;
    const originalWarn = console.warn;
    console.warn = () => {};
    executeMock = async (sql) => {
        if (/SELECT id FROM pets/.test(sql)) {
            petChecks++;
            if (petChecks === 1) {
                const error = new Error("connection reset");
                error.code = "ECONNRESET";
                throw error;
            }
            return [[{ id: "8" }], []];
        }
        if (/FROM pet_vacina_catalogo/.test(sql)) {
            catalogueReads++;
            const error = new Error("connection reset");
            error.code = "ECONNRESET";
            if (catalogueReads === 1) throw error;
            return [[], []];
        }
        throw new Error("Unexpected SQL");
    };

    try {
        const result = await invoke("GET", "/pets/:petId/catalogo", {
            params: { petId: "8" }
        });

        assert.equal(result.status, 200);
        assert.equal(petChecks, 2);
        assert.equal(catalogueReads, 2);
    } finally {
        console.warn = originalWarn;
    }
});

test("catalogue returns a sanitized error when a read still fails after retry", async () => {
    let petChecks = 0;
    const originalError = console.error;
    console.error = () => {};
    executeMock = async (sql) => {
        if (/SELECT id FROM pets/.test(sql)) {
            petChecks++;
            const error = new Error("private database detail");
            error.code = "ECONNRESET";
            throw error;
        }
        throw new Error("Unexpected SQL");
    };
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
        const result = await invoke("GET", "/pets/:petId/catalogo", {
            params: { petId: "8" }
        });

        assert.equal(result.status, 503);
        assert.equal(petChecks, 2);
        assert.equal(JSON.stringify(result.body).includes("private database detail"), false);
    } finally {
        console.error = originalError;
        console.warn = originalWarn;
    }
});

test("catalogue reports that persistence migration is required when its table is absent", async () => {
    executeMock = async (sql) => {
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        const error = new Error("missing catalog table");
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
    };
    const originalError = console.error;
    console.error = () => {};

    try {
        const result = await invoke("GET", "/pets/:petId/catalogo", {
            params: { petId: "8" }
        });
        assert.equal(result.status, 503);
        assert.match(result.body.mensagem, /estrutura do banco precisa ser preparada/);
    } finally {
        console.error = originalError;
    }
});

test("catalogue accepts all three tutor states without marking missing data as overdue", async () => {
    for (const status of ["aplicada", "nao_aplicada", "desconhecida"]) {
        const applicationDate = status === "aplicada" ? "2026-10-13" : null;
        let connectionOpened = false;
        let savedState;
        let historyWrites = 0;
        let catalogueUpsert;
        executeMock = async () => [[{ id: "8" }], []];
        connectionMock = async () => {
            connectionOpened = true;
            return {
                async beginTransaction() {},
                async execute(sql, params) {
                    if (/SELECT status, data_aplicacao/.test(sql)) {
                        return [savedState ? [savedState] : [], []];
                    }
                    if (/INSERT INTO pet_vacina_catalogo/.test(sql)) {
                        catalogueUpsert = sql;
                        savedState = { status: params[2], data_aplicacao: params[3] };
                        return [{ affectedRows: 1 }, []];
                    }
                    if (/SELECT id FROM pet_vacinas/.test(sql)) return [[{ id: "existing-dose" }], []];
                    if (/INSERT INTO pet_vacinas/.test(sql)) historyWrites++;
                    return [{ affectedRows: 1, insertId: "20" }, []];
                },
                async commit() {},
                async rollback() {},
                release() {}
            };
        };

        const result = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
            params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
            body: { status, data_aplicacao: applicationDate }
        });

        assert.equal(result.status, 200);
        assert.equal(result.body.vacina.id, "polivalente_v8_v10");
        assert.equal(result.body.vacina.status, status);
        assert.equal(result.body.vacina.data_aplicacao, applicationDate);
        assert.equal(connectionOpened, true);
        assert.equal(savedState.status, status);
        assert.equal(savedState.data_aplicacao, applicationDate);
        assert.match(catalogueUpsert, /ON DUPLICATE KEY UPDATE status = VALUES\(status\)/);
        assert.equal(historyWrites, 0);
    }
});

test("catalogue states persist and are returned after reloading the catalogue", async () => {
    for (const status of ["aplicada", "nao_aplicada", "desconhecida"]) {
        const applicationDate = status === "aplicada" ? "2026-10-13" : null;
        let savedState = null;
        executeMock = async (sql, params) => {
            if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
            if (/FROM pet_vacina_catalogo/.test(sql)) {
                assert.deepEqual(params, ["8"]);
                return [savedState ? [savedState] : [], []];
            }
            throw new Error("Unexpected SQL");
        };
        connectionMock = async () => ({
            async beginTransaction() {},
            async execute(sql, params) {
                if (/SELECT status, data_aplicacao/.test(sql)) {
                    return [savedState ? [savedState] : [], []];
                }
                if (/INSERT INTO pet_vacina_catalogo/.test(sql)) {
                    assert.match(sql, /ON DUPLICATE KEY UPDATE/);
                    savedState = {
                        vacina_key: params[1],
                        status: params[2],
                        data_aplicacao: params[3]
                    };
                    return [{ affectedRows: 1 }, []];
                }
                if (/SELECT id FROM pet_vacinas/.test(sql)) return [[], []];
                if (/INSERT INTO pet_vacinas/.test(sql)) return [{ insertId: "91" }, []];
                throw new Error("Unexpected transaction SQL");
            },
            async commit() {},
            async rollback() {},
            release() {}
        });

        const saved = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
            params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
            body: { status, data_aplicacao: applicationDate }
        });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.vacina.status, status);
        assert.equal(saved.body.vacina.data_aplicacao, applicationDate);

        const reloaded = await invoke("GET", "/pets/:petId/catalogo", {
            params: { petId: "8" }
        });
        const polivalentEntry = reloaded.body.catalogo.find(
            ({ id }) => id === "polivalente_v8_v10"
        );
        assert.equal(polivalentEntry.status, status);
        assert.equal(polivalentEntry.data_aplicacao, applicationDate);
    }
});

test("applied catalogue states may omit the date and repeated saves do not duplicate history", async () => {
    let savedState = null;
    let historyInsertions = 0;
    let insertedHistoryParams;
    executeMock = async () => [[{ id: "8" }], []];
    connectionMock = async () => ({
        async beginTransaction() {},
        async execute(sql, params) {
            if (/SELECT status, data_aplicacao/.test(sql)) {
                return [savedState ? [savedState] : [], []];
            }
            if (/SELECT id FROM pet_vacinas/.test(sql)) {
                return [historyInsertions ? [{ id: "1" }] : [], []];
            }
            if (/INSERT INTO pet_vacina_catalogo/.test(sql)) {
                savedState = { status: params[2], data_aplicacao: params[3] };
                return [{ affectedRows: 1 }, []];
            }
            if (/INSERT INTO pet_vacinas/.test(sql)) {
                historyInsertions++;
                insertedHistoryParams = params;
                return [{ insertId: String(historyInsertions) }, []];
            }
            throw new Error("Unexpected SQL");
        },
        async commit() {},
        async rollback() {},
        release() {}
    });

    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
            params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
            body: { status: "aplicada" }
        });
        assert.equal(result.status, 200);
        assert.equal(result.body.vacina.data_aplicacao, null);
    }

    await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
        params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
        body: { status: "desconhecida" }
    });
    await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
        params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
        body: { status: "aplicada" }
    });

    assert.equal(historyInsertions, 1);
    assert.deepEqual(insertedHistoryParams, ["8", "Polivalente canina (V8/V10)", null]);
});

test("editing a catalog classification linked to a real dose does not insert a duplicate dose", async () => {
    for (const status of ["aplicada", "nao_aplicada", "desconhecida"]) {
        const applicationDate = status === "aplicada" ? "2026-06-16" : null;
        let historyWrites = 0;
        let persistedStatus = "aplicada";
        let persistedDate = "2026-06-15";
        executeMock = async () => [[{ id: "8" }], []];
        connectionMock = async () => ({
            async beginTransaction() {},
            async execute(sql, params) {
                if (/SELECT status, data_aplicacao/.test(sql)) {
                    return [[{ status: persistedStatus, data_aplicacao: persistedDate }], []];
                }
                if (/INSERT INTO pet_vacina_catalogo/.test(sql)) {
                    persistedStatus = params[2];
                    persistedDate = params[3];
                    return [{ affectedRows: 1 }, []];
                }
                if (/SELECT id FROM pet_vacinas/.test(sql)) return [[], []];
                if (/INSERT INTO pet_vacinas/.test(sql)) historyWrites++;
                throw new Error("Unexpected transaction SQL");
            },
            async commit() {},
            async rollback() {},
            release() {}
        });

        const result = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
            params: { petId: "8", vaccineKey: "polivalente_v8_v10" },
            body: {
                status,
                data_aplicacao: applicationDate,
                preserve_history: true
            }
        });

        assert.equal(result.status, 200);
        assert.equal(result.body.vacina.status, status);
        assert.equal(result.body.vacina.data_aplicacao, applicationDate);
        assert.equal(persistedDate, applicationDate);
        assert.equal(historyWrites, 0);
    }
});

test("catalogue rejects unsupported keys, states, dates, and user identity fields", async () => {
    let queryCount = 0;
    executeMock = async () => {
        queryCount++;
        return [[{ id: "8" }], []];
    };
    connectionMock = async () => {
        queryCount++;
        throw new Error("Unexpected transaction");
    };

    const cases = [
        { params: { petId: "8", vaccineKey: "unknown" }, body: { status: "aplicada" } },
        { params: { petId: "8", vaccineKey: "antirrabica" }, body: { status: "prevista" } },
        { params: { petId: "8", vaccineKey: "antirrabica" }, body: { status: "aplicada", data_aplicacao: "2026-02-30" } },
        { params: { petId: "8", vaccineKey: "antirrabica" }, body: { status: "aplicada", usuario_id: "99" } },
        { params: { petId: "8", vaccineKey: "antirrabica" }, body: { status: "desconhecida", data_aplicacao: "2026-06-15" } }
    ];

    for (const request of cases) {
        const result = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", request);
        assert.equal(result.status, 400);
    }
    assert.equal(queryCount, 0);
});

test("catalogue refuses access to another user's pet before opening a transaction", async () => {
    let transactionOpened = false;
    executeMock = async (sql, params) => {
        assert.match(sql, /id = \? AND usuario_id = \?/);
        assert.deepEqual(params, ["8", "41"]);
        return [[], []];
    };
    connectionMock = async () => {
        transactionOpened = true;
        throw new Error("Unexpected transaction");
    };

    const result = await invoke("PUT", "/pets/:petId/catalogo/:vaccineKey", {
        params: { petId: "8", vaccineKey: "antirrabica" },
        body: { status: "desconhecida" }
    });

    assert.equal(result.status, 404);
    assert.equal(transactionOpened, false);
});

test("regular application records may be saved without a known application date", async () => {
    let insertParams;
    executeMock = async (sql, params) => {
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/INSERT INTO pet_vacinas/.test(sql)) {
            insertParams = params;
            return [{ insertId: "22" }, []];
        }
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("POST", "/pets/:petId/registros", {
        params: { petId: "8" },
        body: {
            nome_vacina: "Dose anterior",
            status: "aplicada",
            data_aplicacao: null
        }
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.registro.data_aplicacao, null);
    assert.equal(insertParams[4], null);
});

test("creates valid records with the session owner and optional values", async () => {
    const calls = [];
    executeMock = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/INSERT INTO pet_vacinas/.test(sql)) return [{ insertId: "9007199254740993" }, []];
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("POST", "/pets/:petId/registros", {
        params: { petId: "8" },
        body: {
            nome_vacina: "Vacina A",
            status: "aplicada",
            data_prevista: null,
            data_aplicacao: "2026-06-15"
        }
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.registro.id, "9007199254740993");
    assert.equal(result.body.registro.pet_id, "8");
    assert.equal(calls[0].params[0], "8");
    assert.equal(calls[0].params[1], "41");
    assert.deepEqual(calls[1].params, [
        "8", "Vacina A", "aplicada", null, "2026-06-15", null, null, null
    ]);
});

test("returns 404 without accessing another user's pet records", async () => {
    const calls = [];
    executeMock = async (sql, params) => {
        calls.push({ sql, params });
        return [[], []];
    };

    const result = await invoke("GET", "/pets/:petId/registros", {
        params: { petId: "99" }
    });

    assert.equal(result.status, 404);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /id = \? AND usuario_id = \?/);
    assert.deepEqual(calls[0].params, ["99", "41"]);
});

test("updates only a record belonging to the owned pet", async () => {
    const calls = [];
    executeMock = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/UPDATE pet_vacinas/.test(sql)) return [{ affectedRows: 1 }, []];
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("PUT", "/pets/:petId/registros/:recordId", {
        params: { petId: "8", recordId: "17" },
        body: baseRecord
    });

    assert.equal(result.status, 200);
    assert.match(calls[1].sql, /WHERE id = \? AND pet_id = \?/);
    assert.deepEqual(calls[1].params.slice(-2), ["17", "8"]);
});

test("returns 404 when an update targets a record outside the selected pet", async () => {
    let queryCount = 0;
    executeMock = async (sql) => {
        queryCount++;
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/UPDATE pet_vacinas/.test(sql)) return [{ affectedRows: 0 }, []];
        if (/SELECT id FROM pet_vacinas/.test(sql)) return [[], []];
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("PUT", "/pets/:petId/registros/:recordId", {
        params: { petId: "8", recordId: "17" },
        body: baseRecord
    });

    assert.equal(result.status, 404);
    assert.equal(queryCount, 3);
});

test("deletes only a record belonging to the owned pet", async () => {
    const calls = [];
    executeMock = async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT id FROM pets/.test(sql)) return [[{ id: "8" }], []];
        if (/DELETE FROM pet_vacinas/.test(sql)) return [{ affectedRows: 1 }, []];
        throw new Error("Unexpected SQL");
    };

    const result = await invoke("DELETE", "/pets/:petId/registros/:recordId", {
        params: { petId: "8", recordId: "17" }
    });

    assert.equal(result.status, 200);
    assert.match(calls[1].sql, /WHERE id = \? AND pet_id = \?/);
    assert.deepEqual(calls[1].params, ["17", "8"]);
});

test("notifications query only scheduled records belonging to the session owner", async () => {
    let call;
    executeMock = async (sql, params) => {
        call = { sql, params };
        return [[{
            id: "17",
            pet_id: "8",
            pet_nome: "Pet de teste",
            nome_vacina: "Vacina A",
            data_prevista: "2026-12-20"
        }], []];
    };

    const result = await invoke("GET", "/notificacoes");

    assert.equal(result.status, 200);
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    assert.match(call.sql, /INNER JOIN pets AS p/);
    assert.match(call.sql, /p\.usuario_id = \?/);
    assert.match(call.sql, /v\.status = 'prevista'/);
    assert.deepEqual(call.params, ["41"]);
    assert.equal(result.body.notificacoes[0].id, "17");
});

test("returns sanitized server errors when the database fails", async () => {
    executeMock = async () => {
        const error = new Error("private database detail");
        error.code = "ECONNRESET";
        throw error;
    };
    const originalError = console.error;
    console.error = () => {};

    try {
        const result = await invoke("GET", "/notificacoes");
        assert.equal(result.status, 503);
        assert.equal(JSON.stringify(result.body).includes("private database detail"), false);
    } finally {
        console.error = originalError;
    }
});
