const { app } = require("../backend/server");
const { rewriteApiRequestUrl } = require("../backend/api-route-rewrite");

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

function registrarFalhaHandler(erro) {
    console.error("Falha ao encaminhar requisição para a API na Vercel:", {
        stage: "handler.app",
        name: erro?.name || "Error",
        code: erro?.code || null,
        message: mensagemErroSegura(erro)
    });
}

module.exports = function handler(req, res) {
    const rewrittenUrl = rewriteApiRequestUrl(req.url);
    if (rewrittenUrl === null) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "O caminho encaminhado para a API é inválido."
        });
    }
    req.url = rewrittenUrl;

    try {
        return app(req, res);
    } catch (erro) {
        registrarFalhaHandler(erro);
        return res.status(500).json({
            sucesso: false,
            mensagem: "Não foi possível processar a requisição da API."
        });
    }
};
