const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { rewriteApiRequestUrl } = require("./route-rewrite");

test("rewrites a nested pet API path and preserves the original query string", () => {
    assert.equal(
        rewriteApiRequestUrl(
            "/api/index?__mabel_api_path=perfil/pet/42&include=details"
        ),
        "/api/perfil/pet/42?include=details"
    );
});

test("rewrites vaccine and device routes without changing their path segments", () => {
    assert.equal(
        rewriteApiRequestUrl("/api/index?__mabel_api_path=vacinas/pets/42/registros"),
        "/api/vacinas/pets/42/registros"
    );
    assert.equal(
        rewriteApiRequestUrl("/api/index?__mabel_api_path=mabel/status"),
        "/api/mabel/status"
    );
});

test("leaves direct API URLs untouched when they do not carry rewrite metadata", () => {
    assert.equal(
        rewriteApiRequestUrl("/api/status?check=ready"),
        "/api/status?check=ready"
    );
});

test("rejects malformed or duplicated rewrite paths", () => {
    assert.equal(rewriteApiRequestUrl("/api/index?__mabel_api_path=perfil"), null);
    assert.equal(
        rewriteApiRequestUrl("/api/index?__mabel_api_path=perfil/../auth"),
        null
    );
    assert.equal(
        rewriteApiRequestUrl(
            "/api/index?__mabel_api_path=perfil/pet&__mabel_api_path=mabel/status"
        ),
        null
    );
});

test("serverless entrypoint restores the routed pet path before invoking Express", () => {
    const handlerPath = path.resolve(__dirname, "[...path].js");
    const originalLoad = Module._load;
    let receivedUrl;

    Module._load = function loadWithAppStub(request, parent, isMain) {
        if (request === "../backend/server" && parent.filename === handlerPath) {
            return {
                app(req, res) {
                    receivedUrl = req.url;
                    return res.status(401).json({ sucesso: false });
                }
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[handlerPath];
    const handler = require("./[...path]");
    Module._load = originalLoad;

    const response = {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };

    handler(
        { url: "/api/index?__mabel_api_path=perfil/pet&from=profile" },
        response
    );

    assert.equal(receivedUrl, "/api/perfil/pet?from=profile");
    assert.equal(response.statusCode, 401);
});
