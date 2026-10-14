const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("serverless entrypoint reuses Express and does not start a listener on import", () => {
    const handler = read("api/[...path].js");
    const server = read("backend/server.js");
    const authRoutes = read("backend/routes/auth.js");
    const avatarRoutes = read("backend/routes/avatar.js");
    const store = read("backend/session-store.js");
    const mabelRoute = read("backend/routes/mabel.js");

    assert.match(handler, /require\("\.\.\/backend\/server"\)/);
    assert.match(handler, /return app\(req, res\)/);
    assert.match(server, /if \(require\.main === module\)\s*\{\s*iniciarServidor\(\)/);
    assert.match(server, /app\.use\("\/api\/auth", sessionMiddleware, authRouter\)/);
    assert.match(authRoutes, /const avatarRouter = require\("\.\/avatar"\)/);
    assert.match(authRoutes, /router\.use\("\/avatar", avatarRouter\)/);
    assert.match(avatarRoutes, /router\.use\(requireAuth\)/);
    assert.match(handler, /require\("\.\.\/backend\/api-route-rewrite"\)/);
    assert.doesNotMatch(server, /ensureAvaliacaoTable|CREATE TABLE/i);
    assert.match(store, /createDatabaseTable: false/);
    assert.match(server, /app\.use\("\/api\/mabel", createMabelRouter/);
    assert.match(mabelRoute, /router\.post\("\/dados"/);
    assert.match(mabelRoute, /router\.get\("\/status"/);
});

test("avatar endpoint wrapper forwards to the shared API handler", () => {
    const wrapperPath = path.resolve(root, "api/auth/avatar.js");
    const originalLoad = Module._load;
    const handler = () => {};

    Module._load = function loadSharedHandler(request, parent, isMain) {
        if (request === "../[...path]" && parent.filename === wrapperPath) {
            return handler;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[wrapperPath];
        assert.equal(require(wrapperPath), handler);
    } finally {
        Module._load = originalLoad;
        delete require.cache[wrapperPath];
    }
});

test("avatar endpoint is protected by the session authentication middleware", () => {
    const requireAuth = require("./middleware/require-auth");
    let response;
    let nextCalled = false;
    const res = {
        status(status) {
            response = { status };
            return this;
        },
        json(body) {
            response.body = body;
            return this;
        }
    };

    requireAuth({ session: null, originalUrl: "/api/auth/avatar" }, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.deepEqual(response, {
        status: 401,
        body: { sucesso: false, mensagem: "Autenticação necessária." }
    });
});

test("api directory contains only deployable endpoint handlers", () => {
    assert.equal(fs.existsSync(path.join(root, "api/route-rewrite.js")), false);
    assert.equal(fs.existsSync(path.join(root, "api/route-rewrite.test.js")), false);
    assert.equal(fs.existsSync(path.join(root, "backend/api-route-rewrite.js")), true);
    assert.equal(fs.existsSync(path.join(root, "backend/api-route-rewrite.test.js")), true);
});

test("Vercel routes preserve the private-page proxy and API aliases", () => {
    const vercel = JSON.parse(read("vercel.json"));
    assert.equal(vercel.proxy.entrypoint, "proxy.js");
    assert.deepEqual(vercel.proxy.matcher, ["/software", "/software/:path*"]);
    assert.deepEqual(vercel.rewrites, [
        {
            source: "/api/perfil/:path*",
            destination: "/api/index?__mabel_api_path=perfil/:path*"
        },
        {
            source: "/api/vacinas/:path*",
            destination: "/api/index?__mabel_api_path=vacinas/:path*"
        },
        {
            source: "/api/mabel/:path*",
            destination: "/api/index?__mabel_api_path=mabel/:path*"
        },
        {
            source: "/send-welcome",
            destination: "/api/send-welcome"
        }
    ]);
    assert.match(read("api/index.js"), /require\("\.\/\[\.{3}path\]"\)/);
    assert.match(read("api/[...path].js"), /rewriteApiRequestUrl\(req\.url\)/);
    assert.match(read("api/auth/sessao.js"), /require\("\.\.\/\[\.\.\.path\]"\)/);
    assert.match(read("api/auth/logout.js"), /require\("\.\.\/\[\.\.\.path\]"\)/);
});
