const express = require("express");
const bcrypt = require("bcryptjs");
const { pool, getUsersTableName } = require("../db");
const { enviarEmail, registrarErroEmail } = require("../email");
const { mensagemBoasVindas } = require("../mensagem");

const router = express.Router();

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
        const [usuarios] = await pool.execute(
            `SELECT id FROM \`${tabelaUsuarios}\` WHERE email = ? LIMIT 1`,
            [email]
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

        console.error("Erro interno no cadastro:", erro.code || "erro não identificado");
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno ao realizar o cadastro." });
    }
});

router.post("/login", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";

    if (!email || !senha || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ sucesso: false, mensagem: "Informe um e-mail e uma senha válidos." });
    }

    try {
        const tabelaUsuarios = await getUsersTableName();
        const [usuarios] = await pool.execute(
            `SELECT id, nome, email, senha_hash FROM \`${tabelaUsuarios}\` WHERE email = ? LIMIT 1`,
            [email]
        );

        if (usuarios.length === 0 || !(await bcrypt.compare(senha, usuarios[0].senha_hash))) {
            return res.status(401).json({ sucesso: false, mensagem: "E-mail ou senha incorretos." });
        }

        const { id, nome, email: emailUsuario } = usuarios[0];
        return res.json({
            sucesso: true,
            mensagem: "Login realizado com sucesso!",
            usuario: { id, nome, email: emailUsuario }
        });
    } catch (erro) {
        console.error("Erro interno no login:", erro.code || "erro não identificado");
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno ao realizar o login." });
    }
});

module.exports = router;
