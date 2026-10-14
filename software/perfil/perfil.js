document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('profile-status');
    const emptyState = document.getElementById('empty-state');
    const selector = document.getElementById('pet-selector');
    const addButton = document.getElementById('add-pet-btn');
    const deleteButton = document.getElementById('delete-pet-btn');
    const deleteDialog = document.getElementById('delete-confirmation');
    const deleteConfirmationMessage = document.getElementById('delete-confirmation-message');
    const summary = document.getElementById('pet-summary');
    const health = document.getElementById('pet-health');
    const form = document.getElementById('pet-edit-form');
    const formTitle = document.getElementById('pet-form-title');
    const formError = document.getElementById('form-error');
    const saveButton = document.getElementById('save-pet-btn');
    const cancelButton = document.getElementById('cancel-edit-btn');
    const fields = form.elements;

    let pets = [];
    let selectedPetId = null;
    let editingPetId = null;

    const apiUrl = (path) => window.location.port === '5500'
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    function setStatus(message, isError = false) {
        status.textContent = message;
        status.hidden = !message;
        status.setAttribute('role', isError ? 'alert' : 'status');
    }

    function showFormError(message) {
        formError.textContent = message;
        formError.hidden = !message;
    }

    function selectedPet() {
        return pets.find((pet) => pet.id === selectedPetId) || null;
    }

    function rememberSelectedPet(id) {
        try {
            if (id) sessionStorage.setItem('mabel.selectedPetId', id);
            else sessionStorage.removeItem('mabel.selectedPetId');
        } catch {
            // Pet selection persistence is optional; the profile remains usable without storage.
        }
    }

    function setFieldValues(pet = {}) {
        fields.namedItem('nome').value = pet.nome || '';
        fields.namedItem('identificacao').value = pet.identificacao || '';
        fields.namedItem('idade_meses').value = pet.idade_meses ?? '';
        fields.namedItem('peso_kg').value = pet.peso_kg ?? '';
        fields.namedItem('condicao_saude').value = pet.condicao_saude || '';
    }

    function renderSelectedPet() {
        const pet = selectedPet();
        const hasPet = Boolean(pet);

        emptyState.hidden = hasPet;
        summary.hidden = !hasPet;
        health.hidden = !hasPet;
        if (!hasPet) return;

        document.getElementById('pet-name').textContent = pet.nome;
        document.getElementById('pet-identification').textContent =
            pet.identificacao || 'Identificação não informada';
        document.getElementById('pet-age').textContent =
            pet.idade_meses === null ? 'Idade não informada' : `${pet.idade_meses} meses`;
        document.getElementById('pet-weight').textContent =
            pet.peso_kg === null ? 'Peso não informado' : `${pet.peso_kg} kg`;
        document.getElementById('pet-condition').textContent =
            pet.condicao_saude || 'Nenhuma condição de saúde informada.';
    }

    function renderPets(preferredId = selectedPetId) {
        const options = pets.map((pet, index) => {
            const option = document.createElement('option');
            option.value = pet.id;
            option.textContent = pets.filter((item) => item.nome === pet.nome).length > 1
                ? `${pet.nome} (${index + 1})`
                : pet.nome;
            return option;
        });

        selector.replaceChildren(...options);
        selector.disabled = pets.length === 0;
        addButton.disabled = false;

        if (pets.length === 0) {
            selectedPetId = null;
            emptyState.hidden = false;
            summary.hidden = true;
            health.hidden = true;
            setPetActionsDisabled(true);
            return;
        }

        const selected = pets.some((pet) => pet.id === preferredId)
            ? preferredId
            : pets[0].id;
        selectedPetId = selected;
        selector.value = selected;
        rememberSelectedPet(selected);
        setPetActionsDisabled(false);
        renderSelectedPet();
    }

    function setPetActionsDisabled(disabled) {
        document.querySelectorAll('[data-edit-pet]').forEach((button) => {
            button.disabled = disabled;
        });
    }

    function parseResponse(response, result) {
        if (response.status === 401) {
            window.location.assign('/pages/login/login.html');
            throw new Error('Sua sessão expirou. Redirecionando para o login.');
        }

        if (!response.ok || result?.sucesso !== true) {
            const details = Array.isArray(result?.erros) ? ` ${result.erros.join(' ')}` : '';
            throw new Error(`${MabelApiResponse.errorMessage(
                response,
                result,
                'Não foi possível concluir a solicitação.'
            )}${details}`);
        }

        return result;
    }

    async function loadPets(preferredId = selectedPetId) {
        setStatus('Carregando os pets...');
        selector.disabled = true;
        addButton.disabled = true;
        setPetActionsDisabled(true);

        try {
            const { response, result } = await MabelApiResponse.fetchJson(fetch, apiUrl('/api/perfil/pet'), {
                credentials: window.location.port === '5500' ? 'include' : 'same-origin',
                cache: 'no-store'
            });
            parseResponse(response, result);
            if (!Array.isArray(result.pets)) {
                throw new Error('A lista de pets retornada pelo servidor é inválida.');
            }

            pets = result.pets.map((pet) => ({
                ...pet,
                id: String(pet.id),
                idade_meses: pet.idade_meses === null ? null : Number(pet.idade_meses),
                peso_kg: pet.peso_kg === null ? null : String(pet.peso_kg)
            }));
            renderPets(preferredId);
            setStatus('');
            return true;
        } catch (error) {
            if (!window.location.pathname.endsWith('/login.html')) {
                setStatus(error.message || 'Não foi possível carregar os pets.', true);
            }
            selector.disabled = true;
            addButton.disabled = true;
            setPetActionsDisabled(true);
            return false;
        }
    }

    function beginEditing(pet) {
        editingPetId = pet ? pet.id : null;
        formTitle.textContent = pet ? 'Editar perfil do pet' : 'Adicionar pet';
        deleteButton.hidden = !pet;
        deleteButton.disabled = !pet;
        setFieldValues(pet || {});
        showFormError('');
        summary.hidden = true;
        health.hidden = true;
        emptyState.hidden = true;
        selector.disabled = true;
        addButton.disabled = true;
        setPetActionsDisabled(true);
        form.hidden = false;
        fields.namedItem('nome').focus();
    }

    function cancelEditing() {
        form.hidden = true;
        editingPetId = null;
        deleteButton.hidden = true;
        deleteButton.disabled = true;
        showFormError('');
        renderPets(selectedPetId);
    }

    function confirmPetDeletion(pet) {
        deleteConfirmationMessage.textContent =
            `Tem certeza de que deseja excluir "${pet.nome}"? Esta ação não pode ser desfeita.`;
        deleteDialog.showModal();
        return new Promise((resolve) => {
            deleteDialog.addEventListener('close', () => {
                resolve(deleteDialog.returnValue === 'delete');
            }, { once: true });
        });
    }

    selector.addEventListener('change', () => {
        selectedPetId = selector.value;
        rememberSelectedPet(selectedPetId);
        renderSelectedPet();
    });

    addButton.addEventListener('click', () => beginEditing(null));

    document.querySelectorAll('[data-edit-pet]').forEach((button) => {
        button.addEventListener('click', () => {
            const pet = selectedPet();
            if (pet) beginEditing(pet);
        });
    });

    cancelButton.addEventListener('click', cancelEditing);

    deleteButton.addEventListener('click', async () => {
        if (deleteButton.disabled || editingPetId === null) return;
        const pet = pets.find((item) => item.id === editingPetId);
        if (!pet) return;

        const confirmed = await confirmPetDeletion(pet);
        if (!confirmed) return;

        selector.disabled = true;
        addButton.disabled = true;
        saveButton.disabled = true;
        cancelButton.disabled = true;
        deleteButton.disabled = true;
        showFormError('');

        try {
            const { response, result } = await MabelApiResponse.fetchJson(
                fetch,
                apiUrl(`/api/perfil/pet/${encodeURIComponent(pet.id)}`),
                {
                method: 'DELETE',
                credentials: window.location.port === '5500' ? 'include' : 'same-origin',
                cache: 'no-store'
            });
            parseResponse(response, result);

            pets = pets.filter((item) => item.id !== pet.id);
            selectedPetId = pets[0]?.id || null;
            form.hidden = true;
            editingPetId = null;
            deleteButton.hidden = true;
            renderPets(selectedPetId);
            const refreshed = await loadPets(selectedPetId);
            if (refreshed) setStatus(`"${pet.nome}" foi excluído com sucesso.`);
        } catch (error) {
            if (error.message !== 'Sua sessão expirou. Redirecionando para o login.') {
                showFormError(error.message || 'Não foi possível excluir o pet.');
            }
        } finally {
            saveButton.disabled = false;
            cancelButton.disabled = false;
            deleteButton.disabled = editingPetId === null;
            selector.disabled = pets.length === 0;
            addButton.disabled = false;
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        showFormError('');
        if (!form.reportValidity()) return;

        const payload = {
            nome: fields.namedItem('nome').value.trim(),
            identificacao: fields.namedItem('identificacao').value.trim() || null,
            idade_meses: fields.namedItem('idade_meses').value === ''
                ? null
                : Number(fields.namedItem('idade_meses').value),
            peso_kg: fields.namedItem('peso_kg').value === ''
                ? null
                : fields.namedItem('peso_kg').value,
            condicao_saude: fields.namedItem('condicao_saude').value.trim() || null
        };

        saveButton.disabled = true;
        cancelButton.disabled = true;

        try {
            const isEditing = editingPetId !== null;
            const endpoint = isEditing
                ? `/api/perfil/pet/${encodeURIComponent(editingPetId)}`
                : '/api/perfil/pet';
            const { response, result } = await MabelApiResponse.fetchJson(fetch, apiUrl(endpoint), {
                method: isEditing ? 'PUT' : 'POST',
                credentials: window.location.port === '5500' ? 'include' : 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store'
            });
            parseResponse(response, result);

            selectedPetId = result.pet?.id ? String(result.pet.id) : selectedPetId;
            form.hidden = true;
            editingPetId = null;
            await loadPets(selectedPetId);
        } catch (error) {
            showFormError(error.message || 'Não foi possível salvar o perfil.');
        } finally {
            saveButton.disabled = false;
            cancelButton.disabled = false;
        }
    });

    loadPets();
});
