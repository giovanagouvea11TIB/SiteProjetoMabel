(function exposeHomeState(root, factory) {
    const homeState = factory();
    if (typeof module === "object" && module.exports) module.exports = homeState;
    if (root) root.MabelHomeState = homeState;
}(typeof globalThis === "object" ? globalThis : this, () => {
    const PET_ICON_STORAGE_KEY = "mabel.petIcons";
    const PET_ICONS = new Set([
        "dog-tan",
        "dog-gray",
        "cat-orange",
        "cat-gray"
    ]);

    function isValidIsoDate(value) {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

        const [year, month, day] = value.split("-").map(Number);
        const date = new Date(0);
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCFullYear(year, month - 1, day);
        return date.getUTCFullYear() === year
            && date.getUTCMonth() === month - 1
            && date.getUTCDate() === day;
    }

    function summarizeVaccines(records, today) {
        const rows = Array.isArray(records) ? records : [];
        const pendingRecords = rows.filter((record) => record?.status === "prevista");
        const datedRecords = pendingRecords
            .filter((record) => isValidIsoDate(record.data_prevista))
            .sort((first, second) => first.data_prevista.localeCompare(second.data_prevista));

        return {
            hasRecords: rows.length > 0,
            pendingCount: pendingRecords.length,
            invalidPendingCount: pendingRecords.length - datedRecords.length,
            earliestOverdue: datedRecords.find((record) => record.data_prevista < today) || null,
            nextUpcoming: datedRecords.find((record) => record.data_prevista >= today) || null
        };
    }

    function loadPetIcons(storage) {
        try {
            const saved = storage.getItem(PET_ICON_STORAGE_KEY);
            if (!saved) return new Map();

            const parsed = JSON.parse(saved);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return new Map();
            }

            return new Map(Object.entries(parsed).filter(([petId, icon]) =>
                /^[1-9]\d*$/.test(petId) && PET_ICONS.has(icon)
            ));
        } catch {
            return new Map();
        }
    }

    function savePetIcons(storage, icons) {
        const validIcons = Object.fromEntries([...icons].filter(([petId, icon]) =>
            /^[1-9]\d*$/.test(petId) && PET_ICONS.has(icon)
        ));

        try {
            storage.setItem(PET_ICON_STORAGE_KEY, JSON.stringify(validIcons));
            return true;
        } catch {
            return false;
        }
    }

    return { isValidIsoDate, summarizeVaccines, loadPetIcons, savePetIcons };
}));
