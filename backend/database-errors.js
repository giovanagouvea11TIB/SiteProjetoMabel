const TRANSIENT_DATABASE_ERROR_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "PROTOCOL_CONNECTION_LOST",
    "ER_CON_COUNT_ERROR",
    "POOL_ENQUEUELIMIT"
]);

function isTransientDatabaseError(error) {
    return TRANSIENT_DATABASE_ERROR_CODES.has(error?.code);
}

function sendDatabaseError(res, error, action, fallbackMessage) {
    const transient = isTransientDatabaseError(error);
    console.error(`Erro ao ${action}:`, error?.code || "erro não identificado");

    return res.status(transient ? 503 : 500).json({
        sucesso: false,
        mensagem: transient
            ? "O banco de dados está temporariamente indisponível. Tente novamente em instantes."
            : fallbackMessage
    });
}

module.exports = { isTransientDatabaseError, sendDatabaseError };
