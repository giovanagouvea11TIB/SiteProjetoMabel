const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    buildHistoryEntries,
    catalogStatusLabel,
    catalogDraftHasChanges,
    historyCardPresentation,
    pendingCatalogEntries
} = require("./vaccine-state");

const polivalent = {
    id: "polivalente_v8_v10",
    nome: "Polivalente canina (V8/V10)",
    descricao: "Orientação veterinária.",
    status: null,
    data_aplicacao: null
};

test("polivalent leaves pending and appears in the main history for every saved status", () => {
    const expectedLabels = new Map([
        ["aplicada", "Aplicada"],
        ["nao_aplicada", "Não aplicada"],
        ["desconhecida", "Situação desconhecida"]
    ]);

    for (const [status, label] of expectedLabels) {
        const entry = { ...polivalent, status };
        const pending = pendingCatalogEntries([entry]);
        const history = buildHistoryEntries([], [entry]);

        assert.deepEqual(pending, []);
        assert.equal(history.length, 1);
        assert.equal(history[0].kind, "classification");
        assert.equal(history[0].entry.status, status);
        assert.equal(catalogStatusLabel(history[0].entry.status), label);
    }
});

test("applied catalog classification remains separate from its matching dose", () => {
    const record = {
        id: "dose-1",
        nome_vacina: polivalent.nome,
        status: "aplicada",
        data_aplicacao: "2026-08-12"
    };
    const entry = {
        ...polivalent,
        status: "aplicada",
        data_aplicacao: "2026-08-12"
    };

    const history = buildHistoryEntries([record], [entry]);

    assert.equal(history.length, 2);
    assert.equal(history[0].kind, "dose");
    assert.equal(history[0].record.id, "dose-1");
    assert.equal(history[0].catalogEntry, null);
    assert.equal(history[1].kind, "classification");
    assert.equal(history[1].entry.id, polivalent.id);
});

test("divergent catalog classification does not replace or attach to any dose of the same vaccine", () => {
    const records = [
        {
            id: "dose-2",
            nome_vacina: polivalent.nome,
            status: "aplicada",
            data_aplicacao: "2026-08-12"
        },
        {
            id: "dose-3",
            nome_vacina: polivalent.nome,
            status: "aplicada",
            data_aplicacao: "2026-09-12"
        }
    ];
    const entry = {
        ...polivalent,
        status: "nao_aplicada",
        data_aplicacao: null
    };

    const history = buildHistoryEntries(records, [entry]);

    assert.equal(history.length, 3);
    assert.equal(history[0].kind, "dose");
    assert.equal(history[0].record.id, "dose-2");
    assert.equal(history[0].record.data_aplicacao, "2026-08-12");
    assert.equal(history[0].catalogEntry, null);
    assert.equal(history[1].kind, "dose");
    assert.equal(history[1].record.id, "dose-3");
    assert.equal(history[1].record.data_aplicacao, "2026-09-12");
    assert.equal(history[1].catalogEntry, null);
    assert.equal(history[2].kind, "classification");
    assert.equal(history[2].entry.status, "nao_aplicada");
});

test("unclassified catalog entries alone remain pending", () => {
    const entries = [
        polivalent,
        { ...polivalent, id: "antirrabica", nome: "Antirrábica", status: "desconhecida" }
    ];

    assert.deepEqual(pendingCatalogEntries(entries).map(({ id }) => id), [polivalent.id]);
});

test("catalog editor enables saving only after a changed status or applied date", () => {
    const applied = { ...polivalent, status: "aplicada", data_aplicacao: "2026-08-12" };
    const unknown = { ...polivalent, status: "desconhecida", data_aplicacao: null };

    assert.equal(catalogDraftHasChanges(applied, "aplicada", "2026-08-12"), false);
    assert.equal(catalogDraftHasChanges(applied, "aplicada", "2026-08-13"), true);
    assert.equal(catalogDraftHasChanges(applied, "nao_aplicada", ""), true);
    assert.equal(catalogDraftHasChanges(unknown, "desconhecida", ""), false);
    assert.equal(catalogDraftHasChanges(unknown, "aplicada", ""), true);
});

test("dose presentation preserves its own status and application date despite a divergent catalog state", () => {
    const record = {
        nome_vacina: polivalent.nome,
        status: "aplicada",
        data_aplicacao: "2026-08-12"
    };
    const entry = { ...polivalent, status: "nao_aplicada", data_aplicacao: null };
    const presentation = historyCardPresentation(record, entry);

    assert.deepEqual(presentation, {
        status: "aplicada",
        statusLabel: "Aplicada",
        statusClass: "is-aplicada",
        applicationDate: "2026-08-12"
    });
    assert.equal(presentation.statusLabel.match(/Aplicada/g).length, 1);
    assert.equal(presentation.applicationDate, record.data_aplicacao);
});

test("history card states use non-green indicators and omit unknown application dates", () => {
    const cases = [
        ["nao_aplicada", "Não aplicada", "is-nao_aplicada"],
        ["desconhecida", "Situação desconhecida", "is-desconhecida"]
    ];
    for (const [status, label, statusClass] of cases) {
        const presentation = historyCardPresentation(
            null,
            { ...polivalent, status, data_aplicacao: null }
        );
        assert.equal(presentation.statusLabel, label);
        assert.equal(presentation.statusClass, statusClass);
        assert.equal(presentation.applicationDate, null);
    }

    const appliedWithoutDate = historyCardPresentation(
        null,
        { ...polivalent, status: "aplicada", data_aplicacao: null }
    );
    assert.equal(appliedWithoutDate.statusLabel, "Aplicada");
    assert.equal(appliedWithoutDate.applicationDate, null);
});
