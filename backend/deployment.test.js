const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("serverless entrypoint reuses Express and does not start a listener on import", () => {
    const handler = read("api/[...path].js");
    const server = read("backend/server.js");
    const store = read("backend/session-store.js");
    const mabelRoute = read("backend/routes/mabel.js");

    assert.match(handler, /require\("\.\.\/backend\/server"\)/);
    assert.match(handler, /return app\(req, res\)/);
    assert.match(server, /if \(require\.main === module\)\s*\{\s*iniciarServidor\(\)/);
    assert.doesNotMatch(server, /ensureAvaliacaoTable|CREATE TABLE/i);
    assert.match(store, /createDatabaseTable: false/);
    assert.match(server, /app\.use\("\/api\/mabel", createMabelRouter/);
    assert.match(mabelRoute, /router\.post\("\/dados"/);
    assert.match(mabelRoute, /router\.get\("\/status"/);
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
