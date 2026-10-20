// Compila no computador o bloco de lógica dos motores extraído de esp32-mabel.ino e executa
// host-test/motor_logic_test.cpp. Cada confirmação gerada é validada pelo backend real.
// Compilador: variável MABEL_CXX (ex.: "zig c++") ou zig/g++/clang++ no PATH; sem compilador, o teste é pulado.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { validateConfirmation } = require("../../backend/routes/mabel-motores");

const BEGIN = "// MABEL_MOTOR_LOGIC_BEGIN";
const END = "// MABEL_MOTOR_LOGIC_END";

function findCompiler() {
    const candidates = process.env.MABEL_CXX ? [process.env.MABEL_CXX] : ["zig c++", "g++", "clang++"];
    return candidates.find((command) => spawnSync(`${command} --version`, { shell: true, stdio: "ignore" }).status === 0);
}

const compiler = findCompiler();

test("a lógica C++ dos motores passa nos cenários e gera confirmações aceitas pelo backend", {
    skip: compiler ? false : "Nenhum compilador C++ encontrado (defina MABEL_CXX)."
}, () => {
    const firmware = fs.readFileSync(path.join(__dirname, "esp32-mabel.ino"), "utf8");
    const start = firmware.indexOf(BEGIN);
    const end = firmware.indexOf(END);
    assert.ok(start >= 0 && end > start, "marcadores do bloco de lógica presentes");
    const logic = firmware.slice(start + BEGIN.length, end);
    assert.doesNotMatch(logic, /\b(Serial|millis|digitalWrite|ledcWrite|WiFi|String)\b/, "o bloco não usa APIs do Arduino");

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mabel-logic-"));
    try {
        fs.writeFileSync(path.join(workDir, "mabel_motor_logic.generated.h"), `#pragma once\n${logic}`);
        const binary = path.join(workDir, process.platform === "win32" ? "motor_logic_test.exe" : "motor_logic_test");
        const source = path.join(__dirname, "host-test", "motor_logic_test.cpp");
        const build = spawnSync(
            `${compiler} -std=c++17 -Wall -Wextra -Werror -I "${workDir}" "${source}" -o "${binary}"`,
            { shell: true, encoding: "utf8" }
        );
        assert.equal(build.status, 0, `compilação falhou:\n${build.stdout}\n${build.stderr}`);

        const run = spawnSync(binary, { encoding: "utf8" });
        const lines = run.stdout.split(/\r?\n/);
        const failures = lines.filter((line) => line.startsWith("FALHA"));
        assert.deepEqual(failures, [], failures.join("\n"));
        assert.equal(run.status, 0, run.stdout);
        const summary = lines.find((line) => line.startsWith("RESULTADO"));
        assert.match(summary, /checks=\d+ falhas=0/);

        const acks = lines.filter((line) => line.startsWith("ACK ")).map((line) => JSON.parse(line.slice(4)));
        assert.ok(acks.length >= 20, "os cenários geram confirmações");
        for (const ack of acks) {
            const { error } = validateConfirmation(ack);
            assert.equal(error, undefined, `confirmação recusada pelo backend: ${JSON.stringify(ack)} -> ${error}`);
        }
        const kinds = new Set(acks.map((ack) => `${ack.resultado}/${ack.motivo}`));
        for (const kind of [
            "aplicado/comando", "rejeitado/invalido", "interrompido/duracao",
            "interrompido/comunicacao", "interrompido/reinicio", "interrompido/recusado_servidor"
        ]) {
            assert.ok(kinds.has(kind), `confirmação ${kind} exercitada`);
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
});
