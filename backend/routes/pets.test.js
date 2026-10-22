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

const PET_WITH_SESSIONS_MESSAGE = "Este pet possui sessões registradas. A exclusão não pode ser realizada por esta operação.";

// Simula as três consultas da exclusão e registra cada uma, para provar que nada além delas é executado.
function deletionDatabase({ owned = true, sessions = [], sessionsError = null, deleteError = null, affectedRows = 1 } = {}) {
    const queries = [];
    executeMock = async (query, params) => {
        const sql = query.replace(/\s+/g, " ").trim();
        queries.push({ sql, params });
        if (sql.startsWith("SELECT id FROM pets WHERE id = ? AND usuario_id = ?")) {
            return [owned ? [{ id: params[0] }] : [], []];
        }
        if (sql.startsWith("SELECT id FROM mabel_sessoes WHERE pet_id = ? AND usuario_id = ?")) {
            if (sessionsError) throw sessionsError;
            return [sessions, []];
        }
        if (sql.startsWith("DELETE FROM pets WHERE id = ? AND usuario_id = ?")) {
            if (deleteError) throw deleteError;
            return [{ affectedRows }, []];
        }
        throw new Error(`Unexpected query in pet deletion test: ${sql}`);
    };
    return {
        queries,
        deletes: () => queries.filter((query) => query.sql.startsWith("DELETE")).length
    };
}

function deletePet(petId = "22", request = {}) {
    return invoke("DELETE", "/pet/:id", { params: { id: petId }, ...request });
}

function sqlError(code, errno, message) {
    return Object.assign(new Error(message), { code, errno, sqlState: "23000" });
}

test("um pet com sessões registradas não é excluído e recebe 409 com mensagem clara", async () => {
    const database = deletionDatabase({ sessions: [{ id: "7" }] });

    const result = await deletePet("22");

    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { sucesso: false, mensagem: PET_WITH_SESSIONS_MESSAGE });
    assert.equal(database.deletes(), 0, "nenhum DELETE é enviado: pet, sessões e comandos permanecem");
    const sessionsQuery = database.queries.find((query) => /FROM mabel_sessoes/.test(query.sql));
    assert.deepEqual(sessionsQuery.params, ["22", "41"], "o histórico é verificado pelo pet e pelo usuário autenticado");
    assert.equal(database.queries.some((query) => /DELETE FROM mabel_sessoes/.test(query.sql)), false);
});

test("um pet sem sessões continua sendo excluído normalmente", async () => {
    const database = deletionDatabase();

    const result = await deletePet("23");

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { sucesso: true, mensagem: "Pet excluído com sucesso." });
    assert.equal(database.deletes(), 1);
    assert.deepEqual(database.queries.at(-1).params, ["23", "41"]);
});

test("sem a tabela de sessões ou sem a coluna pet_id a exclusão é bloqueada com 503 e nenhum DELETE", async () => {
    for (const [code, errno, message] of [
        ["ER_NO_SUCH_TABLE", 1146, "Table 'alunos_projetoMabel.mabel_sessoes' doesn't exist"],
        ["ER_BAD_FIELD_ERROR", 1054, "Unknown column 'pet_id' in 'where clause'"]
    ]) {
        const database = deletionDatabase({ sessionsError: sqlError(code, errno, message) });
        const result = await deletePet("23");
        assert.equal(result.status, 503, code);
        assert.deepEqual(result.body, {
            sucesso: false,
            mensagem: "Não foi possível verificar o histórico de sessões deste pet. "
                + "A exclusão foi bloqueada por segurança. Tente novamente mais tarde."
        });
        assert.doesNotMatch(JSON.stringify(result.body), /ER_|mabel_sessoes|pet_id|Table|column|SELECT/i, code);
        assert.equal(database.deletes(), 0, `${code}: o pet não é excluído sem verificar o histórico`);
    }
});

test("outras falhas ao consultar o histórico seguem o tratamento de erro sem excluir o pet", async () => {
    for (const code of ["ECONNRESET", "ER_LOCK_WAIT_TIMEOUT", "ER_ACCESS_DENIED_ERROR"]) {
        const database = deletionDatabase({ sessionsError: sqlError(code, 0, "falha") });
        const result = await deletePet("23");
        assert.equal(result.status, 500, code);
        assert.deepEqual(result.body, { sucesso: false }, "a resposta não traz detalhes do banco");
        assert.equal(database.deletes(), 0, code);
    }
});

test("a exclusão exige autenticação e propriedade do pet sem revelar o histórico de outra conta", async () => {
    const noSession = deletionDatabase();
    assert.equal((await deletePet("22", { session: null })).status, 401);
    assert.equal((await deletePet("22", { session: { usuario: { id: "abc" } } })).status, 401);
    assert.equal(noSession.queries.length, 0);

    const invalidId = deletionDatabase();
    assert.equal((await deletePet("abc")).status, 400);
    assert.equal(invalidId.queries.length, 0);

    const otherOwner = deletionDatabase({ owned: false, sessions: [{ id: "7" }] });
    const result = await deletePet("99");
    assert.equal(result.status, 404, "um pet de outra conta é tratado como inexistente, mesmo com sessões");
    assert.equal(result.body.mensagem, "Pet não encontrado.");
    assert.equal(otherOwner.deletes(), 0);
    assert.equal(otherOwner.queries.some((query) => /mabel_sessoes/.test(query.sql)), false);
});

test("as duas variantes de violação de chave estrangeira do MySQL viram 409 sem detalhes internos", async () => {
    for (const [code, errno, message] of [
        ["ER_ROW_IS_REFERENCED", 1217, "Cannot delete or update a parent row: a foreign key constraint fails"],
        [
            "ER_ROW_IS_REFERENCED_2",
            1451,
            "Cannot delete or update a parent row: a foreign key constraint fails (`mabel`.`mabel_sessoes`, CONSTRAINT `fk_mabel_sessoes_pet` FOREIGN KEY (`pet_id`) REFERENCES `pets` (`id`))"
        ],
        // Algumas camadas preservam apenas o número do erro.
        [undefined, 1451, "foreign key constraint fails"]
    ]) {
        // A verificação não encontra sessões (por exemplo, criadas logo depois), mas o RESTRICT recusa o DELETE.
        const database = deletionDatabase({ deleteError: sqlError(code, errno, message) });
        const result = await deletePet("22");
        assert.equal(result.status, 409, String(code));
        assert.deepEqual(result.body, { sucesso: false, mensagem: PET_WITH_SESSIONS_MESSAGE });
        assert.doesNotMatch(JSON.stringify(result.body), /ER_|1451|1217|CONSTRAINT|FOREIGN|mabel_sessoes|pet_id/);
        assert.equal(database.deletes(), 1, "o MySQL recusou o único DELETE enviado; nenhuma nova tentativa é feita");
    }

    deletionDatabase({ deleteError: sqlError("ER_LOCK_WAIT_TIMEOUT", 1205, "Lock wait timeout exceeded") });
    assert.equal((await deletePet("22")).status, 500, "outros erros continuam no tratamento genérico");
});

test("um pet removido entre a verificação e a exclusão continua respondendo 404", async () => {
    deletionDatabase({ affectedRows: 0 });
    const result = await deletePet("22");
    assert.equal(result.status, 404);
    assert.equal(result.body.mensagem, "Pet não encontrado.");
});
