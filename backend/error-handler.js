const { isTransientDatabaseError } = require("./database-errors");

function createErrorHandler() {
    return function handleError(error, req, res, next) {
        if (res.headersSent) return next(error);

        const safeError = error instanceof Error
            ? error
            : new Error("O middleware recebeu uma falha sem objeto de erro.");
        const status = Number(safeError.status) || 500;
        if (status === 400 || status === 413) {
            return res.status(status).json({
                sucesso: false,
                mensagem: "O corpo da requisição é inválido ou excede o limite permitido."
            });
        }

        if (isTransientDatabaseError(safeError)) {
            console.error("Falha temporária de banco ao processar requisição:", safeError.code);
            return res.status(503).json({
                sucesso: false,
                mensagem: "O banco de dados está temporariamente indisponível. Tente novamente em instantes."
            });
        }

        console.error("Erro ao processar requisição:", safeError.code || "erro não identificado");
        return res.status(500).json({
            sucesso: false,
            mensagem: "Erro interno ao processar a requisição."
        });
    };
}

module.exports = { createErrorHandler };
