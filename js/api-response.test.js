const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fetchJson, errorMessage } = require("./api-response");

test("api response helper distinguishes network failure from HTTP failure", async () => {
    await assert.rejects(
        fetchJson(async () => { throw new TypeError("fetch failed"); }, "/api/test"),
        /nenhuma resposta HTTP/
    );

    const httpFailure = await fetchJson(async () => ({
        status: 503,
        ok: false,
        async json() { return { sucesso: false, mensagem: "Temporariamente indisponível." }; }
    }), "/api/test");
    assert.equal(httpFailure.response.status, 503);
    assert.equal(errorMessage(httpFailure.response, httpFailure.result, "fallback"), "Temporariamente indisponível.");
});

test("api response helper reports invalid JSON and malformed response objects clearly", async () => {
    await assert.rejects(
        fetchJson(async () => ({
            status: 200,
            ok: true,
            async json() { throw new SyntaxError("invalid"); }
        }), "/api/test"),
        /retornou dados inválidos/
    );

    const httpFailure = await fetchJson(async () => ({
        status: 502,
        ok: false,
        async json() { throw new SyntaxError("invalid"); }
    }), "/api/test");
    assert.equal(httpFailure.result, null);
    assert.match(errorMessage(httpFailure.response, null, "fallback"), /HTTP 502/);

    await assert.rejects(
        fetchJson(async () => undefined, "/api/test"),
        /resposta HTTP válida/
    );
});
