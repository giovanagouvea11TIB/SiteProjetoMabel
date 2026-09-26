const express = require("express");
const { pool } = require("../db");
const { enviarEmail, registrarErroEmail } = require("../email");
const { mensagemAgradecimentoAvaliacao } = require("../mensagem");

const router = express.Router();

router.post("/", async (req, res) => {
    const nome = typeof req.body?.nome === "string" ? req.body.nome.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const mensagem = typeof req.body?.mensagem === "string" ? req.body.mensagem.trim() : "";

    if (!nome || nome.length > 120 || !email || email.length > 255 || !mensagem || mensagem.length > 5000) {
        return res.status(400).json({ sucesso: false, mensagem: "Preencha nome, e-mail e mensagem corretamente." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ sucesso: false, mensagem: "Informe um e-mail válido." });
    }

    try {
        await pool.execute(
            "INSERT INTO alunos_avaliacoes (nome, email, mensagem) VALUES (?, ?, ?)",
            [nome, email, mensagem]
        );

        let emailAdminEnviado = false;
        try {
            await enviarEmail({
                to: process.env.EMAIL_USER,
                replyTo: email,
                subject: "Nova avaliação recebida — Projeto Mabel",
                text: `Uma nova mensagem foi recebida pelo formulário de contato do Projeto Mabel.\n\nNome: ${nome}\nE-mail: ${email}\nMensagem:\n${mensagem}`
            });
            emailAdminEnviado = true;
        } catch (erroEmail) {
            registrarErroEmail("avaliação recebida", erroEmail);
        }

        let emailEnviado = false;
        try {
            await enviarEmail({
                to: email,
                ...mensagemAgradecimentoAvaliacao(nome, mensagem)
            });
            emailEnviado = true;
        } catch (erroEmail) {
            registrarErroEmail("confirmação de avaliação", erroEmail);
        }

        return res.status(201).json({
            sucesso: true,
            mensagem: emailEnviado
                ? "Avaliação registrada e confirmação enviada!"
                : "Avaliação registrada com sucesso, mas não foi possível enviar a confirmação por e-mail.",
            emailEnviado,
            emailAdminEnviado
        });
    } catch (erro) {
        console.error("Erro ao registrar avaliação:", erro.code || "erro não identificado");
        return res.status(500).json({ sucesso: false, mensagem: "Não foi possível registrar sua mensagem." });
    }
});

module.exports = router;
