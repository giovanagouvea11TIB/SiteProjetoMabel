document.addEventListener('DOMContentLoaded', () => {
    const petSelector = document.getElementById('pet-selector');
    const statusMessage = document.getElementById('vaccine-status');
    const addButton = document.getElementById('add-vaccine-btn');
    const catalogList = document.getElementById('vaccine-catalog-list');
    const catalogStatus = document.getElementById('vaccine-catalog-status');
    const catalogEmptyState = document.getElementById('vaccine-catalog-empty-state');
    const recordList = document.getElementById('vaccine-list');
    const recordEmptyState = document.getElementById('vaccine-empty-state');
    const form = document.getElementById('vaccine-form');
    const formTitle = document.getElementById('vaccine-form-title');
    const formError = document.getElementById('vaccine-form-error');
    const saveButton = document.getElementById('save-vaccine-btn');
    const deleteButton = document.getElementById('delete-vaccine-btn');
    const cancelButton = document.getElementById('cancel-vaccine-btn');
    const catalogEditSection = document.getElementById('vaccine-catalog-edit');
    const notificationsButton = document.getElementById('notification-toggle');
    const notificationPanel = document.getElementById('vaccine-notifications');
    const notificationList = document.getElementById('notification-list');
    const notificationCount = document.getElementById('notification-count');
    const notificationClose = document.getElementById('notification-close');
    const deleteDialog = document.getElementById('vaccine-delete-dialog');
    const deleteMessage = document.getElementById('vaccine-delete-message');
    const formFields = form.elements;

    let pets = [];
    let catalogEntries = [];
    let records = [];
    let selectedPetId = null;
    let editingRecordId = null;
    let editingCatalogEntry = null;
    let saving = false;
    let savingCatalog = false;
    let deleting = false;
    let editingCatalogId = null;

    const apiUrl = (path) => window.location.port === '5500'
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    function setStatus(message, isError = false) {
        statusMessage.textContent = message;
        statusMessage.hidden = !message;
        statusMessage.setAttribute('role', isError ? 'alert' : 'status');
    }

    function updateCatalogDateRequirement() {
        const status = formFields.namedItem('catalog_status').value;
        const date = formFields.namedItem('catalog_data_aplicacao');
        date.disabled = status !== 'aplicada';
        if (status !== 'aplicada') date.value = '';
    }

    function setFormError(message) {
        formError.textContent = message;
        formError.hidden = !message;
    }

    function setCatalogStatus(message, isError = false) {
        catalogStatus.textContent = message;
        catalogStatus.hidden = !message;
        catalogStatus.setAttribute('role', isError ? 'alert' : 'status');
    }

    function rememberSelectedPet(id) {
        try {
            if (id) sessionStorage.setItem('mabel.selectedPetId', id);
            else sessionStorage.removeItem('mabel.selectedPetId');
        } catch {
            // Selection is still available for the current page when storage is unavailable.
        }
    }

    async function request(path, options = {}) {
        const { response, result } = await MabelApiResponse.fetchJson(fetch, apiUrl(path), {
                ...options,
                credentials: window.location.port === '5500' ? 'include' : 'same-origin',
                cache: 'no-store'
            });

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

    function formatDate(value) {
        if (!value) return 'Não informada';
        const [year, month, day] = value.split('-').map(Number);
        return new Intl.DateTimeFormat('pt-BR').format(new Date(year, month - 1, day));
    }

    function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function selectedPetName() {
        return pets.find((pet) => pet.id === selectedPetId)?.nome || 'pet selecionado';
    }

    function createCatalogEditor(entry, { autoSaveOnChoice = true, preserveHistory = false } = {}) {
        const card = makeElement('article', 'vaccine-catalog-card');
        const title = makeElement('h3', '', entry.nome);
        const description = makeElement('p', '', entry.descricao);
        const choices = makeElement('div', 'vaccine-choice-group');
        choices.setAttribute('role', 'group');
        choices.setAttribute('aria-label', `Situação de ${entry.nome}`);
        let draftStatus = entry.status;
        let draftDate = entry.data_aplicacao || '';

        const dateRow = makeElement('div', 'vaccine-date-row');
        const dateLabel = makeElement('label', '', 'Data da aplicação (opcional)');
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = draftDate;
        dateInput.setAttribute('aria-label', `Data da aplicação de ${entry.nome}, se conhecida`);
        dateLabel.append(dateInput);

        const saveButton = makeElement(
            'button',
            'primary-button vaccine-catalog-save',
            autoSaveOnChoice ? 'Salvar vacina' : 'Salvar classificação'
        );
        saveButton.type = 'button';
        saveButton.disabled = true;
        dateRow.append(dateLabel);
        const actions = makeElement('div', 'vaccine-catalog-actions');
        actions.append(saveButton);

        const statusOptions = [
            { status: 'aplicada', label: 'Já tomou' },
            { status: 'nao_aplicada', label: 'Ainda não tomou' },
            { status: 'desconhecida', label: 'Não sei informar' }
        ];

        function updateDraftUI() {
            for (const button of choices.querySelectorAll('button')) {
                button.setAttribute('aria-pressed', String(button.dataset.status === draftStatus));
            }
            dateLabel.hidden = draftStatus !== 'aplicada';
            dateRow.hidden = draftStatus !== 'aplicada';
            saveButton.disabled = !draftStatus
                || !MabelVaccineState.catalogDraftHasChanges(entry, draftStatus, dateInput.value);
            actions.hidden = autoSaveOnChoice && draftStatus !== 'aplicada';
        }

        for (const option of statusOptions) {
            const button = makeElement('button', 'vaccine-choice', option.label);
            button.type = 'button';
            button.dataset.status = option.status;
            button.setAttribute('aria-pressed', String(draftStatus === option.status));
            button.addEventListener('click', () => {
                draftStatus = option.status;
                if (draftStatus !== 'aplicada') {
                    draftDate = '';
                    dateInput.value = '';
                } else {
                    dateInput.value = draftDate;
                }
                updateDraftUI();
                if (autoSaveOnChoice && draftStatus !== 'aplicada') {
                    saveCatalogState(
                        entry.id,
                        draftStatus,
                        draftStatus === 'aplicada' ? dateInput.value || null : null,
                        card
                    );
                }
            });
            choices.append(button);
        }

        dateInput.addEventListener('change', () => {
            draftDate = dateInput.value;
            updateDraftUI();
        });
        saveButton.addEventListener('click', () => {
            saveCatalogState(
                entry.id,
                draftStatus,
                draftStatus === 'aplicada' ? dateInput.value || null : null,
                card,
                preserveHistory
            );
        });

        card.append(title, description, choices, dateRow, actions);
        updateDraftUI();
        return card;
    }

    function renderCatalog(entries) {
        catalogList.replaceChildren();
        const pending = MabelVaccineState.pendingCatalogEntries(entries);
        catalogEmptyState.hidden = pending.length > 0;
        for (const entry of pending) catalogList.append(createCatalogEditor(entry));
    }

    function renderCatalogClassification(entry) {
        if (editingCatalogId === entry.id) {
            const editor = createCatalogEditor(entry, {
                autoSaveOnChoice: false,
                preserveHistory: true
            });
            const cancelButton = makeElement('button', 'secondary-button', 'Cancelar alteração');
            cancelButton.type = 'button';
            cancelButton.addEventListener('click', () => {
                editingCatalogId = null;
                renderRecords();
            });
            editor.append(cancelButton);
            return editor;
        }

        const article = makeElement('article', 'vaccine-record vaccine-record-classification');
        const header = makeElement('div', 'vaccine-record-header');
        const presentation = MabelVaccineState.historyCardPresentation(null, entry);
        const heading = makeElement('h3', '', entry.nome);
        const status = makeElement('div', 'vaccine-record-status');
        status.append(makeElement(
            'span',
            `vaccine-status-badge ${presentation.statusClass}`,
            presentation.statusLabel
        ));
        if (presentation.applicationDate) {
            status.append(makeElement(
                'p',
                'vaccine-record-application-date',
                `Data da aplicação: ${formatDate(presentation.applicationDate)}`
            ));
        }
        header.append(heading, status);
        const actions = makeElement('div', 'vaccine-record-actions');
        const editButton = makeElement('button', 'secondary-button', 'Editar');
        editButton.type = 'button';
        editButton.addEventListener('click', () => {
            editingCatalogId = entry.id;
            renderRecords();
        });
        actions.append(editButton);
        article.append(header);
        article.append(actions);
        return article;
    }

    function renderRecords() {
        recordList.replaceChildren();
        const history = MabelVaccineState.buildHistoryEntries(records, catalogEntries);
        recordEmptyState.hidden = history.length > 0;

        for (const item of history) {
            if (item.kind === 'classification') {
                recordList.append(renderCatalogClassification(item.entry));
                continue;
            }

            const { record, catalogEntry } = item;
            const article = makeElement('article', 'vaccine-record');
            const header = makeElement('div', 'vaccine-record-header');
            const heading = makeElement('h3', '', record.nome_vacina);
            const presentation = MabelVaccineState.historyCardPresentation(record, catalogEntry);
            const status = makeElement('div', 'vaccine-record-status');
            status.append(makeElement(
                'span',
                `vaccine-status-badge ${presentation.statusClass}`,
                presentation.statusLabel
            ));
            if (presentation.applicationDate) {
                status.append(makeElement(
                    'p',
                    'vaccine-record-application-date',
                    `Data da aplicação: ${formatDate(presentation.applicationDate)}`
                ));
            }
            header.append(heading, status);

            const details = makeElement('div', 'vaccine-record-details');
            if (record.data_prevista) {
                details.append(makeElement('p', '', `Data prevista: ${formatDate(record.data_prevista)}`));
            }
            if (record.veterinario) details.append(makeElement('p', '', `Veterinário: ${record.veterinario}`));
            if (record.clinica) details.append(makeElement('p', '', `Clínica: ${record.clinica}`));
            if (record.observacoes) {
                details.append(makeElement('p', 'full-width', `Observações: ${record.observacoes}`));
            }

            const actions = makeElement('div', 'vaccine-record-actions');
            const editButton = makeElement('button', 'secondary-button', 'Editar');
            editButton.type = 'button';
            editButton.addEventListener('click', () => beginEditing(record, catalogEntry));
            actions.append(editButton);
            article.append(header, details, actions);
            recordList.append(article);
        }
    }

    function dateOrdinal(year, month, day) {
        return Date.UTC(year, month - 1, day) / 86400000;
    }

    function localTodayOrdinal() {
        const today = new Date();
        return dateOrdinal(today.getFullYear(), today.getMonth() + 1, today.getDate());
    }

    function renderNotifications(notifications) {
        notificationList.replaceChildren();
        const today = localTodayOrdinal();
        const upcoming = notifications
            .map((item) => {
                const [year, month, day] = item.data_prevista.split('-').map(Number);
                return { ...item, daysUntil: dateOrdinal(year, month, day) - today };
            })
            .filter((item) => item.daysUntil <= 30)
            .sort((first, second) => first.daysUntil - second.daysUntil);

        notificationCount.textContent = upcoming.length > 99 ? '99+' : String(upcoming.length);
        notificationCount.hidden = upcoming.length === 0;

        if (upcoming.length === 0) {
            notificationList.append(makeElement(
                'p',
                'notification-empty',
                'Não há doses previstas próximas ou atrasadas nos registros cadastrados.'
            ));
            return;
        }

        notificationList.className = 'notification-list';
        for (const item of upcoming) {
            const overdue = item.daysUntil < 0;
            let when;
            if (overdue) when = `Atrasada desde ${formatDate(item.data_prevista)}`;
            else if (item.daysUntil === 0) when = 'Prevista para hoje';
            else when = `Prevista para ${formatDate(item.data_prevista)}`;

            const entry = makeElement('article', `notification-item${overdue ? ' is-overdue' : ''}`);
            entry.append(
                makeElement('strong', '', overdue ? 'Dose atrasada' : 'Dose próxima'),
                makeElement('span', '', `${item.nome_vacina} — ${item.pet_nome}`),
                makeElement('span', '', when)
            );
            notificationList.append(entry);
        }
    }

    async function loadNotifications() {
        notificationList.className = '';
        notificationList.textContent = 'Carregando notificações...';
        notificationCount.hidden = true;
        try {
            const result = await request('/api/vacinas/notificacoes');
            if (!Array.isArray(result.notificacoes)) {
                throw new Error('A lista de notificações retornada pelo servidor é inválida.');
            }
            renderNotifications(result.notificacoes);
        } catch (error) {
            notificationList.replaceChildren(makeElement(
                'p',
                'notification-error',
                error.message || 'Não foi possível carregar as notificações.'
            ));
            notificationCount.hidden = true;
        }
    }

    async function loadRecords() {
        if (!selectedPetId) {
            records = [];
            recordList.replaceChildren();
            recordEmptyState.hidden = true;
            return true;
        }

        setStatus('Carregando o histórico de vacinação...');
        petSelector.disabled = true;
        addButton.disabled = true;
        recordList.replaceChildren(makeElement('p', 'vaccine-loading', 'Carregando registros...'));
        recordEmptyState.hidden = true;
        try {
            const result = await request(
                `/api/vacinas/pets/${encodeURIComponent(selectedPetId)}/registros`
            );
            if (!Array.isArray(result.registros)) {
                throw new Error('O histórico retornado pelo servidor é inválido.');
            }
            records = result.registros;
            renderRecords();
            setStatus('');
            return true;
        } catch (error) {
            records = [];
            recordList.replaceChildren();
            recordEmptyState.hidden = true;
            setStatus(error.message || 'Não foi possível carregar o histórico.', true);
            return false;
        } finally {
            petSelector.disabled = pets.length === 0;
            addButton.disabled = pets.length === 0;
        }
    }

    async function loadCatalog() {
        if (!selectedPetId) {
            catalogEntries = [];
            catalogList.replaceChildren();
            catalogEmptyState.hidden = true;
            setCatalogStatus('');
            return true;
        }

        setCatalogStatus('Carregando vacinas iniciais...');
        catalogList.replaceChildren();
        try {
            const result = await request(
                `/api/vacinas/pets/${encodeURIComponent(selectedPetId)}/catalogo`
            );
            if (!Array.isArray(result.catalogo)) {
                throw new Error('O catálogo de vacinas retornado pelo servidor é inválido.');
            }
            catalogEntries = result.catalogo;
            renderCatalog(catalogEntries);
            renderRecords();
            setCatalogStatus('');
            return true;
        } catch (error) {
            catalogEntries = [];
            catalogList.replaceChildren();
            renderRecords();
            catalogEmptyState.hidden = true;
            setCatalogStatus(error.message || 'Não foi possível carregar o catálogo de vacinas.', true);
            return false;
        }
    }

    async function saveCatalogState(vaccineId, status, applicationDate, card, preserveHistory = false) {
        if (savingCatalog || !selectedPetId) return;
        savingCatalog = true;
        const petId = selectedPetId;
        const buttons = [...card.querySelectorAll('button')];
        buttons.forEach((button) => { button.disabled = true; });
        petSelector.disabled = true;
        setCatalogStatus('Salvando situação da vacina...');

        try {
            const result = await request(
                `/api/vacinas/pets/${encodeURIComponent(petId)}/catalogo/${encodeURIComponent(vaccineId)}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status,
                        data_aplicacao: status === 'aplicada' ? applicationDate : null,
                        ...(preserveHistory ? { preserve_history: true } : {})
                    })
                }
            );
            if (
                !result.vacina
                || result.vacina.id !== vaccineId
                || result.vacina.status !== status
                || (result.vacina.data_aplicacao || null) !== (status === 'aplicada' ? applicationDate : null)
            ) {
                throw new Error('O servidor não confirmou a situação e a data enviadas. Confira os dados e tente novamente.');
            }
            if (selectedPetId === petId) {
                const savedEntry = catalogEntries.find((entry) => entry.id === vaccineId);
                if (savedEntry) {
                    savedEntry.status = result.vacina.status;
                    savedEntry.data_aplicacao = result.vacina.data_aplicacao;
                }
                editingCatalogId = null;
                renderCatalog(catalogEntries);
                renderRecords();
                const [catalogLoaded, recordsLoaded] = await Promise.all([loadCatalog(), loadRecords()]);
                if (catalogLoaded && recordsLoaded) setCatalogStatus('Situação da vacina salva.');
                else setCatalogStatus('Situação salva, mas não foi possível atualizar todos os dados exibidos.', true);
            }
        } catch (error) {
            setCatalogStatus(error.message || 'Não foi possível salvar a situação.', true);
        } finally {
            savingCatalog = false;
            petSelector.disabled = pets.length === 0;
            buttons.forEach((button) => { button.disabled = false; });
        }
    }

    async function loadPets() {
        setStatus('Carregando pets...');
        petSelector.disabled = true;
        addButton.disabled = true;
        try {
            const result = await request('/api/perfil/pet');
            if (!Array.isArray(result.pets)) {
                throw new Error('A lista de pets retornada pelo servidor é inválida.');
            }
            pets = result.pets.map((pet) => ({ ...pet, id: String(pet.id) }));
            petSelector.replaceChildren();

            for (const pet of pets) {
                const option = document.createElement('option');
                option.value = pet.id;
                option.textContent = pet.nome;
                petSelector.append(option);
            }

            if (pets.length === 0) {
                selectedPetId = null;
                rememberSelectedPet(null);
                petSelector.append(new Option('Nenhum pet cadastrado', ''));
                petSelector.disabled = true;
                addButton.disabled = true;
                records = [];
                recordList.replaceChildren();
                recordEmptyState.hidden = true;
                catalogEntries = [];
                catalogList.replaceChildren();
                renderRecords();
                catalogEmptyState.hidden = true;
                setCatalogStatus('');
                setStatus('Cadastre um pet no Perfil antes de registrar vacinas.');
                await loadNotifications();
                return;
            }

            let preferredId = new URLSearchParams(window.location.search).get('petId');
            if (!preferredId) {
                try {
                    preferredId = sessionStorage.getItem('mabel.selectedPetId');
                } catch {
                    preferredId = null;
                }
            }
            selectedPetId = pets.some((pet) => pet.id === preferredId)
                ? preferredId
                : pets[0].id;
            petSelector.value = selectedPetId;
            rememberSelectedPet(selectedPetId);
            petSelector.disabled = false;
            addButton.disabled = false;
            await Promise.all([loadRecords(), loadCatalog(), loadNotifications()]);
        } catch (error) {
            if (error.message !== 'Sua sessão expirou. Redirecionando para o login.') {
                setStatus(error.message || 'Não foi possível carregar os pets.', true);
            }
            petSelector.disabled = true;
            addButton.disabled = true;
        }
    }

    function updateDateRequirements() {
        const status = formFields.namedItem('status').value;
        const scheduledDate = formFields.namedItem('data_prevista');
        const applicationDate = formFields.namedItem('data_aplicacao');
        scheduledDate.required = status === 'prevista';
        applicationDate.required = false;
        applicationDate.disabled = status === 'prevista';
        if (status === 'prevista') applicationDate.value = '';
    }

    function beginEditing(record = null, catalogEntry = null) {
        editingRecordId = record ? String(record.id) : null;
        editingCatalogEntry = catalogEntry;
        formTitle.textContent = record ? 'Editar registro de vacinação' : 'Registrar dose';
        formFields.namedItem('nome_vacina').value = record?.nome_vacina || '';
        formFields.namedItem('status').value = record?.status || 'prevista';
        formFields.namedItem('data_prevista').value = record?.data_prevista || '';
        formFields.namedItem('data_aplicacao').value = record?.data_aplicacao || '';
        formFields.namedItem('veterinario').value = record?.veterinario || '';
        formFields.namedItem('clinica').value = record?.clinica || '';
        formFields.namedItem('observacoes').value = record?.observacoes || '';
        catalogEditSection.hidden = !catalogEntry;
        deleteButton.hidden = !record;
        if (catalogEntry) {
            formFields.namedItem('catalog_status').value = catalogEntry.status;
            formFields.namedItem('catalog_data_aplicacao').value = catalogEntry.data_aplicacao || '';
            updateCatalogDateRequirement();
        }
        setFormError('');
        updateDateRequirements();
        form.hidden = false;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        formFields.namedItem('nome_vacina').focus();
    }

    function cancelEditing() {
        form.reset();
        form.hidden = true;
        editingRecordId = null;
        editingCatalogEntry = null;
        catalogEditSection.hidden = true;
        deleteButton.hidden = true;
        setFormError('');
        updateDateRequirements();
    }

    function buildPayload() {
        const status = formFields.namedItem('status').value;
        return {
            nome_vacina: formFields.namedItem('nome_vacina').value.trim(),
            status,
            data_prevista: formFields.namedItem('data_prevista').value || null,
            data_aplicacao: status === 'aplicada'
                ? formFields.namedItem('data_aplicacao').value || null
                : null,
            veterinario: formFields.namedItem('veterinario').value.trim() || null,
            clinica: formFields.namedItem('clinica').value.trim() || null,
            observacoes: formFields.namedItem('observacoes').value.trim() || null
        };
    }

    function confirmDelete(record) {
        deleteMessage.textContent =
            `Excluir o registro de "${record.nome_vacina}" para ${selectedPetName()}? Esta ação não pode ser desfeita.`;
        const confirmation = new Promise((resolve) => {
            deleteDialog.addEventListener('close', () => {
                resolve(deleteDialog.returnValue === 'delete');
            }, { once: true });
        });
        deleteDialog.showModal();
        return confirmation;
    }

    async function deleteRecord(record) {
        if (deleting || !(await confirmDelete(record))) return;
        deleting = true;
        setStatus('Excluindo registro...');

        try {
            await request(
                `/api/vacinas/pets/${encodeURIComponent(selectedPetId)}/registros/${encodeURIComponent(record.id)}`,
                { method: 'DELETE' }
            );
            if (editingRecordId === String(record.id)) cancelEditing();
            const [recordsLoaded] = await Promise.all([loadRecords(), loadNotifications()]);
            if (recordsLoaded) setStatus('Registro de vacinação excluído.');
        } catch (error) {
            setStatus(error.message || 'Não foi possível excluir o registro.', true);
        } finally {
            deleting = false;
        }
    }

    petSelector.addEventListener('change', async () => {
        selectedPetId = petSelector.value;
        rememberSelectedPet(selectedPetId);
        cancelEditing();
        catalogEntries = [];
        records = [];
        catalogList.replaceChildren();
        recordList.replaceChildren();
        catalogEmptyState.hidden = true;
        recordEmptyState.hidden = true;
        setCatalogStatus('');
        await loadRecords();
        await loadCatalog();
    });

    addButton.addEventListener('click', () => beginEditing());
    formFields.namedItem('status').addEventListener('change', updateDateRequirements);
    formFields.namedItem('catalog_status').addEventListener('change', updateCatalogDateRequirement);
    cancelButton.addEventListener('click', cancelEditing);
    deleteButton.addEventListener('click', () => {
        const record = records.find((item) => String(item.id) === editingRecordId);
        if (record) deleteRecord(record);
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving || !form.reportValidity() || !selectedPetId) return;
        setFormError('');
        saving = true;
        saveButton.disabled = true;
        cancelButton.disabled = true;
        petSelector.disabled = true;

        const isEditing = editingRecordId !== null;
        const catalogEntryToSave = editingCatalogEntry;
        const petId = selectedPetId;
        const recordPayload = buildPayload();
        const catalogStatus = catalogEntryToSave
            ? formFields.namedItem('catalog_status').value
            : null;
        const catalogApplicationDate = catalogEntryToSave && catalogStatus === 'aplicada'
            ? formFields.namedItem('catalog_data_aplicacao').value || null
            : null;
        for (const control of form.elements) control.disabled = true;
        const path = `/api/vacinas/pets/${encodeURIComponent(petId)}/registros`
            + (isEditing ? `/${encodeURIComponent(editingRecordId)}` : '');
        let recordSaved = false;
        try {
            await request(path, {
                method: isEditing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(recordPayload)
            });
            recordSaved = true;
            if (isEditing && catalogEntryToSave) {
                await request(
                    `/api/vacinas/pets/${encodeURIComponent(petId)}/catalogo/${encodeURIComponent(catalogEntryToSave.id)}`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: catalogStatus,
                            data_aplicacao: catalogApplicationDate,
                            preserve_history: true
                        })
                    }
                );
            }
            cancelEditing();
            const [recordsLoaded] = await Promise.all([loadRecords(), loadNotifications()]);
            if (recordsLoaded) setStatus(isEditing
                ? 'Registro de vacinação atualizado.'
                : 'Dose registrada.');
        } catch (error) {
            if (error.message !== 'Sua sessão expirou. Redirecionando para o login.') {
                if (recordSaved && catalogEntryToSave) {
                    await Promise.all([loadRecords(), loadCatalog()]);
                    setFormError(
                        `Os dados da dose foram salvos, mas a classificação não foi atualizada. ${error.message || ''}`.trim()
                    );
                } else if (recordSaved) {
                    cancelEditing();
                    await Promise.all([loadRecords(), loadNotifications()]);
                    setStatus('A dose foi salva, mas a página não conseguiu atualizar completamente.', true);
                } else {
                    setFormError(error.message || 'Não foi possível salvar o registro.');
                }
            }
        } finally {
            saving = false;
            for (const control of form.elements) control.disabled = false;
            updateDateRequirements();
            updateCatalogDateRequirement();
            petSelector.disabled = pets.length === 0;
        }
    });

    notificationsButton.addEventListener('click', async () => {
        const opening = notificationPanel.hidden;
        notificationPanel.hidden = !opening;
        notificationsButton.setAttribute('aria-expanded', String(opening));
        if (opening) await loadNotifications();
    });

    notificationClose.addEventListener('click', () => {
        notificationPanel.hidden = true;
        notificationsButton.setAttribute('aria-expanded', 'false');
        notificationsButton.focus();
    });

    loadPets();
});
