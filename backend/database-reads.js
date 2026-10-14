const RETRYABLE_READ_ERROR_CODES = new Set([
    "ECONNRESET",
    "PROTOCOL_CONNECTION_LOST"
]);

async function runReadWithRetry(run, action, warn = console.warn) {
    try {
        return await run();
    } catch (error) {
        if (!RETRYABLE_READ_ERROR_CODES.has(error?.code)) throw error;

        warn(`Conexão MySQL reiniciada ao ${action}; repetindo leitura uma vez.`, error.code);
        return run();
    }
}

function createSessionPoolAdapter(pool) {
    return {
        query(sql, params) {
            const run = () => pool.query(sql, params);
            if (/^\s*SELECT\b/i.test(sql)) {
                return runReadWithRetry(run, "consultar sessão");
            }
            return run();
        }
    };
}

module.exports = { RETRYABLE_READ_ERROR_CODES, runReadWithRetry, createSessionPoolAdapter };
