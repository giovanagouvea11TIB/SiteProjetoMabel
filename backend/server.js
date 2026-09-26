const path = require("node:path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const express = require("express");
const cors = require("cors");
const { pool, ensureAvaliacaoTable } = require("./db");
const authRouter = require("./routes/auth");
const avaliacaoRouter = require("./routes/avaliacao");
const { enviarEmail, registrarErroEmail } = require("./email");
const { mensagemBoasVindas } = require("./mensagem");

const app = express();
const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);
let initializationPromise;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({
    origin(origin, callback) {
        const localFiveServer = /^https?:\/\/(localhost|127\.0\.0\.1):5500$/.test(origin || "");
        callback(null, !origin || localFiveServer);
    }
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use("/api/auth", authRouter);
app.use("/api/avaliacao", avaliacaoRouter);

app.get("/api/teste-db", async (req, res) => {
    try {
        const [resultado] = await pool.query("SELECT 1 AS conectado");
        return res.json({
            sucesso: true,
            mensagem: "Conexão com o MySQL funcionando!",
            resultado
        });
    } catch (erro) {
        console.error("Falha no teste MySQL:", erro.code || "erro não identificado");
        return res.status(500).json({ sucesso: false, mensagem: "Não foi possível conectar ao MySQL." });
    }
});

app.get("/api/status", (req, res) => {
    return res.json({ status: "online", mensagem: "Sistema funcionando!" });
});

const enviosBoasVindas = new Map();
app.post(["/send-welcome", "/api/send-welcome"], async (req, res) => {
    const nome = typeof req.body?.nome === "string" ? req.body.nome.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!nome || nome.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
        return res.status(400).json({ sucesso: false, mensagem: "Informe um nome e um e-mail válidos." });
    }

    const agora = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const ultimoEnvio = enviosBoasVindas.get(ip);
    if (ultimoEnvio && agora - ultimoEnvio < 60000) {
        return res.status(429).json({ sucesso: false, mensagem: "Aguarde um minuto antes de solicitar outro e-mail." });
    }
    if (enviosBoasVindas.size > 1000) {
        for (const [chave, horario] of enviosBoasVindas) {
            if (agora - horario >= 60000) enviosBoasVindas.delete(chave);
        }
    }
    enviosBoasVindas.set(ip, agora);

    try {
        await enviarEmail({ to: email, ...mensagemBoasVindas(nome) });
        return res.json({ sucesso: true, mensagem: "Email enviado!" });
    } catch (erroEmail) {
        registrarErroEmail("boas-vindas", erroEmail);
        return res.status(502).json({ sucesso: false, mensagem: "Não foi possível enviar o email. Verifique a configuração do serviço de email." });
    }
});

app.use((erro, req, res, next) => {
    if (res.headersSent) return next(erro);

    const status = Number(erro.status) || 500;
    if (status === 400 || status === 413) {
        return res.status(status).json({ sucesso: false, mensagem: "O corpo da requisição é inválido ou excede o limite permitido." });
    }

    console.error("Erro ao processar requisição:", erro.code || "erro não identificado");
    return res.status(500).json({ sucesso: false, mensagem: "Erro interno ao processar a requisição." });
});

app.use((req, res, next) => {
    if (/^\/(?:backend|node_modules|\.git)(?:\/|$)/i.test(req.path)) {
        return res.sendStatus(404);
    }
    return next();
});

app.use(express.static(projectRoot, { dotfiles: "ignore", index: "index.html" }));

function initialize() {
    if (!initializationPromise) {
        initializationPromise = ensureAvaliacaoTable().catch((erro) => {
            initializationPromise = null;
            throw erro;
        });
    }
    return initializationPromise;
}

async function iniciarServidor() {
    try {
        await initialize();
        console.log("Tabela de avaliacoes verificada.");
    } catch (erro) {
        console.error("Nao foi possivel preparar a tabela de avaliacoes:", erro.code || "erro nao identificado");
    }

    const servidor = app.listen(port, () => {
        console.log(`Servidor rodando em http://localhost:${port}`);
    });

    servidor.on("error", (erro) => {
        if (erro.code === "EADDRINUSE") {
            console.error(`A porta ${port} ja esta em uso. Se o Projeto Mabel ja estiver rodando, acesse http://localhost:${port}.`);
        } else {
            console.error("Falha ao iniciar o servidor:", erro.code || erro.message);
        }
        process.exitCode = 1;
    });
}

if (require.main === module) {
    iniciarServidor();
}

module.exports = { app, initialize };
