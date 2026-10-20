const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const directory = __dirname;
const html = fs.readFileSync(path.join(directory, "perfil.html"), "utf8");
const script = fs.readFileSync(path.join(directory, "perfil.js"), "utf8");

test("pet profile exposes safe Mabel link, status, refresh, and confirmed unlink controls", () => {
    assert.match(html, /id="pet-selector"/);
    assert.match(html, /id="mabel-device-id"/);
    assert.match(html, /id="mabel-link-btn"/);
    assert.match(html, /id="mabel-unlink-btn"/);
    assert.match(html, /id="mabel-refresh-btn"/);
    assert.match(html, /id="mabel-status"[^>]*aria-live="polite"/);
    // Usa a mesma API de associações do Controle da Órtese (tabela mabel_pet_associations).
    assert.match(script, /\/api\/mabel\/associacoes\?pet_id=/);
    assert.match(script, /mabelRequest\('\/api\/mabel\/associacoes', \{\s*method: 'POST'/);
    assert.match(script, /associacoes\?pet_id=\$\{encodeURIComponent\(selectedPetId\)\}`,\s*\{ method: 'DELETE' \}/);
    assert.match(script, /\/api\/mabel\/status\?pet_id=/);
    assert.match(script, /reading\.ultimo_contato/);
    assert.doesNotMatch(script, /\/api\/mabel\/vinculos/);
    assert.match(script, /window\.confirm\(/);
    assert.match(script, /textContent = message/);
});

test("o padrão do identificador é válido nos navegadores atuais (atributo pattern usa a flag v)", () => {
    const pattern = html.match(/id="mabel-device-id"[\s\S]*?pattern="([^"]+)"/)[1];
    const regex = new RegExp(`^(?:${pattern})$`, "v");
    assert.ok(regex.test("mabel-esp32-01"));
    assert.ok(!regex.test("id com espaço"));
});
