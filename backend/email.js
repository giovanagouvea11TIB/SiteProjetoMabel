const nodemailer = require("nodemailer");

let transporter;

function obterTransporter() {
    const usuario = process.env.EMAIL_USER;
    const senhaAplicativo = process.env.EMAIL_APP_PASSWORD;

    if (!usuario || !senhaAplicativo) {
        throw new Error("Configure EMAIL_USER e EMAIL_APP_PASSWORD no .env do servidor.");
    }

    transporter ??= nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: usuario,
            pass: senhaAplicativo.replace(/\s/g, "")
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000
    });

    return transporter;
}

async function enviarEmail({ to, subject, text, html, replyTo }) {
    if (!to || !subject || (!text && !html)) {
        throw new Error("Destinatário, assunto e conteúdo do e-mail são obrigatórios.");
    }

    const usuario = process.env.EMAIL_USER;
    const info = await obterTransporter().sendMail({
        from: `Projeto Mabel <${usuario}>`,
        to,
        subject,
        text,
        html,
        ...(replyTo ? { replyTo } : {})
    });

    if (Array.isArray(info.accepted) && info.accepted.length === 0) {
        const erro = new Error("O servidor Gmail não aceitou o destinatário do e-mail.");
        erro.code = "EMAIL_NOT_ACCEPTED";
        throw erro;
    }

    return info;
}

function registrarErroEmail(contexto, erro) {
    let mensagem = String(erro.message || "falha não identificada");
    for (const segredo of [process.env.EMAIL_APP_PASSWORD, process.env.DB_PASSWORD]) {
        if (segredo) mensagem = mensagem.replaceAll(segredo, "[REDACTED]");
    }
    console.error(`Erro ao enviar e-mail (${contexto}):`, erro.code || "EMAIL_ERROR", mensagem);
}

module.exports = { enviarEmail, registrarErroEmail };
