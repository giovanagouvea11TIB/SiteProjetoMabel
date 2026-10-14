document.addEventListener("DOMContentLoaded", () => {
    const petSelector = document.getElementById("diary-pet-selector");
    const petStatus = document.getElementById("diary-pet-status");
    const profileLink = document.getElementById("diary-profile-link");
    const chartEmpty = document.getElementById("diary-chart-empty");
    const sessionsEmpty = document.getElementById("diary-sessions-empty");

    const apiUrl = (path) => window.location.port === "5500"
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    let pets = [];

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

    async function requestPets() {
        const { response, result } = await MabelApiResponse.fetchJson(
            fetch,
            apiUrl("/api/perfil/pet"),
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
            throw new Error(MabelApiResponse.errorMessage(
                response,
                result,
                "Não foi possível carregar os animais da conta."
            ));
        }
        if (!Array.isArray(result.pets)) {
            throw new Error("A lista de animais retornada pelo servidor é inválida.");
        }
        return result.pets.map((pet) => ({ ...pet, id: String(pet.id) }));
    }

    function updateSelectedPet(petId) {
        const pet = pets.find((item) => item.id === petId);
        if (!pet) return;

        petSelector.value = pet.id;
        rememberSelectedPet(pet.id);
        petStatus.textContent = `Animal selecionado: ${pet.nome}.`;
        chartEmpty.textContent = `O histórico de sessões e leituras de ${pet.nome} ainda não está disponível.`;
        sessionsEmpty.textContent = `Ainda não há sessões persistidas para ${pet.nome}.`;
    }

    async function loadPets() {
        petStatus.textContent = "Carregando os animais da sua conta...";
        petStatus.classList.remove("is-error");
        petSelector.hidden = true;
        petSelector.disabled = true;
        profileLink.hidden = true;

        try {
            pets = await requestPets();
            if (pets.length === 0) {
                rememberSelectedPet(null);
                petStatus.textContent = "Nenhum animal cadastrado. Cadastre um animal para consultar o diário.";
                profileLink.hidden = false;
                chartEmpty.textContent = "O histórico será exibido quando houver sessões registradas para um animal.";
                sessionsEmpty.textContent = "Nenhum animal está cadastrado nesta conta.";
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
            const selectedPetId = pets.some((pet) => pet.id === savedPetId)
                ? savedPetId
                : pets[0].id;
            updateSelectedPet(selectedPetId);

            if (pets.length > 1) {
                petSelector.hidden = false;
                petSelector.disabled = false;
            }
        } catch (error) {
            pets = [];
            petStatus.classList.add("is-error");
            petStatus.textContent = error.message || "Não foi possível carregar os animais da conta.";
            chartEmpty.textContent = "O histórico não pode ser associado a um animal enquanto o perfil não estiver disponível.";
            sessionsEmpty.textContent = "Não foi possível determinar o animal selecionado.";
        }
    }

    petSelector.addEventListener("change", () => updateSelectedPet(petSelector.value));
    loadPets();
});
