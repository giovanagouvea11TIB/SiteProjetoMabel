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
    // O atributo pattern é compilado com a flag v: o hífen precisa estar escapado na classe.
    const pattern = html.match(/id="controle-device-id"[\s\S]*?pattern="([^"]+)"/)[1];
    assert.ok(new RegExp(`^(?:${pattern})$`, "v").test("mabel-esp32-01"));
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

const { createPage, session, history } = require("./page-test-dom");

test("o histórico real só é aceito quando pertence ao pet consultado e segue o formato da API", () => {
    const valid = history("22", [session(), session({ id: "2", fisico: null, encerramento: null, estado: "ativa", termino_em: null })]);
    assert.deepEqual(State.parseSessionHistory(valid, "22"), { sessoes: valid.sessoes, maisRegistros: false });
    assert.equal(State.parseSessionHistory(valid, "23"), null, "resposta de outro pet é descartada");
    for (const invalid of [
        null,
        { ...valid, sessoes: "x" },
        { ...valid, mais_registros: "não" },
        history("22", [session({ fisico: "sim" })]),
        history("22", [session({ encerramento: "confirmado_fisicamente" })]),
        history("22", [session({ intensidade_geral: "40" })]),
        history("22", [session({ inicio_em: 1729519392000 })])
    ]) {
        assert.equal(State.parseSessionHistory(invalid, "22"), null, JSON.stringify(invalid));
    }
});

test("as sessões reais distinguem simulação, acionamento físico declarado e modo desconhecido", () => {
    assert.match(State.describeSessionMode(false).label, /^Simulação: nenhum motor foi acionado/);
    assert.match(State.describeSessionMode(true).label, /declarado pela ESP32/);
    assert.equal(State.describeSessionMode(null).label, "Modo não informado");

    const finished = State.describeSession(session());
    assert.match(finished.quando, /^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/, "data e hora em pt-BR");
    assert.equal(finished.duracao, "2 min (solicitada)", "a duração é sempre a solicitada");
    assert.equal(finished.intensidade, "40% nos cinco motores");
    assert.equal(finished.dispositivo, "ESP32 · mabel-esp32-01");
    assert.equal(finished.encerramento, "Confirmado pela ESP32");
    assert.match(finished.termino, /^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/);

    const inferred = State.describeSession(session({ estado: "sem_confirmacao", encerramento: "inferido", termino_em: null }));
    assert.equal(inferred.estado.label, "Sem confirmação de término");
    assert.match(inferred.encerramento, /^Inferido .*a ESP32 não confirmou$/);
    assert.equal(inferred.termino, "Horário não registrado", "nenhum horário é inventado");
    assert.doesNotMatch(Object.values(inferred).map((value) => value.label || value).join(" "), /Confirmado/);

    const active = State.describeSession(session({ estado: "ativa", encerramento: null, termino_em: null }));
    assert.equal(active.encerramento, "Aguardando a confirmação de término");
    assert.equal(active.termino, "Ainda não informado");

    const legacy = State.describeSession(session({ estado: "finalizada", encerramento: null, inicio_em: null, termino_em: null }));
    assert.equal(legacy.estado.tone, "desconhecido");
    assert.match(legacy.quando, /^Registrada em /);
    assert.equal(State.describeSession(session({ inicio_em: null, criado_em: null })).quando, "Data não registrada");
});

test("a contagem não afirma histórico completo quando há registros além do limite", () => {
    assert.equal(State.describeSessionCount(0, false), "Nenhuma sessão real registrada para este pet.");
    assert.equal(State.describeSessionCount(1, false), "1 sessão real registrada.");
    assert.equal(State.describeSessionCount(3, false), "3 sessões reais registradas.");
    assert.match(State.describeSessionCount(50, true), /50 sessões reais mais recentes\. Há registros anteriores/);
    assert.deepEqual(
        State.summarizeSessions([
            session({ fisico: false }),
            session({ fisico: true, encerramento: "inferido" }),
            session({ fisico: null })
        ]),
        { total: 3, simulacao: 1, fisico: 1, inferidas: 1 }
    );
});

const PETS = { sucesso: true, pets: [{ id: 22, nome: "Mel" }, { id: 23, nome: "Thor" }] };

function motorStatus(overrides = {}) {
    return {
        sucesso: true,
        tem_associacao: true,
        device_id: "mabel-esp32-01",
        online: true,
        ultimo_contato: "2026-10-21T14:03:12.000Z",
        offline_apos_ms: 15000,
        solicitado: null,
        confirmado: null,
        ...overrides
    };
}

async function startControle() {
    const page = createPage(["./controle.js"], { durations: [30, 60, 120, 300, 600] });
    page.start();
    await page.respond("/api/perfil/pet", 200, PETS);
    return page;
}

function controleTitles(page) {
    return page.element("controle-historico-lista").findAll((node) => node.tagName === "H3").map((node) => node.textContent);
}

test("o Controle mostra o histórico real do pet e não exibe registros do pet anterior durante a troca", async () => {
    const page = await startControle();
    const list = page.element("controle-historico-lista");
    const status = page.element("controle-historico-status");
    assert.equal(page.pending("/api/mabel/sessoes?pet_id=22").length, 1);

    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [
        session({ id: "5", device_id: "<img src=x onerror=alert(1)>", fisico: true, estado: "ativa", encerramento: null, termino_em: null }),
        session({ id: "4", estado: "sem_confirmacao", encerramento: "inferido", termino_em: null })
    ]));
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus());
    assert.equal(list.hidden, false);
    assert.equal(list.childElementCount, 2);
    assert.equal(status.textContent, "2 sessões reais registradas.");
    const text = list.textContent;
    assert.match(text, /ESP32 · <img src=x onerror=alert\(1\)>/, "o identificador é exibido como texto");
    assert.match(text, /Acionamento físico \(declarado pela ESP32\)/);
    assert.match(text, /Inferido pela perda de comunicação; a ESP32 não confirmou/);
    assert.match(text, /2 min \(solicitada\)/);

    const select = page.element("controle-pet");
    select.value = "23";
    select.dispatch("change");
    assert.equal(list.hidden, true, "a lista do pet anterior some imediatamente");
    assert.equal(list.childElementCount, 0);
    assert.equal(status.textContent, "Carregando o histórico de sessões reais...");

    // Troca rápida de volta e respostas fora de ordem: só a consulta mais recente é exibida.
    select.value = "22";
    select.dispatch("change");
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [session({ id: "9" })]));
    await page.respond("/api/mabel/sessoes?pet_id=23", 200, history("23", [session({ id: "7" }), session({ id: "8" })]));
    assert.equal(list.childElementCount, 1);
    assert.equal(status.textContent, "1 sessão real registrada.");
    assert.equal(page.storage.get("mabel.selectedPetId"), "22");
});

test("o Controle informa histórico vazio, resposta inválida e falha de rede sem mostrar dados", async () => {
    const page = await startControle();
    const list = page.element("controle-historico-lista");
    const status = page.element("controle-historico-status");
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", []));
    assert.equal(status.textContent, "Nenhuma sessão real registrada para este pet.");
    assert.equal(list.hidden, true);
    assert.equal(status.classList.contains("is-error"), false);

    const select = page.element("controle-pet");
    select.value = "23";
    select.dispatch("change");
    await page.respond("/api/mabel/sessoes?pet_id=23", 200, history("22", [session()]));
    assert.equal(status.textContent, "A resposta do histórico de sessões é inválida.");
    assert.equal(status.classList.contains("is-error"), true);
    assert.equal(list.childElementCount, 0, "a resposta de outro pet é descartada");

    select.value = "22";
    select.dispatch("change");
    await page.fail("/api/mabel/sessoes?pet_id=22");
    assert.match(status.textContent, /Não foi possível conectar ao servidor/);
    assert.equal(list.hidden, true);

    select.value = "23";
    select.dispatch("change");
    await page.respond("/api/mabel/sessoes?pet_id=23", 503, {
        sucesso: false,
        mensagem: "O histórico de sessões ainda não está disponível. A estrutura do banco precisa ser preparada."
    });
    assert.match(status.textContent, /ainda não está disponível/);
});

test("o Controle só consulta o histórico de novo quando comando, confirmação ou conexão mudam", async () => {
    const page = await startControle();
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", []));
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus());
    const historyRequests = () => page.requests.filter((request) => request.url.includes("/api/mabel/sessoes")).length;
    assert.equal(historyRequests(), 1);

    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus());
    assert.equal(historyRequests(), 1, "consultas de estado iguais não repetem o histórico");

    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({
        confirmado: { command_id: "10", ligado: true, intensidade: 40, fisico: false, motivo: "comando", confirmado_em: "2026-10-21T14:04:00.000Z" }
    }));
    assert.equal(historyRequests(), 2, "uma nova confirmação recarrega o histórico");
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [session({ estado: "ativa", encerramento: null, termino_em: null })]));

    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({
        online: false,
        confirmado: { command_id: "10", ligado: true, intensidade: 40, fisico: false, motivo: "comando", confirmado_em: "2026-10-21T14:04:00.000Z" }
    }));
    assert.equal(historyRequests(), 3, "a perda de conexão recarrega o histórico para mostrar a inferência");
});

async function startOperableControle() {
    const page = createPage(["./controle.js"], { durations: [30, 60, 120, 300, 600] });
    page.element("motor-intensidade").value = "40";
    page.start();
    await page.respond("/api/perfil/pet", 200, PETS);
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", []));
    return page;
}

function onCommand(overrides = {}) {
    return {
        command_id: "15",
        ligado: true,
        intensidade: 40,
        duracao_s: 60,
        estado: "pendente",
        motivo: null,
        ativo: true,
        duracao_restante_ms: 42000,
        solicitado_em: "2026-10-21T14:03:12.000Z",
        atualizado_em: null,
        ...overrides
    };
}

function confirmedState(overrides = {}) {
    return {
        command_id: "15",
        ligado: true,
        intensidade: 40,
        fisico: false,
        motivo: "comando",
        confirmado_em: "2026-10-21T14:03:13.000Z",
        ...overrides
    };
}

test("o cronômetro só corre depois que a ESP32 confirma ter ligado com o mesmo comando", async () => {
    const page = await startOperableControle();
    const timer = page.element("motor-tempo");
    const pollWith = async (status) => {
        await page.poll();
        await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus(status));
    };

    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({ solicitado: onCommand() }));
    assert.equal(timer.textContent, "01:00", "comando pendente: mostra a duração escolhida, sem contagem");

    await pollWith({ solicitado: onCommand({ estado: "aplicado" }), confirmado: confirmedState({ command_id: "14" }) });
    assert.equal(timer.textContent, "01:00", "a confirmação de outro comando não inicia o cronômetro");

    await pollWith({
        solicitado: onCommand({ estado: "aplicado" }),
        confirmado: confirmedState({ ligado: false, intensidade: 0 })
    });
    assert.equal(timer.textContent, "01:00", "motores confirmados como desligados não iniciam o cronômetro");

    await pollWith({ solicitado: onCommand({ estado: "pendente" }), confirmado: confirmedState() });
    assert.equal(timer.textContent, "01:00", "o comando ainda precisa estar aplicado");

    await pollWith({ solicitado: onCommand({ estado: "aplicado" }), confirmado: confirmedState() });
    assert.equal(timer.textContent, "00:42", "aplicado e confirmado pela ESP32: a contagem começa");

    await pollWith({
        solicitado: onCommand({ estado: "concluido", ativo: false, duracao_restante_ms: 0 }),
        confirmado: confirmedState()
    });
    assert.equal(timer.textContent, "01:00", "a contagem para quando o comando deixa de estar ativo");
});

test("ao chegar a zero o cronômetro fica em 00:00 até o servidor informar o fim, sem reiniciar", async () => {
    const page = await startOperableControle();
    const timer = page.element("motor-tempo");
    const running = (remainingMs) => motorStatus({
        solicitado: onCommand({ estado: "aplicado", duracao_restante_ms: remainingMs }),
        confirmado: confirmedState()
    });

    await page.respond("/api/mabel/motores?pet_id=22", 200, running(2500));
    assert.equal(timer.textContent, "00:03");
    await page.tick(1000);
    assert.equal(timer.textContent, "00:02");
    await page.tick(1500);
    assert.equal(timer.textContent, "00:00");
    await page.tick(5000);
    assert.equal(timer.textContent, "00:00", "não fica negativo nem volta à duração escolhida sozinho");

    // O servidor ainda informa o comando em andamento: a contagem é sincronizada, sem reiniciar do início.
    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=22", 200, running(1000));
    assert.equal(timer.textContent, "00:01");
    await page.tick(3000);
    assert.equal(timer.textContent, "00:00");

    // Fim confirmado: interrupção por duração e motores desligados, com a ESP32 ainda online.
    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({
        solicitado: onCommand({ estado: "interrompido", motivo: "duracao", ativo: false, duracao_restante_ms: 0 }),
        confirmado: confirmedState({ ligado: false, intensidade: 0, motivo: "duracao" })
    }));
    assert.equal(timer.textContent, "01:00", "volta a mostrar a duração escolhida para o próximo comando");
    await page.tick(5000);
    assert.equal(timer.textContent, "01:00");
    assert.equal(page.element("controle-conexao").textContent, "ESP32 online");
    assert.match(page.element("motor-confirmado").textContent, /^Simulação: motores desligados/, "online não significa motores ligados");
    assert.equal(
        page.requests.some((request) => request.options?.method === "POST"),
        false,
        "nenhum comando é enviado automaticamente"
    );
});

test("ao trocar de pet, o estado do pet anterior some e os controles ficam bloqueados até a nova consulta", async () => {
    const page = await startOperableControle();
    const connection = page.element("controle-conexao");
    const device = page.element("controle-dispositivo");
    const requestedState = page.element("motor-solicitado");
    const confirmedEsp = page.element("motor-confirmado");
    const turnOn = page.element("motor-ligar-btn");
    const turnOff = page.element("motor-desligar-btn");
    const timer = page.element("motor-tempo");
    const error = page.element("motor-erro");

    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({
        solicitado: onCommand({ estado: "aplicado" }),
        confirmado: confirmedState()
    }));
    assert.equal(connection.textContent, "ESP32 online");
    assert.equal(turnOn.disabled, false);
    assert.equal(turnOff.disabled, false);
    assert.equal(timer.textContent, "00:42");

    // Uma consulta do pet anterior ainda está em andamento quando a troca acontece.
    await page.poll();
    const select = page.element("controle-pet");
    select.value = "23";
    select.dispatch("change");
    const cleared = () => {
        assert.equal(connection.textContent, "Verificando...");
        assert.equal(connection.classList.contains("badge-connected"), false);
        assert.equal(device.textContent, "ESP32");
        assert.equal(requestedState.textContent, "—");
        assert.equal(confirmedEsp.textContent, "—");
        assert.equal(timer.textContent, "01:00", "o cronômetro do pet anterior para");
        assert.equal(turnOn.disabled, true);
        assert.equal(turnOff.disabled, true);
    };
    cleared();

    await page.respond("/api/mabel/motores?pet_id=22", 200, motorStatus({
        solicitado: onCommand({ estado: "aplicado" }),
        confirmado: confirmedState()
    }));
    cleared();

    await page.fail("/api/mabel/motores?pet_id=23");
    assert.equal(connection.textContent, "Estado indisponível");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /Não foi possível conectar ao servidor/);
    assert.equal(turnOn.disabled, true, "sem estado do pet novo, ligar continua bloqueado");
    assert.equal(turnOff.disabled, true);
    assert.equal(requestedState.textContent, "—");

    await page.poll();
    await page.respond("/api/mabel/motores?pet_id=23", 200, motorStatus({ device_id: "mabel-esp32-02" }));
    assert.equal(connection.textContent, "ESP32 online");
    assert.equal(device.textContent, "ESP32 · mabel-esp32-02");
    assert.equal(error.hidden, true);
    assert.equal(turnOn.disabled, false);
    assert.equal(turnOff.disabled, false);
});

const LIVE_SERVER = { port: "5500", hostname: "127.0.0.1" };

async function controleBanner(location, petsResponse) {
    const page = createPage(["./controle.js"], { durations: [30, 60, 120, 300, 600], location });
    page.start();
    assert.equal(page.element("ambiente-demonstracao").hidden, true, "a faixa começa oculta");
    await page.respond("/api/perfil/pet", 200, petsResponse);
    return page.element("ambiente-demonstracao");
}

test("a faixa de demonstração só aparece com a API simulada e o Live Server local", () => {
    const demo = { sucesso: true, pets: [], demonstracao: true };
    assert.equal(State.isDemoEnvironment(demo, LIVE_SERVER), true);
    assert.equal(State.isDemoEnvironment(demo, { port: "5500", hostname: "localhost" }), true);
    assert.equal(State.isDemoEnvironment({ ...demo, demonstracao: undefined }, LIVE_SERVER), false, "resposta normal");
    assert.equal(State.isDemoEnvironment({ ...demo, demonstracao: "true" }, LIVE_SERVER), false, "só o booleano true vale");
    for (const location of [
        { port: "", hostname: "projeto-mabel.vercel.app" },
        { port: "", hostname: "localhost" },
        { port: "3000", hostname: "127.0.0.1" },
        { port: "5500", hostname: "192.168.0.10" }
    ]) {
        assert.equal(State.isDemoEnvironment(demo, location), false, JSON.stringify(location));
    }
});

test("o Controle mostra a faixa de demonstração somente quando identifica a API simulada", async () => {
    const demoPets = { ...PETS, demonstracao: true };
    assert.equal((await controleBanner(LIVE_SERVER, demoPets)).hidden, false);
    assert.equal((await controleBanner(LIVE_SERVER, PETS)).hidden, true, "API real no Live Server: sem faixa");
    assert.equal((await controleBanner(undefined, demoPets)).hidden, true, "site publicado: sem faixa mesmo com a marca");

    const failing = createPage(["./controle.js"], { durations: [60], location: LIVE_SERVER });
    failing.start();
    await failing.respond("/api/perfil/pet", 503, { sucesso: false, mensagem: "falha", demonstracao: true });
    assert.equal(failing.element("ambiente-demonstracao").hidden, true, "uma resposta de erro não revela a faixa");
});

test("a faixa do Controle tem o texto exato, começa oculta e fica fora do histórico real", () => {
    const banner = html.match(/<p class="demo-environment-banner" id="ambiente-demonstracao"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(banner, "a faixa existe no HTML");
    assert.match(banner[0], /\shidden>/);
    assert.match(banner[0], /role="status"/);
    assert.equal(
        banner[1].replace(/<[^>]+>/g, ""),
        "AMBIENTE DE DEMONSTRAÇÃO — Os dados apresentados são fictícios. Nenhum comando é enviado à ESP32."
    );
    assert.ok(html.indexOf('id="ambiente-demonstracao"') < html.indexOf('id="controle-historico-lista"'));
    assert.doesNotMatch(script, /innerHTML/);
});

test("sessão expirada no histórico redireciona para o login", async () => {
    const page = await startControle();
    await page.respond("/api/mabel/sessoes?pet_id=22", 401, { sucesso: false, mensagem: "Autenticação necessária." });
    assert.deepEqual(page.redirects, ["/pages/login/login.html"]);
});

test("a página de controle separa o histórico real das sessões demonstrativas", () => {
    assert.match(html, /id="controle-historico-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="controle-historico-lista"[^>]*hidden/);
    assert.match(html, /não a duração realizada/);
    const realIndex = html.indexOf('id="controle-historico-lista"');
    const demoIndex = html.indexOf('id="controle-demo"');
    assert.ok(realIndex > 0 && demoIndex > realIndex, "a seção demonstrativa fica separada, depois do histórico real");
    assert.match(script, /\/api\/mabel\/sessoes\?pet_id=/);
    assert.doesNotMatch(script, /MabelDemo/, "dados demonstrativos não substituem os reais");
});
