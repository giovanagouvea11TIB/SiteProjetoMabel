const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isValidIsoDate, summarizeVaccines, loadPetIcons, savePetIcons } = require("./home-state");

test("vaccine summary ignores applied doses when finding the next pending date", () => {
    const summary = summarizeVaccines([
        { status: "aplicada", data_prevista: "2026-10-14" },
        { status: "prevista", data_prevista: "2026-11-02" },
        { status: "prevista", data_prevista: "2026-10-20" }
    ], "2026-10-13");

    assert.equal(summary.earliestOverdue, null);
    assert.equal(summary.nextUpcoming.data_prevista, "2026-10-20");
    assert.equal(summary.pendingCount, 2);
});

test("vaccine summary separates overdue and future pending doses", () => {
    const summary = summarizeVaccines([
        { status: "prevista", data_prevista: "2026-10-01" },
        { status: "prevista", data_prevista: "2026-10-20" },
        { status: "prevista", data_prevista: "2026-10-05" }
    ], "2026-10-13");

    assert.equal(summary.earliestOverdue.data_prevista, "2026-10-01");
    assert.equal(summary.nextUpcoming.data_prevista, "2026-10-20");
});

test("vaccine summary accepts today as upcoming and reports pending dates that are absent or invalid", () => {
    const summary = summarizeVaccines([
        { status: "prevista", data_prevista: "2026-10-13" },
        { status: "prevista", data_prevista: null },
        { status: "prevista", data_prevista: "2026-02-30" }
    ], "2026-10-13");

    assert.equal(summary.earliestOverdue, null);
    assert.equal(summary.nextUpcoming.data_prevista, "2026-10-13");
    assert.equal(summary.invalidPendingCount, 2);
});

test("vaccine summary distinguishes no records from no pending doses", () => {
    const empty = summarizeVaccines([], "2026-10-13");
    const appliedOnly = summarizeVaccines([
        { status: "aplicada", data_aplicacao: "2026-10-01" }
    ], "2026-10-13");

    assert.equal(empty.hasRecords, false);
    assert.equal(appliedOnly.hasRecords, true);
    assert.equal(appliedOnly.pendingCount, 0);
});

test("ISO date validation rejects impossible calendar dates", () => {
    assert.equal(isValidIsoDate("2024-02-29"), true);
    assert.equal(isValidIsoDate("2026-02-29"), false);
    assert.equal(isValidIsoDate("2026-13-01"), false);
    assert.equal(isValidIsoDate("01/10/2026"), false);
});

test("pet icons persist per pet and ignore invalid stored entries", () => {
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) || null,
        setItem: (key, value) => data.set(key, value)
    };

    const icons = new Map([
        ["12", "dog-tan"],
        ["15", "cat-gray"],
        ["0", "cat-orange"],
        ["17", "unexpected"]
    ]);

    assert.equal(savePetIcons(storage, icons), true);
    assert.deepEqual([...loadPetIcons(storage)], [
        ["12", "dog-tan"],
        ["15", "cat-gray"]
    ]);
});

test("pet icon persistence reports storage failures", () => {
    const unavailableStorage = {
        getItem() {
            throw new Error("storage unavailable");
        },
        setItem() {
            throw new Error("storage unavailable");
        }
    };

    assert.deepEqual([...loadPetIcons(unavailableStorage)], []);
    assert.equal(savePetIcons(unavailableStorage, new Map([["12", "dog-tan"]])), false);
});
