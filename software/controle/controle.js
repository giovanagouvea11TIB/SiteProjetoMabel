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

    function renderTimer() {
        if (countdownEndsAt !== null) {
            const remaining = countdownEndsAt - Date.now();
            if (remaining > 0) {
                timer.textContent = State.formatCountdown(remaining);
                return;
            }
            countdownEndsAt = null;
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

    function renderStatus() {
        const state = State.describeConnection(motorStatus);
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
        countdownEndsAt = solicitado?.ativo ? Date.now() + solicitado.duracao_restante_ms : null;
        setError(actionError || State.commandProblem(solicitado));
        renderTimer();
        renderControls();
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
            renderStatus();
        } catch (error) {
            if (currentRefresh !== refreshId) return;
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
        try {
            const result = await request("/api/perfil/pet");
            if (!Array.isArray(result.pets)) throw new Error("A lista de pets retornada pelo servidor é inválida.");
            pets = result.pets.map((pet) => ({ id: String(pet.id), nome: pet.nome }));
        } catch (error) {
            setError(error.message || "Não foi possível carregar os pets.");
            setStatus("");
            renderControls();
            return;
        }

        petSelect.replaceChildren(...pets.map((pet) => new Option(pet.nome, pet.id)));
        const preferred = storedPetId();
        selectedPetId = pets.some((pet) => pet.id === preferred) ? preferred : pets[0]?.id || null;
        if (selectedPetId) petSelect.value = selectedPetId;
        setStatus(pets.length ? "" : "Cadastre um pet no Perfil Pet para controlar a órtese.");
        await refresh();
        schedulePolling();
    }

    petSelect.addEventListener("change", () => {
        selectedPetId = petSelect.value || null;
        rememberSelectedPet(selectedPetId);
        motorStatus = null;
        actionError = null;
        setStatus("");
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
