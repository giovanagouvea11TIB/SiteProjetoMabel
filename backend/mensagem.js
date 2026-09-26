function escaparHtml(valor) {
    return valor.replace(/[&<>"']/g, (caractere) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    })[caractere]);
}

function mensagemBoasVindas(nome) {
    const nomeSeguro = escaparHtml(nome);
    return {
        subject: "Cadastro realizado com sucesso! - Projeto Mabel",
        text: `Olá, ${nome}!\n\nSeu cadastro no Projeto Mabel foi realizado com sucesso.\n\nSua conta já está pronta para ser utilizada.\n\nAtenciosamente,\nEquipe Projeto Mabel`,
        html: `<div style="margin:0;background:#f7f7f7;padding:32px 16px;font-family:Arial,sans-serif;color:#303030"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden"><div style="background:#e86f22;padding:24px 32px;color:#ffffff"><h1 style="margin:0;font-size:24px">Projeto Mabel</h1></div><div style="padding:32px"><p style="font-size:18px">Olá, ${nomeSeguro}!</p><p>Seu cadastro no Projeto Mabel foi realizado com sucesso.</p><p>Agradecemos por fazer parte do Projeto Mabel. Sua conta já está pronta para ser utilizada.</p><p style="margin-top:28px">Atenciosamente,<br><strong>Equipe Projeto Mabel</strong></p></div></div></div>`
    };
}

function mensagemAgradecimentoAvaliacao(nome, mensagem) {
    const nomeSeguro = escaparHtml(nome);
    const mensagemSegura = escaparHtml(mensagem);
    return {
        subject: "Recebemos sua avaliação! - Projeto Mabel",
        text: `Olá, ${nome}!\n\nRecebemos sua avaliação e agradecemos pela contribuição. A equipe do Projeto Mabel recebeu sua mensagem:\n\n${mensagem}\n\nAtenciosamente,\nEquipe Projeto Mabel`,
        html: `<div style="margin:0;background:#f7f7f7;padding:32px 16px;font-family:Arial,sans-serif;color:#303030"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden"><div style="background:#e86f22;padding:24px 32px;color:#ffffff"><h1 style="margin:0;font-size:24px">Projeto Mabel</h1></div><div style="padding:32px"><p style="font-size:18px">Olá, ${nomeSeguro}!</p><p>Recebemos sua avaliação. Agradecemos por compartilhar sua opinião e contribuir com o Projeto Mabel.</p><p>A equipe do Projeto Mabel recebeu a seguinte mensagem:</p><blockquote style="margin:20px 0;padding:16px 20px;background:#fff4eb;border-left:4px solid #e86f22;white-space:pre-wrap;overflow-wrap:anywhere">${mensagemSegura}</blockquote><p>Atenciosamente,<br><strong>Equipe Projeto Mabel</strong></p></div></div></div>`
    };
}

module.exports = { mensagemBoasVindas, mensagemAgradecimentoAvaliacao };
