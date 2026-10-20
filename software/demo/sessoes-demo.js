// Sessões FICTÍCIAS para demonstração acadêmica do Projeto Mabel.
// Fonte única dos dados exibidos no Controle da Órtese e no Diário de Evolução.
// Este módulo não faz requisições, não grava dados e não envia comandos à ESP32.
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.MabelDemo = api;
}(typeof self !== "undefined" ? self : this, () => {
    const AVISO = "DADOS FICTÍCIOS — DEMONSTRAÇÃO";
    const MOTORES = ["M1", "M2", "M3", "M4", "M5"];
    const NIVEIS = 5;

    const PET = Object.freeze({ nome: "Mel", descricao: "Mel (fictício)" });

    // Intensidade em níveis de 1 a 5; no aplicativo cada nível corresponde a 20% (1–100%).
    // Durações usam apenas as opções oferecidas pelo Controle (30 s, 1, 2, 5 e 10 min).
    const SESSOES = Object.freeze([
        {
            id: "demo-01",
            numero: 1,
            inicio: "2026-10-15T14:30",
            nivel: 2,
            duracaoConfiguradaS: 300,
            duracaoSimuladaS: 300,
            estado: "concluida",
            motivo: "Tempo configurado concluído.",
            deteccoesSw420: 38,
            observacao: "Registro fictício: sessão simulada completa, sem interrupções."
        },
        {
            id: "demo-02",
            numero: 2,
            inicio: "2026-10-16T10:15",
            nivel: 3,
            duracaoConfiguradaS: 600,
            duracaoSimuladaS: 600,
            estado: "concluida",
            motivo: "Tempo configurado concluído.",
            deteccoesSw420: 61,
            observacao: "Registro fictício: sessão mais longa para demonstrar a contagem regressiva de 10 minutos."
        },
        {
            id: "demo-03",
            numero: 3,
            inicio: "2026-10-17T16:45",
            nivel: 1,
            duracaoConfiguradaS: 120,
            duracaoSimuladaS: 80,
            estado: "interrompida",
            motivo: "Interrompida pelo botão Desligar após 1 min 20 s.",
            deteccoesSw420: 9,
            observacao: "Registro fictício: exemplo de interrupção manual antes do fim do tempo configurado."
        },
        {
            id: "demo-04",
            numero: 4,
            inicio: "2026-10-18T09:00",
            nivel: 4,
            duracaoConfiguradaS: 300,
            duracaoSimuladaS: 0,
            estado: "cancelada",
            motivo: "Cancelada antes do início: a ESP32 estava offline e o comando não foi registrado.",
            deteccoesSw420: 0,
            observacao: "Registro fictício: sem sessão, não há leituras do sensor."
        },
        {
            id: "demo-05",
            numero: 5,
            inicio: "2026-10-19T15:20",
            nivel: 2,
            duracaoConfiguradaS: 120,
            duracaoSimuladaS: 120,
            estado: "concluida",
            motivo: "Tempo configurado concluído.",
            deteccoesSw420: 17,
            observacao: "Registro fictício: sessão curta com a mesma intensidade da sessão 01."
        }
    ].map((sessao) => Object.freeze(sessao)));

    const ESTADOS = Object.freeze({
        concluida: "Concluída",
        interrompida: "Interrompida",
        cancelada: "Cancelada"
    });

    const pad = (value) => String(value).padStart(2, "0");

    function nomeSessao(sessao) {
        return `Sessão demonstrativa ${pad(sessao.numero)}`;
    }

    function percentual(nivel) {
        return Math.round((nivel / NIVEIS) * 100);
    }

    function descreverNivel(nivel) {
        return `Nível ${nivel} de ${NIVEIS} (${percentual(nivel)}%)`;
    }

    function formatarData(inicio) {
        const [data] = inicio.split("T");
        const [ano, mes, dia] = data.split("-");
        return `${dia}/${mes}/${ano}`;
    }

    function formatarDataCurta(inicio) {
        return formatarData(inicio).slice(0, 5);
    }

    function formatarHorario(inicio) {
        const [hora, minuto] = inicio.split("T")[1].split(":");
        return `${hora}h${minuto}`;
    }

    function formatarDuracao(segundos) {
        if (segundos === 0) return "0 s";
        const minutos = Math.floor(segundos / 60);
        const resto = segundos % 60;
        if (minutos === 0) return `${resto} s`;
        return resto ? `${minutos} min ${resto} s` : `${minutos} min`;
    }

    function descreverMotores(sessao) {
        if (sessao.estado === "cancelada") return "Nenhum comando enviado aos cinco módulos.";
        return `Cinco módulos, comando sincronizado a ${percentual(sessao.nivel)}% (simulação).`;
    }

    // Estado simulado de cada motor ao fim da sessão (todos recebem a mesma intensidade).
    function motoresDaSessao(sessao) {
        const ativo = sessao.estado !== "cancelada";
        return MOTORES.map((nome) => ({
            nome,
            intensidade: ativo ? percentual(sessao.nivel) : 0,
            comando: ativo ? "sincronizado" : "sem comando"
        }));
    }

    function resumo(sessoes = SESSOES) {
        return {
            total: sessoes.length,
            concluidas: sessoes.filter((s) => s.estado === "concluida").length,
            interrompidas: sessoes.filter((s) => s.estado === "interrompida").length,
            canceladas: sessoes.filter((s) => s.estado === "cancelada").length,
            tempoSimuladoS: sessoes.reduce((total, s) => total + s.duracaoSimuladaS, 0),
            deteccoesSw420: sessoes.reduce((total, s) => total + s.deteccoesSw420, 0)
        };
    }

    return Object.freeze({
        AVISO,
        MOTORES,
        NIVEIS,
        PET,
        SESSOES,
        ESTADOS,
        nomeSessao,
        percentual,
        descreverNivel,
        formatarData,
        formatarDataCurta,
        formatarHorario,
        formatarDuracao,
        descreverMotores,
        motoresDaSessao,
        resumo
    });
}));
