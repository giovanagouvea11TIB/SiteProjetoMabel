const express = require("express");
const bcrypt = require("bcryptjs");
const { pool, executeReadWithRetry, getUsersTableName } = require("../db");
const { sendDatabaseError } = require("../database-errors");
const { enviarEmail, registrarErroEmail } = require("../email");
const { mensagemBoasVindas } = require("../mensagem");
const avatarRouter = require("./avatar");

const router = express.Router();
router.use("/avatar", avatarRouter);

router.post("/cadastro", async (req, res) => {
    const nome = typeof req.body?.nome === "string" ? req.body.nome.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";

    if (!nome || nome.length > 120 || !email || email.length > 255 || !senha || Buffer.byteLength(senha, "utf8") > 72) {
        return res.status(400).json({ sucesso: false, mensagem: "Verifique os dados informados e tente novamente." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ sucesso: false, mensagem: "Informe um e-mail válido." });
    }

    try {
        const tabelaUsuarios = await getUsersTableName();
        const [usuarios] = await executeReadWithRetry(
            `SELECT id FROM \`${tabelaUsuarios}\` WHERE email = ? LIMIT 1`,
            [email],
            "verificar e-mail de cadastro"
        );

        if (usuarios.length > 0) {
            return res.status(409).json({ sucesso: false, mensagem: "Este e-mail já está cadastrado." });
        }

        const senhaHash = await bcrypt.hash(senha, 12);
        await pool.execute(
            `INSERT INTO \`${tabelaUsuarios}\` (nome, email, senha_hash) VALUES (?, ?, ?)`,
            [nome, email, senhaHash]
        );

        let emailEnviado = false;
        try {
            await enviarEmail({ to: email, ...mensagemBoasVindas(nome) });
            emailEnviado = true;
        } catch (erroEmail) {
            registrarErroEmail("confirmação de cadastro", erroEmail);
        }

        return res.status(201).json({
            sucesso: true,
            mensagem: emailEnviado
                ? "Cadastro realizado com sucesso!"
                : "Cadastro realizado com sucesso, mas não foi possível enviar o e-mail de confirmação.",
            emailEnviado
        });
    } catch (erro) {
        if (erro.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ sucesso: false, mensagem: "Este e-mail já está cadastrado." });
        }

        return sendDatabaseError(
            res,
            erro,
            "realizar cadastro",
            "Erro interno ao realizar o cadastro."
        );
    }
});

router.post("/login", async (req, res) => {
    const email = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    const senha = typeof req.body?.senha === "string"
        ? req.body.senha
        : "";

    if (
        !email ||
        !senha ||
        email.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Informe um e-mail e uma senha válidos."
        });
    }

    try {
        const tabelaUsuarios = await getUsersTableName();

        const [usuarios] = await executeReadWithRetry(
            `SELECT id, nome, email, senha_hash
             FROM \`${tabelaUsuarios}\`
             WHERE email = ?
             LIMIT 1`,
            [email],
            "consultar credenciais de login"
        );

        if (
            usuarios.length === 0 ||
            !(await bcrypt.compare(senha, usuarios[0].senha_hash))
        ) {
            return res.status(401).json({
                sucesso: false,
                mensagem: "E-mail ou senha incorretos."
            });
        }

        const { id, nome, email: emailUsuario } = usuarios[0];

        if (!req.session) {
            throw new Error("Middleware de sessão não disponível.");
        }

        req.session.regenerate((erroRegeneracao) => {
            if (erroRegeneracao) {
                console.error("Falha ao regenerar sessão:", erroRegeneracao.code || "erro não identificado");
                const indisponivel = erroRegeneracao.code === "ECONNRESET"
                    || erroRegeneracao.code === "PROTOCOL_CONNECTION_LOST";
                return res.status(indisponivel ? 503 : 500).json({
                    sucesso: false,
                    mensagem: indisponivel
                        ? "O banco de dados está temporariamente indisponível. Tente novamente."
                        : "Não foi possível iniciar a sessão."
                });
            }

            req.session.usuario = {
                id: String(id),
                nome,
                email: emailUsuario
            };

            req.session.save((erroSalvamento) => {
                if (erroSalvamento) {
                    console.error("Falha ao salvar sessão:", erroSalvamento.code || "erro não identificado");
                    const indisponivel = erroSalvamento.code === "ECONNRESET"
                        || erroSalvamento.code === "PROTOCOL_CONNECTION_LOST";
                    return res.status(indisponivel ? 503 : 500).json({
                        sucesso: false,
                        mensagem: indisponivel
                            ? "O banco de dados está temporariamente indisponível. Tente novamente."
                            : "Não foi possível salvar a sessão."
                    });
                }

                return res.json({
                    sucesso: true,
                    mensagem: "Login realizado com sucesso!",
                    usuario: {
                        id: String(id),
                        nome,
                        email: emailUsuario
                    }
                });
            });
        });
    } catch (erro) {
        return sendDatabaseError(
            res,
            erro,
            "realizar login",
            "Erro interno ao realizar o login."
        );
    }
});

router.post("/logout", (req, res) => {
    if (!req.session) {
        res.clearCookie("mabel.sid", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
            sameSite: "lax",
            path: "/"
        });

        return res.json({
            sucesso: true,
            mensagem: "Sessão encerrada."
        });
    }

    req.session.destroy((erro) => {
        if (erro) {
            console.error("Falha ao encerrar sessão:", erro.code || "erro não identificado");

            const indisponivel = erro.code === "ECONNRESET"
                || erro.code === "PROTOCOL_CONNECTION_LOST";
            return res.status(indisponivel ? 503 : 500).json({
                sucesso: false,
                mensagem: indisponivel
                    ? "O banco de dados está temporariamente indisponível. Tente novamente."
                    : "Não foi possível encerrar a sessão."
            });
        }

        res.clearCookie("mabel.sid", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
            sameSite: "lax",
            path: "/"
        });

        return res.json({
            sucesso: true,
            mensagem: "Logout realizado com sucesso."
        });
    });
});

module.exports = router;
