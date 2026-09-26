document.addEventListener("DOMContentLoaded", () => {
    const apiUrl = (path) => window.location.port === "5500"
        ? `http://${window.location.hostname}:3000${path}`
        : path;

    async function enviarFormulario(formulario, endpoint, montarDados, aoSucesso) {
        if (formulario.dataset.apiBound === "true") return;
        formulario.dataset.apiBound = "true";

        formulario.addEventListener("submit", async (evento) => {
            evento.preventDefault();

            if (!formulario.reportValidity()) return;

            const botao = formulario.querySelector('button[type="submit"]');
            if (botao) botao.disabled = true;

            try {
                const resposta = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(montarDados(formulario))
                });
                const dados = await resposta.json();

                if (!resposta.ok || !dados.sucesso) {
                    window.alert(dados.mensagem || "Não foi possível enviar os dados.");
                    return;
                }

                window.alert(dados.mensagem);
                aoSucesso?.(formulario, dados);
            } catch (erro) {
                window.alert("Não foi possível conectar ao servidor. Tente novamente.");
            } finally {
                if (botao) botao.disabled = false;
            }
        });
    }

    const contato = document.querySelector(".contact form");
    if (contato) {
        enviarFormulario(
            contato,
            apiUrl("/api/avaliacao"),
            (formulario) => Object.fromEntries(new FormData(formulario).entries()),
            (formulario) => formulario.reset()
        );
    }
});
