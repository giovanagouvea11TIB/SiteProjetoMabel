document.addEventListener("DOMContentLoaded", () => {
    const State = window.MabelControleState;
    const petSelect = document.getElementById("controle-pet");
    const connection = document.getElementById("controle-conexao");
    const deviceLabel = document.getElementById("controle-dispositivo");
    const lastContact = document.getElementById("controle-ultimo-contato");
    const associateForm = document.getElementById("controle-associar");
    const deviceInput = document.getElementById("controle-device-id");
    const associateButton = document.getElementById("controle-associar-btn");
    const dissociateButton = document.getElementById("controle-desassociar-btn");
    const intensity = document.getElementById("motor-intensidade");
    const intensityValue = document.getElementById("motor-intensidade-valor");
    const timer = document.getElementById("motor-tempo");
    const durationButtons = [...document.querySelectorAll("[data-duracao]")];
    const turnOnButton = document.getElementById("motor-ligar-btn");
    const turnOffButton = document.getElementById("motor-desligar-btn");
    const requested = document.getElementById("motor-solicitado");
    const confirmed = document.getElementById("motor-confirmado");
    const statusMessage = document.getElementById("motor-status");
    const errorMessage = document.getElementById("motor-erro");
    const historyStatus = document.getElementById("controle-historico-status");
    const historyList = document.getElementById("controle-historico-lista");
    const demoBanner = document.getElementById("ambiente-demonstracao");

    const POLL_INTERVAL_MS = 3000;
    let pets = [];
    let selectedPetId = null;
    let motorStatus = null;
    let selectedDurationS = 60;
    let busy = false;
    let actionError = null;
    let awaitingCommandId = null;
    let refreshId = 0;
    let pollTimer = null;
    let countdownEndsAt = null;
    let historyRequestId = 0;
    let historyPetId = null;
    let historySignature = null;
    let statusUnavailable = false;

    const apiUrl = (path) => window.location.port === "5500"
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    async function request(path, options = {}) {
        const { response, result } = await MabelApiResponse.fetchJson(fetch, apiUrl(path), {
            credentials: window.location.port === "5500" ? "include" : "same-origin",
            cache: "no-store",
            ...options
        });
        if (response.status === 401) {
            window.location.assign("/pages/login/login.html");
            throw new Error("Sua sessão expirou. Redirecionando para o login.");
        }
        if (!response.ok || result?.sucesso !== true) {
            throw new Error(MabelApiResponse.errorMessage(
                response,
                result,
                "Não foi possível concluir a solicitação."
            ));
        }
        return result;
    }

    function jsonRequest(path, method, body) {
        return request(path, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    }

    function rememberSelectedPet(id) {
        try {
            if (id) sessionStorage.setItem("mabel.selectedPetId", id);
            else sessionStorage.removeItem("mabel.selectedPetId");
        } catch {
            // A seleção do pet é apenas uma conveniência; a página funciona sem armazenamento.
        }
    }

    function storedPetId() {
        try {
            return sessionStorage.getItem("mabel.selectedPetId");
        } catch {
            return null;
        }
    }

    function setError(message) {
        errorMessage.textContent = message || "";
        errorMessage.hidden = !message;
    }

    function setStatus(message) {
        statusMessage.textContent = message || "";
    }

    function renderIntensity() {
        const value = Number(intensity.value);
        intensityValue.textContent = `${value}%`;
        intensity.style.setProperty("--fill", `${value}%`);
    }

    function renderDurations() {
        for (const button of durationButtons) {
            const active = Number(button.dataset.duracao) === selectedDurationS;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
        }
    }

    // countdownEndsAt só é definido ou apagado por renderStatus, a partir do servidor. Ao chegar a zero,
    // a contagem fica em 00:00 até o servidor informar o encerramento; ela nunca reinicia sozinha.
    function renderTimer() {
        if (countdownEndsAt !== null) {
            timer.textContent = State.formatCountdown(Math.max(0, countdownEndsAt - Date.now()));
            return;
        }
        timer.textContent = State.formatCountdown(selectedDurationS * 1000);
    }

    function renderControls() {
        const associated = Boolean(motorStatus?.tem_associacao);
        const canOperate = Boolean(selectedPetId) && associated && !busy;

        petSelect.disabled = busy || pets.length === 0;
        associateForm.hidden = !selectedPetId || !motorStatus || associated;
        deviceInput.disabled = busy;
        associateButton.disabled = busy;
        dissociateButton.hidden = !associated;
        dissociateButton.disabled = busy;
        intensity.disabled = !associated || busy;
        for (const button of durationButtons) button.disabled = !associated || busy;
        turnOffButton.disabled = !canOperate;
        turnOnButton.disabled = !canOperate || !motorStatus.online || Number(intensity.value) < 1;
    }

    // Sem estado do pet selecionado (consulta em andamento ou com falha), nada do pet anterior é exibido.
    function connectionState() {
        if (motorStatus || !selectedPetId) return State.describeConnection(motorStatus);
        return { online: false, label: statusUnavailable ? "Estado indisponível" : "Verificando..." };
    }

    function renderStatus() {
        const state = connectionState();
        connection.textContent = state.label;
        connection.classList.toggle("badge-connected", state.online);
        connection.classList.toggle("badge-offline", !state.online);
        deviceLabel.textContent = motorStatus?.device_id ? `ESP32 · ${motorStatus.device_id}` : "ESP32";
        lastContact.textContent = motorStatus?.ultimo_contato
            ? `Último contato: ${new Date(motorStatus.ultimo_contato).toLocaleString("pt-BR")}`
            : "";

        const solicitado = motorStatus?.solicitado || null;
        // A mensagem "aguardando a confirmação" só vale enquanto o comando enviado estiver pendente.
        if (awaitingCommandId && (solicitado?.command_id !== awaitingCommandId || solicitado.estado !== "pendente")) {
            awaitingCommandId = null;
            setStatus("");
        }
        requested.textContent = motorStatus?.tem_associacao ? State.describeRequested(solicitado) : "—";
        confirmed.textContent = motorStatus?.tem_associacao ? State.describeConfirmed(motorStatus.confirmado) : "—";
        // O cronômetro só corre depois que a ESP32 confirma ter ligado os motores com este mesmo comando;
        // um comando apenas pendente não é apresentado como acionamento em andamento.
        const confirmado = motorStatus?.confirmado || null;
        const confirmedRunning = Boolean(
            solicitado?.ativo
            && solicitado.estado === "aplicado"
            && confirmado?.ligado
            && confirmado.command_id === solicitado.command_id
        );
        countdownEndsAt = confirmedRunning ? Date.now() + solicitado.duracao_restante_ms : null;
        setError(actionError || State.commandProblem(solicitado));
        renderTimer();
        renderControls();
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function setHistoryStatus(message, isError = false) {
        historyStatus.textContent = message;
        historyStatus.classList.toggle("is-error", isError);
    }

    function clearHistory(message) {
        historyPetId = null;
        historyList.replaceChildren();
        historyList.hidden = true;
        setHistoryStatus(message);
    }

    function historyField(label, value, tone) {
        const item = element("div", tone ? `session-history-field session-history-field--${tone}` : "session-history-field");
        item.append(element("dt", "", label), element("dd", "", value));
        return item;
    }

    function historyItem(session) {
        const view = State.describeSession(session);
        const titleId = `controle-sessao-${historyList.childElementCount}`;
        const header = element("header", "session-history-header");
        const heading = element("div");
        const title = element("h3", "", view.quando);
        title.id = titleId;
        heading.append(title, element("span", "session-history-device", view.dispositivo));
        header.append(heading, element("span", `session-badge session-badge--${view.estado.tone}`, view.estado.label));

        const fields = element("dl", "session-history-fields");
        fields.append(
            historyField("Intensidade geral", view.intensidade),
            historyField("Duração solicitada", view.duracao),
            historyField("Modo", view.modo.label, view.modo.tone),
            historyField("Encerramento", view.encerramento),
            historyField("Término registrado", view.termino)
        );

        const article = element("article");
        article.setAttribute("aria-labelledby", titleId);
        article.append(header, fields);
        const item = element("li", "session-history-item");
        item.append(article);
        return item;
    }

    function renderHistory(petId, history) {
        historyPetId = petId;
        historyList.replaceChildren();
        for (const session of history.sessoes) historyList.append(historyItem(session));
        historyList.hidden = history.sessoes.length === 0;
        setHistoryStatus(State.describeSessionCount(history.sessoes.length, history.maisRegistros));
    }

    async function loadHistory() {
        const currentRequest = ++historyRequestId;
        const petId = selectedPetId;
        if (!petId) {
            clearHistory(pets.length ? "Selecione um pet para ver as sessões reais." : "Nenhum pet cadastrado.");
            return;
        }
        // Os registros de outro pet nunca ficam visíveis enquanto a nova consulta carrega.
        if (historyPetId !== petId) clearHistory("Carregando o histórico de sessões reais...");
        try {
            const result = await request(`/api/mabel/sessoes?pet_id=${encodeURIComponent(petId)}`);
            if (currentRequest !== historyRequestId || petId !== selectedPetId) return;
            const history = State.parseSessionHistory(result, petId);
            if (!history) throw new Error("A resposta do histórico de sessões é inválida.");
            renderHistory(petId, history);
        } catch (error) {
            if (currentRequest !== historyRequestId || petId !== selectedPetId) return;
            const message = error.message || "Não foi possível carregar o histórico de sessões.";
            if (historyPetId === petId) {
                setHistoryStatus(`${message} Exibindo os últimos registros carregados.`, true);
            } else {
                clearHistory("");
                setHistoryStatus(message, true);
            }
        }
    }

    // O histórico só é consultado de novo quando o comando, a confirmação ou a conexão mudam.
    function statusSignature(status) {
        return JSON.stringify([
            status?.tem_associacao,
            status?.device_id,
            status?.online,
            status?.solicitado?.command_id,
            status?.solicitado?.estado,
            status?.confirmado?.command_id,
            status?.confirmado?.confirmado_em
        ]);
    }

    async function refresh() {
        const currentRefresh = ++refreshId;
        if (!selectedPetId) {
            motorStatus = null;
            renderStatus();
            return;
        }
        try {
            const result = await request(`/api/mabel/motores?pet_id=${encodeURIComponent(selectedPetId)}`);
            if (currentRefresh !== refreshId) return;
            motorStatus = result;
            statusUnavailable = false;
            renderStatus();
            const signature = statusSignature(result);
            if (historySignature !== null && signature !== historySignature) loadHistory();
            historySignature = signature;
        } catch (error) {
            if (currentRefresh !== refreshId) return;
            statusUnavailable = true;
            if (!motorStatus) renderStatus();
            setError(error.message || "Não foi possível consultar o estado dos motores.");
        }
    }

    function schedulePolling() {
        clearInterval(pollTimer);
        pollTimer = null;
        if (document.visibilityState === "visible" && selectedPetId) {
            pollTimer = setInterval(() => {
                if (!busy) refresh();
            }, POLL_INTERVAL_MS);
        }
    }

    async function runAction(message, action) {
        if (busy) return;
        busy = true;
        actionError = null;
        setError("");
        setStatus(message);
        renderControls();
        try {
            await action();
        } catch (error) {
            actionError = error.message || "Não foi possível concluir a solicitação.";
            setError(actionError);
            setStatus("");
        } finally {
            busy = false;
            await refresh();
            renderControls();
        }
    }

    async function loadPets() {
        setStatus("Carregando os pets...");
        demoBanner.hidden = true;
        try {
            const result = await request("/api/perfil/pet");
            if (!Array.isArray(result.pets)) throw new Error("A lista de pets retornada pelo servidor é inválida.");
            pets = result.pets.map((pet) => ({ id: String(pet.id), nome: pet.nome }));
            demoBanner.hidden = !State.isDemoEnvironment(result, window.location);
        } catch (error) {
            setError(error.message || "Não foi possível carregar os pets.");
            setStatus("");
            clearHistory("");
            setHistoryStatus("O histórico de sessões depende da lista de pets, que não pôde ser carregada.", true);
            renderControls();
            return;
        }

        petSelect.replaceChildren(...pets.map((pet) => new Option(pet.nome, pet.id)));
        const preferred = storedPetId();
        selectedPetId = pets.some((pet) => pet.id === preferred) ? preferred : pets[0]?.id || null;
        if (selectedPetId) petSelect.value = selectedPetId;
        setStatus(pets.length ? "" : "Cadastre um pet no Perfil Pet para controlar a órtese.");
        historySignature = null;
        loadHistory();
        await refresh();
        schedulePolling();
    }

    petSelect.addEventListener("change", () => {
        selectedPetId = petSelect.value || null;
        rememberSelectedPet(selectedPetId);
        motorStatus = null;
        statusUnavailable = false;
        actionError = null;
        historySignature = null;
        setStatus("");
        // Limpa conexão, comandos, cronômetro e botões do pet anterior antes da nova consulta.
        renderStatus();
        loadHistory();
        refresh();
        schedulePolling();
    });

    intensity.addEventListener("input", () => {
        renderIntensity();
        renderControls();
    });

    for (const button of durationButtons) {
        button.addEventListener("click", () => {
            selectedDurationS = Number(button.dataset.duracao);
            renderDurations();
            renderTimer();
        });
    }

    turnOnButton.addEventListener("click", () => {
        const intensidade = Number(intensity.value);
        const validationError = State.validateTurnOn(intensidade, selectedDurationS);
        if (validationError) {
            actionError = validationError;
            setError(validationError);
            return;
        }
        runAction("Enviando o comando de ligar...", async () => {
            const result = await jsonRequest(
                "/api/mabel/motores",
                "POST",
                State.buildTurnOnPayload(selectedPetId, intensidade, selectedDurationS)
            );
            awaitingCommandId = result.comando.command_id;
            setStatus(`Comando ${result.comando.command_id} registrado. Aguardando a confirmação da ESP32.`);
        });
    });

    turnOffButton.addEventListener("click", () => {
        runAction("Enviando o comando de desligar...", async () => {
            const result = await jsonRequest("/api/mabel/motores", "POST", State.buildTurnOffPayload(selectedPetId));
            awaitingCommandId = result.comando.command_id;
            setStatus(`Comando ${result.comando.command_id} de desligar registrado. Aguardando a confirmação da ESP32.`);
        });
    });

    associateButton.addEventListener("click", () => {
        const deviceId = deviceInput.value.trim();
        const validationError = State.validateDeviceId(deviceId);
        if (validationError) {
            actionError = validationError;
            setError(validationError);
            return;
        }
        runAction("Associando o dispositivo...", async () => {
            await jsonRequest("/api/mabel/associacoes", "POST", { pet_id: selectedPetId, device_id: deviceId });
            deviceInput.value = "";
            setStatus("Dispositivo associado. Aguardando o primeiro contato da ESP32.");
        });
    });

    dissociateButton.addEventListener("click", () => {
        const confirmedByUser = window.confirm(
            `Desassociar ${motorStatus?.device_id || "o dispositivo"} deste pet? A ESP32 desliga os motores ao perder a associação.`
        );
        if (!confirmedByUser) return;
        runAction("Desassociando o dispositivo...", async () => {
            await request(`/api/mabel/associacoes?pet_id=${encodeURIComponent(selectedPetId)}`, { method: "DELETE" });
            setStatus("Dispositivo desassociado.");
        });
    });

    document.addEventListener("visibilitychange", () => {
        schedulePolling();
        if (document.visibilityState === "visible") refresh();
    });

    setInterval(() => {
        if (countdownEndsAt !== null) renderTimer();
    }, 1000);

    renderIntensity();
    renderDurations();
    renderTimer();
    renderControls();
    loadPets();
});
