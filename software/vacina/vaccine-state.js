(function exposeVaccineState(root, factory) {
    const vaccineState = factory();
    if (typeof module === 'object' && module.exports) module.exports = vaccineState;
    if (root) root.MabelVaccineState = vaccineState;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    function pendingCatalogEntries(entries) {
        return entries.filter((entry) => !entry.status);
    }

    function catalogStatusLabel(status) {
        if (status === 'aplicada') return 'Aplicada';
        if (status === 'nao_aplicada') return 'Não aplicada';
        if (status === 'desconhecida') return 'Situação desconhecida';
        return 'Pendente de classificação';
    }

    function catalogDraftHasChanges(entry, status, applicationDate) {
        if (status !== entry.status) return true;
        return status === 'aplicada'
            && (applicationDate || null) !== (entry.data_aplicacao || null);
    }

    function historyCardPresentation(record, catalogEntry = null) {
        const isDose = Boolean(record);
        const status = isDose ? record.status : catalogEntry?.status;
        const statusLabel = isDose
            ? status === 'aplicada' ? 'Aplicada' : 'Prevista'
            : catalogStatusLabel(status);
        const applicationDate = isDose
            ? record.data_aplicacao || null
            : catalogEntry?.data_aplicacao || null;

        return {
            status,
            statusLabel,
            statusClass: status === 'aplicada'
                ? 'is-aplicada'
                : status === 'nao_aplicada' || status === 'desconhecida'
                    ? `is-${status}`
                    : '',
            applicationDate
        };
    }

    function buildHistoryEntries(records, catalogEntries) {
        const history = records.map((record) => ({
            kind: 'dose',
            record,
            catalogEntry: null
        }));
        const unmatchedApplied = [];

        for (const entry of catalogEntries) {
            if (!entry.status) continue;

            if (entry.status === 'aplicada') {
                unmatchedApplied.push(entry);
                continue;
            }
            history.push({ kind: 'classification', entry });
        }

        unmatchedApplied.sort((first, second) =>
            (second.data_aplicacao || '').localeCompare(first.data_aplicacao || '')
        );
        history.push(...unmatchedApplied.map((entry) => ({ kind: 'classification', entry })));
        return history;
    }

    return {
        pendingCatalogEntries,
        catalogStatusLabel,
        catalogDraftHasChanges,
        historyCardPresentation,
        buildHistoryEntries
    };
}));
