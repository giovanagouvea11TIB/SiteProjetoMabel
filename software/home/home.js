document.addEventListener("DOMContentLoaded", () => {
    const petName = document.getElementById("home-pet-name");
    const petSelectorLabel = document.querySelector(".pet-selector-label");
    const petSelector = document.getElementById("home-pet-selector");
    const petMessage = document.getElementById("home-pet-message");
    const petDetails = document.getElementById("home-pet-details");
    const vaccineSummary = document.getElementById("home-vaccine-summary");
    const vaccineDate = document.getElementById("home-vaccine-date");
    const vaccineNote = document.getElementById("home-vaccine-note");
    const profileLink = document.getElementById("home-profile-link");
    const petVisual = document.getElementById("home-pet-visual");
    const petIllustration = document.getElementById("home-pet-illustration");
    const iconPicker = document.getElementById("home-pet-icon-picker");

    const apiUrl = (path) => window.location.port === "5500"
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    let pets = [];
    let selectedPetId = null;
    let vaccineRequestId = 0;

    function loadStoredPetIcons() {
        try {
            return MabelHomeState.loadPetIcons(window.localStorage);
        } catch {
            return new Map();
        }
    }

    let petIcons = loadStoredPetIcons();

    function saveStoredPetIcons() {
        try {
            return MabelHomeState.savePetIcons(window.localStorage, petIcons);
        } catch {
            return false;
        }
    }

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
            // The current page remains usable when session storage is unavailable.
        }
    }

    async function request(path) {
        const { response, result } = await MabelApiResponse.fetchJson(fetch, apiUrl(path), {
            credentials: window.location.port === "5500" ? "include" : "same-origin",
            cache: "no-store"
        });

        if (response.status === 401) {
            window.location.assign("/pages/login/login.html");
            throw new Error("Sua sessão expirou. Redirecionando para o login.");
        }
        if (!response.ok || result?.sucesso !== true) {
            throw new Error(MabelApiResponse.errorMessage(
                response,
                result,
                "Não foi possível carregar os dados."
            ));
        }
        return result;
    }

    function addDetail(label, value, wide = false) {
        if (value === null || value === undefined || String(value).trim() === "") return;

        const container = document.createElement("div");
        container.className = wide ? "pet-detail pet-detail-wide" : "pet-detail";
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = value;
        container.append(term, description);
        petDetails.append(container);
    }

    function renderPetDetails(pet) {
        petDetails.replaceChildren();
        addDetail("Identificação", pet.identificacao);
        addDetail("Idade", pet.idade_meses === null || pet.idade_meses === undefined
            ? null
            : `${pet.idade_meses} meses`);
        addDetail("Peso", pet.peso_kg === null || pet.peso_kg === undefined
            ? null
            : `${pet.peso_kg} kg`);
        addDetail("Condição de saúde", pet.condicao_saude, true);
        petDetails.hidden = petDetails.childElementCount === 0;
    }

    function formatDate(value) {
        const [year, month, day] = value.split("-").map(Number);
        return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
    }

    function getTodayIsoDate() {
        const now = new Date();
        return [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, "0"),
            String(now.getDate()).padStart(2, "0")
        ].join("-");
    }

    function renderVaccineSummary(summary) {
        vaccineDate.textContent = "";
        vaccineNote.textContent = "";
        vaccineNote.classList.remove("is-error");

        if (!summary.hasRecords) {
            vaccineNote.textContent = "Nenhuma vacina foi cadastrada para este animal.";
            return;
        }
        if (summary.earliestOverdue) {
            vaccineDate.textContent = `Dose pendente vencida desde ${formatDate(summary.earliestOverdue.data_prevista)}.`;
            if (summary.nextUpcoming) {
                vaccineNote.textContent = `Próxima dose futura cadastrada: ${formatDate(summary.nextUpcoming.data_prevista)}.`;
            }
            if (summary.invalidPendingCount > 0) {
                vaccineNote.textContent += " Há também doses pendentes sem data válida.";
            }
            return;
        }
        if (summary.nextUpcoming) {
            vaccineDate.textContent = `Próxima dose: ${formatDate(summary.nextUpcoming.data_prevista)}.`;
            vaccineNote.textContent = summary.invalidPendingCount > 0
                ? "Há também doses pendentes sem data válida."
                : "";
            return;
        }
        if (summary.pendingCount === 0) {
            vaccineNote.textContent = "Não há doses pendentes cadastradas.";
            return;
        }
        vaccineNote.textContent = "Há doses pendentes, mas nenhuma tem uma data prevista válida.";
    }

    function renderPetIcon(petId) {
        const icon = petIcons.get(petId) || null;
        petIllustration.textContent = icon
            ? icon.startsWith("dog-") ? "🐶" : "🐱"
            : "🐾";
        petIllustration.dataset.icon = icon || "";
        petIllustration.setAttribute(
            "aria-label",
            icon ? "Ícone ilustrativo escolhido para este animal" : "Ícone genérico de animal"
        );
        iconPicker.querySelectorAll(".pet-icon-option").forEach((button) => {
            const selected = button.dataset.icon === icon;
            button.classList.toggle("is-selected", selected);
            button.setAttribute("aria-pressed", String(selected));
        });
    }

    async function loadVaccines(petId) {
        const requestId = ++vaccineRequestId;
        vaccineSummary.hidden = false;
        vaccineDate.textContent = "";
        vaccineNote.textContent = "Carregando as doses cadastradas...";

        try {
            const result = await request(
                `/api/vacinas/pets/${encodeURIComponent(petId)}/registros`
            );
            if (!Array.isArray(result.registros)) {
                throw new Error("A lista de doses retornada pelo servidor é inválida.");
            }
            if (requestId !== vaccineRequestId || selectedPetId !== petId) return;

            renderVaccineSummary(MabelHomeState.summarizeVaccines(result.registros, getTodayIsoDate()));
        } catch (error) {
            if (requestId !== vaccineRequestId || selectedPetId !== petId) return;
            vaccineDate.textContent = "";
            vaccineNote.textContent = error.message || "Não foi possível carregar as vacinas.";
            vaccineNote.classList.add("is-error");
        }
    }

    function selectPet(petId) {
        const pet = pets.find((item) => item.id === petId);
        if (!pet) return;

        selectedPetId = pet.id;
        petSelector.value = pet.id;
        rememberSelectedPet(pet.id);
        petName.textContent = pet.nome;
        petMessage.hidden = true;
        profileLink.hidden = true;
        petDetails.hidden = false;
        renderPetDetails(pet);
        petVisual.hidden = false;
        renderPetIcon(pet.id);
        loadVaccines(pet.id);
    }

    async function loadPets() {
        petName.textContent = "Perfil dos animais";
        petMessage.hidden = false;
        petMessage.classList.remove("is-error");
        petMessage.textContent = "Carregando os animais da sua conta...";
        petSelector.hidden = true;
        petSelectorLabel.hidden = true;
        petSelector.disabled = true;
        petDetails.hidden = true;
        vaccineSummary.hidden = true;
        petVisual.hidden = true;
        profileLink.hidden = true;

        try {
            const result = await request("/api/perfil/pet");
            if (!Array.isArray(result.pets)) {
                throw new Error("A lista de animais retornada pelo servidor é inválida.");
            }

            pets = result.pets.map((pet) => ({
                ...pet,
                id: String(pet.id)
            }));

            if (pets.length === 0) {
                selectedPetId = null;
                rememberSelectedPet(null);
                petName.textContent = "Nenhum animal cadastrado";
                petMessage.textContent = "Cadastre um animal para ver seus dados e as vacinas pendentes.";
                profileLink.hidden = false;
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

            const preferredId = getStoredPetId();
            const selectedId = pets.some((pet) => pet.id === preferredId)
                ? preferredId
                : pets[0].id;
            if (pets.length > 1) {
                petSelector.hidden = false;
                petSelectorLabel.hidden = false;
                petSelector.disabled = false;
            }
            selectPet(selectedId);
        } catch (error) {
            pets = [];
            selectedPetId = null;
            vaccineRequestId += 1;
            petName.textContent = "Não foi possível carregar o perfil";
            petMessage.classList.add("is-error");
            petMessage.textContent = error.message || "Não foi possível carregar os animais.";
        }
    }

    petSelector.addEventListener("change", () => selectPet(petSelector.value));
    iconPicker.addEventListener("click", (event) => {
        const button = event.target.closest(".pet-icon-option");
        if (!button || !selectedPetId) return;

        petIcons.set(selectedPetId, button.dataset.icon);
        renderPetIcon(selectedPetId);
        if (!saveStoredPetIcons()) {
            petMessage.hidden = false;
            petMessage.classList.add("is-error");
            petMessage.textContent = "O ícone foi alterado nesta página, mas não pôde ser salvo neste navegador.";
        }
    });

    loadPets();
});
