const { app, initialize } = require("../backend/server");

let initializationPromise;

function mensagemErroSegura(erro) {
    let mensagem = String(erro?.message || "Erro sem mensagem.");
    const segredos = [
        process.env.DB_HOST,
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        process.env.EMAIL_USER,
        process.env.EMAIL_APP_PASSWORD,
        process.env.RESEND_API_KEY,
        process.env.FROM_EMAIL
    ].filter(Boolean).sort((a, b) => b.length - a.length);

    for (const segredo of segredos) {
        mensagem = mensagem.replaceAll(segredo, "[REDACTED]");
        const semEspacos = segredo.replace(/\s/g, "");
        if (semEspacos !== segredo) mensagem = mensagem.replaceAll(semEspacos, "[REDACTED]");
    }

    return mensagem;
}

module.exports = async function handler(req, res) {
    try {
        if (!initializationPromise) {
            initializationPromise = initialize().catch((erro) => {
                initializationPromise = null;
                throw erro;
            });
        }

        await initializationPromise;
        return app(req, res);
    } catch (erro) {
        console.error("Falha ao preparar API na Vercel:", {
            stage: "initialize.ensureAvaliacaoTable",
            name: erro?.name || "Error",
            code: erro?.code || null,
            message: mensagemErroSegura(erro),
            environment: {
                dbHostConfigured: Boolean(process.env.DB_HOST),
                dbPortConfigured: Boolean(process.env.DB_PORT),
                dbUserConfigured: Boolean(process.env.DB_USER),
                dbPasswordConfigured: Boolean(process.env.DB_PASSWORD),
                databaseVariable: process.env.DB_DATABASE
                    ? "DB_DATABASE"
                    : process.env.DB_NAME
                        ? "DB_NAME"
                        : "default"
            }
        });
        return res.status(500).json({
            sucesso: false,
            mensagem: "Não foi possível inicializar a API. Verifique as variáveis de ambiente do servidor."
        });
    }
};
