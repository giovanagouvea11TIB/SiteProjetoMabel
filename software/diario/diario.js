document.addEventListener("DOMContentLoaded", () => {
    const State = window.MabelControleState;
    const petSelector = document.getElementById("diary-pet-selector");
    const petStatus = document.getElementById("diary-pet-status");
    const profileLink = document.getElementById("diary-profile-link");
    const chartEmpty = document.getElementById("diary-chart-empty");
    const summaryEmpty = document.getElementById("diary-summary-empty");
    const summary = document.getElementById("diary-summary");
    const summaryCount = document.getElementById("diary-summary-count");
    const statTotal = document.getElementById("diary-stat-total");
    const statSimulacao = document.getElementById("diary-stat-simulacao");
    const statFisico = document.getElementById("diary-stat-fisico");
    const statInferidas = document.getElementById("diary-stat-inferidas");
    const sessionsEmptyState = document.getElementById("diary-sessions-empty-state");
    const sessionsEmpty = document.getElementById("diary-sessions-empty");
    const sessionsError = document.getElementById("diary-sessions-error");
    const sessionsList = document.getElementById("diary-sessions-list");
    const demoBanner = document.getElementById("ambiente-demonstracao");

    const apiUrl = (path) => window.location.port === "5500"
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    let pets = [];
    let selectedPetId = null;
    let historyRequestId = 0;

    function getStoredPetId() {
        try {
            return sessionStorage.getItem("mabel.selectedPetId");
        } catch {
            return null;
        }
    }

    function rememberSelectedPet(id) {
        try {
            if (id) sessionStorage.setItem("mabel.selectedPetId", id);
            else sessionStorage.removeItem("mabel.selectedPetId");
        } catch {
            // The diary remains usable when session storage is unavailable.
        }
    }

    async function requestJson(path, fallbackMessage) {
        const { response, result } = await MabelApiResponse.fetchJson(
            fetch,
            apiUrl(path),
            {
                credentials: window.location.port === "5500" ? "include" : "same-origin",
                cache: "no-store"
            }
        );

        if (response.status === 401) {
            window.location.assign("/pages/login/login.html");
            throw new Error("Sua sessão expirou. Redirecionando para o login.");
        }
        if (!response.ok || result?.sucesso !== true) {
            throw new Error(MabelApiResponse.errorMessage(response, result, fallbackMessage));
        }
        return result;
    }

    async function requestPets() {
        const result = await requestJson("/api/perfil/pet", "Não foi possível carregar os animais da conta.");
        if (!Array.isArray(result.pets)) {
            throw new Error("A lista de animais retornada pelo servidor é inválida.");
        }
        return {
            pets: result.pets.map((pet) => ({ ...pet, id: String(pet.id) })),
            demonstracao: State.isDemoEnvironment(result, window.location)
        };
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function setSessionsError(message) {
        sessionsError.textContent = message || "";
        sessionsError.hidden = !message;
    }

    // Mostra apenas mensagens: nenhum registro de outro animal permanece visível.
    function showHistoryMessage(sessionsMessage, summaryMessage) {
        sessionsList.replaceChildren();
        sessionsList.hidden = true;
        summary.hidden = true;
        sessionsEmptyState.hidden = false;
        summaryEmpty.hidden = false;
        sessionsEmpty.textContent = sessionsMessage;
        chartEmpty.textContent = summaryMessage;
    }

    function recordField(label, value, tone) {
        const item = element("div", tone ? `diary-record-field diary-record-field--${tone}` : "diary-record-field");
        item.append(element("dt", "", label), element("dd", "", value));
        return item;
    }

    function sessionRecord(session, index) {
        const view = State.describeSession(session);
        const titleId = `diary-sessao-${index}`;
        const header = element("header", "diary-record-header");
        const heading = element("div");
        const title = element("h3", "", view.quando);
        title.id = titleId;
        heading.append(title, element("span", "diary-record-device", view.dispositivo));
        header.append(heading, element("span", `diary-badge diary-badge--${view.estado.tone}`, view.estado.label));

        const fields = element("dl", "diary-record-fields");
        fields.append(
            recordField("Intensidade", view.intensidade),
            recordField("Duração solicitada", view.duracao),
            recordField("Modo", view.modo.label, view.modo.tone),
            recordField("Encerramento", view.encerramento),
            recordField("Término registrado", view.termino)
        );

        const article = element("article");
        article.setAttribute("aria-labelledby", titleId);
        article.append(header, fields);
        const item = element("li", "diary-record");
        item.append(article);
        return item;
    }

    function renderHistory(pet, history) {
        const { sessoes, maisRegistros } = history;
        const counts = State.summarizeSessions(sessoes);
        const countText = State.describeSessionCount(sessoes.length, maisRegistros);

        if (sessoes.length === 0) {
            showHistoryMessage(
                `Nenhuma sessão real foi registrada para ${pet.nome}.`,
                `Ainda não há sessões reais de ${pet.nome} para resumir.`
            );
            return;
        }

        statTotal.textContent = maisRegistros ? `${counts.total}+` : String(counts.total);
        statSimulacao.textContent = String(counts.simulacao);
        statFisico.textContent = String(counts.fisico);
        statInferidas.textContent = String(counts.inferidas);
        summaryCount.textContent = maisRegistros
            ? `${countText} Os totais abaixo consideram apenas os registros carregados.`
            : countText;
        summaryEmpty.hidden = true;
        summary.hidden = false;

        sessionsList.replaceChildren(...sessoes.map(sessionRecord));
        sessionsEmptyState.hidden = true;
        sessionsList.hidden = false;
    }

    async function loadHistory(pet) {
        const currentRequest = ++historyRequestId;
        setSessionsError("");
        showHistoryMessage(
            `Carregando as sessões reais de ${pet.nome}...`,
            `Carregando o resumo das sessões reais de ${pet.nome}...`
        );

        try {
            const result = await requestJson(
                `/api/mabel/sessoes?pet_id=${encodeURIComponent(pet.id)}`,
                "Não foi possível carregar as sessões reais."
            );
            if (currentRequest !== historyRequestId || pet.id !== selectedPetId) return;
            const history = State.parseSessionHistory(result, pet.id);
            if (!history) throw new Error("A resposta do histórico de sessões é inválida.");
            renderHistory(pet, history);
        } catch (error) {
            if (currentRequest !== historyRequestId || pet.id !== selectedPetId) return;
            showHistoryMessage(
                `As sessões reais de ${pet.nome} não puderam ser carregadas.`,
                "O resumo não está disponível enquanto o histórico não for carregado."
            );
            setSessionsError(error.message || "Não foi possível carregar as sessões reais.");
        }
    }

    function updateSelectedPet(petId) {
        const pet = pets.find((item) => item.id === petId);
        if (!pet) return;

        selectedPetId = pet.id;
        petSelector.value = pet.id;
        rememberSelectedPet(pet.id);
        petStatus.textContent = `Animal selecionado: ${pet.nome}.`;
        loadHistory(pet);
    }

    async function loadPets() {
        petStatus.textContent = "Carregando os animais da sua conta...";
        petStatus.classList.remove("is-error");
        petSelector.hidden = true;
        petSelector.disabled = true;
        profileLink.hidden = true;
        demoBanner.hidden = true;

        try {
            const loaded = await requestPets();
            pets = loaded.pets;
            demoBanner.hidden = !loaded.demonstracao;
            if (pets.length === 0) {
                rememberSelectedPet(null);
                petStatus.textContent = "Nenhum animal cadastrado. Cadastre um animal para consultar o diário.";
                profileLink.hidden = false;
                showHistoryMessage(
                    "Nenhum animal está cadastrado nesta conta.",
                    "O histórico será exibido quando houver sessões registradas para um animal."
                );
                return;
            }

            petSelector.replaceChildren();
            for (const [index, pet] of pets.entries()) {
                const option = document.createElement("option");
                option.value = pet.id;
                option.textContent = pets.filter((item) => item.nome === pet.nome).length > 1
                    ? `${pet.nome} (${index + 1})`
                    : pet.nome;
                petSelector.append(option);
            }

            const savedPetId = getStoredPetId();
            const initialPetId = pets.some((pet) => pet.id === savedPetId)
                ? savedPetId
                : pets[0].id;
            updateSelectedPet(initialPetId);

            if (pets.length > 1) {
                petSelector.hidden = false;
                petSelector.disabled = false;
            }
        } catch (error) {
            pets = [];
            petStatus.classList.add("is-error");
            petStatus.textContent = error.message || "Não foi possível carregar os animais da conta.";
            showHistoryMessage(
                "Não foi possível determinar o animal selecionado.",
                "O histórico não pode ser associado a um animal enquanto o perfil não estiver disponível."
            );
        }
    }

    petSelector.addEventListener("change", () => updateSelectedPet(petSelector.value));
    loadPets();
});
