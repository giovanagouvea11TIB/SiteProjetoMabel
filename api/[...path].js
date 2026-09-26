const { app, initialize } = require("../backend/server");

let initializationPromise;

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
        console.error("Falha ao preparar API na Vercel:", erro.code || "erro não identificado");
        return res.status(500).json({
            sucesso: false,
            mensagem: "Não foi possível inicializar a API. Verifique as variáveis de ambiente do servidor."
        });
    }
};
