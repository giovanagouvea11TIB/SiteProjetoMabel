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
                const { response: resposta, result: dados } = await MabelApiResponse.fetchJson(fetch, endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(montarDados(formulario)),
                    cache: "no-store"
                });

                if (!resposta.ok || dados?.sucesso !== true) {
                    window.alert(MabelApiResponse.errorMessage(
                        resposta,
                        dados,
                        "Não foi possível enviar os dados."
                    ));
                    return;
                }

                window.alert(dados.mensagem);
                aoSucesso?.(formulario, dados);
            } catch (erro) {
                window.alert(erro.message || "Não foi possível enviar os dados. Tente novamente.");
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
