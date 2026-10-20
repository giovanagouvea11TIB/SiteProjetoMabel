const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const State = require("./controle-state");

const html = fs.readFileSync(path.join(__dirname, "controle.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "controle.js"), "utf8");

test("validação do aplicativo só permite ligar com intensidade 1-100 e durações oferecidas", () => {
    assert.equal(State.validateTurnOn(40, 60), null);
    assert.equal(State.validateTurnOn(100, 600), null);
    assert.match(State.validateTurnOn(0, 60), /1% a 100%/);
    assert.match(State.validateTurnOn(101, 60), /1% a 100%/);
    assert.match(State.validateTurnOn(40.5, 60), /1% a 100%/);
    assert.match(State.validateTurnOn(40, 45), /durações/);
    assert.deepEqual(State.buildTurnOnPayload("22", 40, 60), { pet_id: "22", ligado: true, intensidade: 40, duracao_s: 60 });
    assert.deepEqual(State.buildTurnOffPayload("22"), { pet_id: "22", ligado: false });
    assert.equal(State.validateDeviceId("mabel-esp32-01"), null);
    assert.ok(State.validateDeviceId("mabel esp32"));
});

test("estado solicitado, confirmado e offline são descritos separadamente", () => {
    assert.deepEqual(State.describeConnection({ tem_associacao: true, online: false }), { online: false, label: "ESP32 offline" });
    assert.deepEqual(State.describeConnection({ tem_associacao: true, online: true }), { online: true, label: "ESP32 online" });
    assert.equal(State.describeConnection({ tem_associacao: false }).label, "Sem dispositivo associado");

    const pending = State.describeRequested({ ligado: true, intensidade: 40, duracao_s: 60, estado: "pendente", solicitado_em: null });
    assert.match(pending, /Ligar a 40% por 1 min — aguardando a ESP32/);
    const simulated = State.describeConfirmed({ ligado: true, intensidade: 40, fisico: false, motivo: "comando", confirmado_em: null });
    assert.match(simulated, /^Simulação: os motores ligariam a 40% \(acionamento físico bloqueado na placa\)/);
    assert.doesNotMatch(simulated, /Motores ligados/, "a simulação não pode ser apresentada como acionamento real");
    assert.match(
        State.describeConfirmed({ ligado: true, intensidade: 40, fisico: true, motivo: "comando", confirmado_em: null }),
        /^Motores ligados a 40% \(acionamento físico\)/
    );
    assert.match(State.describeConfirmed(null), /ainda não confirmou/);
});

test("comandos não aplicados geram mensagens de erro visíveis", () => {
    assert.match(State.commandProblem({ estado: "rejeitado" }), /recusou/);
    assert.match(State.commandProblem({ estado: "expirado" }), /expirou/);
    assert.match(State.commandProblem({ estado: "interrompido", motivo: "comunicacao" }), /perda de comunicação/);
    assert.equal(State.commandProblem({ estado: "interrompido", motivo: "duracao" }), null);
    assert.equal(State.commandProblem({ estado: "aplicado" }), null);
    assert.equal(State.formatCountdown(59001), "01:00");
    assert.equal(State.formatCountdown(0), "00:00");
});

test("a página de controle expõe os controles acessíveis e usa as rotas autenticadas", () => {
    for (const id of [
        "controle-pet", "controle-conexao", "controle-device-id", "controle-associar-btn",
        "controle-desassociar-btn", "motor-intensidade", "motor-ligar-btn", "motor-desligar-btn",
        "motor-solicitado", "motor-confirmado"
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /id="motor-intensidade"[^>]*min="0"[^>]*max="100"/);
    assert.match(html, /id="motor-status"[^>]*aria-live="polite"/);
    assert.match(html, /id="motor-erro"[^>]*role="alert"/);
    assert.match(html, /src="\.\/controle-state\.js"/);
    assert.doesNotMatch(html, /Integração indisponível/);

    assert.match(script, /\/api\/mabel\/motores\?pet_id=/);
    assert.match(script, /jsonRequest\("\/api\/mabel\/motores", "POST"/);
    assert.match(script, /\/api\/mabel\/associacoes/);
    assert.match(script, /response\.status === 401/);
    assert.match(script, /textContent/);
    assert.doesNotMatch(script, /innerHTML/);
    assert.doesNotMatch(script, /\/api\/mabel\/config/, "o aplicativo não usa a rota do dispositivo");
});

test("o formulário de associação some quando oculto e a espera pela ESP32 não fica desatualizada", () => {
    const css = fs.readFileSync(path.join(__dirname, "controle.css"), "utf8");
    // .device-associate, .motor-error e os botões usam display próprio, que anularia o atributo hidden sem esta regra.
    assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;/m);
    assert.match(script, /solicitado\?\.command_id !== awaitingCommandId \|\| solicitado\.estado !== "pendente"/);
});
