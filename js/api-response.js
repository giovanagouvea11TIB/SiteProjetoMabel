(function exposeApiResponse(root, factory) {
    const apiResponse = factory();
    if (typeof module === "object" && module.exports) module.exports = apiResponse;
    if (root) root.MabelApiResponse = apiResponse;
}(typeof globalThis === "object" ? globalThis : this, () => {
    async function readJsonResponse(response) {
        if (
            !response
            || typeof response.json !== "function"
            || typeof response.status !== "number"
            || typeof response.ok !== "boolean"
        ) {
            throw new Error("A solicitação não recebeu uma resposta HTTP válida.");
        }

        try {
            return { response, result: await response.json() };
        } catch {
            if (!response.ok) return { response, result: null };
            throw new Error(`O servidor respondeu HTTP ${response.status}, mas retornou dados inválidos.`);
        }
    }

    async function fetchJson(fetcher, url, options) {
        let response;
        try {
            response = await fetcher(url, options);
        } catch {
            throw new Error("Não foi possível conectar ao servidor; nenhuma resposta HTTP foi recebida.");
        }

        return readJsonResponse(response);
    }

    function errorMessage(response, result, fallback) {
        if (typeof result?.mensagem === "string" && result.mensagem) return result.mensagem;
        if (response && response.ok === false) {
            return `O servidor respondeu com HTTP ${response.status}, sem uma mensagem de erro legível.`;
        }
        return fallback;
    }

    return { readJsonResponse, fetchJson, errorMessage };
}));
