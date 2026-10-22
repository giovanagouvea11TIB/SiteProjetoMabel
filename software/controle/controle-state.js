(function exposeControleState(root, factory) {
    const controleState = factory();
    if (typeof module === "object" && module.exports) module.exports = controleState;
    if (root) root.MabelControleState = controleState;
}(typeof globalThis === "object" ? globalThis : this, () => {
    const DURATION_OPTIONS_S = [30, 60, 120, 300, 600];
    const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
    const REASON_LABELS = {
        comando: "comando do aplicativo",
        duracao: "duração concluída",
        comunicacao: "perda de comunicação",
        reinicio: "reinício da ESP32",
        recusado_servidor: "recusado pelo servidor",
        invalido: "comando inválido",
        janela_inicio: "a ESP32 não respondeu a tempo"
    };
    const STATE_LABELS = {
        pendente: "aguardando a ESP32",
        aplicado: "aplicado pela ESP32",
        concluido: "duração concluída",
        expirado: "expirou sem ser aplicado",
        rejeitado: "recusado pela ESP32",
        interrompido: "interrompido",
        substituido: "substituído por um comando mais recente"
    };

    // Histórico de sessões reais (GET /api/mabel/sessoes), compartilhado por Controle e Diário.
    const SESSION_STATES = {
        ativa: { label: "Ativa", tone: "ativa" },
        concluida: { label: "Concluída", tone: "concluida" },
        interrompida: { label: "Interrompida", tone: "interrompida" },
        sem_confirmacao: { label: "Sem confirmação de término", tone: "sem-confirmacao" }
    };
    const SESSION_ENDINGS = new Set(["confirmado", "inferido"]);
    const DEMO_HOSTS = new Set(["127.0.0.1", "localhost"]);

    function reasonLabel(motivo) {
        return REASON_LABELS[motivo] || motivo || "";
    }

    function formatDuration(seconds) {
        if (seconds < 60) return `${seconds} s`;
        const minutes = seconds / 60;
        return Number.isInteger(minutes) ? `${minutes} min` : `${Math.floor(minutes)} min ${seconds % 60} s`;
    }

    function formatCountdown(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
        const seconds = String(totalSeconds % 60).padStart(2, "0");
        return `${minutes}:${seconds}`;
    }

    function formatTime(isoString) {
        const date = new Date(isoString);
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("pt-BR");
    }

    function validateTurnOn(intensidade, duracaoS) {
        if (!Number.isInteger(intensidade) || intensidade < 1 || intensidade > 100) {
            return "Escolha uma intensidade de 1% a 100% para ligar. Use Desligar para 0%.";
        }
        if (!DURATION_OPTIONS_S.includes(duracaoS)) return "Escolha uma das durações disponíveis.";
        return null;
    }

    function validateDeviceId(deviceId) {
        return DEVICE_ID_PATTERN.test(deviceId)
            ? null
            : "Informe o identificador configurado na ESP32 (até 64 letras, números, ponto, hífen, dois-pontos ou sublinhado).";
    }

    function buildTurnOnPayload(petId, intensidade, duracaoS) {
        return { pet_id: petId, ligado: true, intensidade, duracao_s: duracaoS };
    }

    function buildTurnOffPayload(petId) {
        return { pet_id: petId, ligado: false };
    }

    function describeConnection(status) {
        if (!status || !status.tem_associacao) {
            return { online: false, label: "Sem dispositivo associado" };
        }
        return status.online
            ? { online: true, label: "ESP32 online" }
            : { online: false, label: "ESP32 offline" };
    }

    function describeRequested(solicitado) {
        if (!solicitado) return "Nenhum comando enviado para este dispositivo.";
        const action = solicitado.ligado
            ? `Ligar a ${solicitado.intensidade}% por ${formatDuration(solicitado.duracao_s)}`
            : "Desligar";
        let state = STATE_LABELS[solicitado.estado] || solicitado.estado;
        if (solicitado.estado === "interrompido" && solicitado.motivo) {
            state = `interrompido (${reasonLabel(solicitado.motivo)})`;
        }
        const time = formatTime(solicitado.solicitado_em);
        return `${action} — ${state}${time ? ` · enviado às ${time}` : ""}`;
    }

    function describeConfirmed(confirmado) {
        if (!confirmado) return "A ESP32 ainda não confirmou nenhum estado nesta associação.";
        const reason = confirmado.motivo ? ` · ${reasonLabel(confirmado.motivo)}` : "";
        const time = formatTime(confirmado.confirmado_em);
        const suffix = `${reason}${time ? ` · às ${time}` : ""}`;
        if (!confirmado.fisico) {
            // Em simulação nenhum motor físico foi acionado; o texto não pode sugerir o contrário.
            const simulated = confirmado.ligado
                ? `Simulação: os motores ligariam a ${confirmado.intensidade}%`
                : "Simulação: motores desligados";
            return `${simulated} (acionamento físico bloqueado na placa)${suffix}`;
        }
        const motors = confirmado.ligado ? `Motores ligados a ${confirmado.intensidade}%` : "Motores desligados";
        return `${motors} (acionamento físico)${suffix}`;
    }

    function commandProblem(solicitado) {
        if (!solicitado) return null;
        if (solicitado.estado === "rejeitado") return "A ESP32 recusou o último comando por considerá-lo inválido.";
        if (solicitado.estado === "expirado") {
            return "O último comando de ligar expirou: a ESP32 não o confirmou dentro de 30 segundos.";
        }
        if (solicitado.estado === "interrompido" && solicitado.motivo !== "duracao") {
            return `Os motores foram desligados pela ESP32: ${reasonLabel(solicitado.motivo)}.`;
        }
        return null;
    }

    function formatDateTime(isoString) {
        if (typeof isoString !== "string") return null;
        const date = new Date(isoString);
        return Number.isNaN(date.getTime())
            ? null
            : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    }

    function isNullableString(value) {
        return value === null || typeof value === "string";
    }

    function isValidSession(session) {
        return Boolean(session)
            && typeof session.id === "string"
            && typeof session.estado === "string"
            && typeof session.device_id === "string"
            && Number.isFinite(session.intensidade_geral)
            && Number.isFinite(session.duracao_solicitada_s)
            && (session.fisico === null || typeof session.fisico === "boolean")
            && (session.encerramento === null || SESSION_ENDINGS.has(session.encerramento))
            && [session.command_id, session.inicio_em, session.termino_em, session.criado_em].every(isNullableString);
    }

    // Retorna null quando a resposta não é do pet consultado ou não segue o formato esperado.
    function parseSessionHistory(result, petId) {
        if (
            !result
            || result.pet_id !== String(petId)
            || typeof result.mais_registros !== "boolean"
            || !Array.isArray(result.sessoes)
            || !result.sessoes.every(isValidSession)
        ) {
            return null;
        }
        return { sessoes: result.sessoes, maisRegistros: result.mais_registros };
    }

    function describeSessionCount(count, maisRegistros) {
        if (count === 0) return "Nenhuma sessão real registrada para este pet.";
        if (maisRegistros) {
            return `Exibindo as ${count} sessões reais mais recentes. Há registros anteriores que não foram carregados.`;
        }
        return count === 1 ? "1 sessão real registrada." : `${count} sessões reais registradas.`;
    }

    function describeSessionMode(fisico) {
        if (fisico === true) return { label: "Acionamento físico (declarado pela ESP32)", tone: "fisico" };
        if (fisico === false) return { label: "Simulação: nenhum motor foi acionado", tone: "simulacao" };
        return { label: "Modo não informado", tone: "desconhecido" };
    }

    function describeSessionEnding(session) {
        if (session.encerramento === "confirmado") return "Confirmado pela ESP32";
        if (session.encerramento === "inferido") {
            return "Inferido pela perda de comunicação; a ESP32 não confirmou";
        }
        return session.estado === "ativa" ? "Aguardando a confirmação de término" : "Não informado";
    }

    // Textos prontos para exibição; a duração é sempre a solicitada, nunca a realizada.
    function describeSession(session) {
        const inicio = formatDateTime(session.inicio_em);
        const criado = formatDateTime(session.criado_em);
        const termino = formatDateTime(session.termino_em);
        return {
            quando: inicio || (criado ? `Registrada em ${criado}` : "Data não registrada"),
            estado: SESSION_STATES[session.estado]
                || { label: `Estado não reconhecido (${session.estado})`, tone: "desconhecido" },
            modo: describeSessionMode(session.fisico),
            encerramento: describeSessionEnding(session),
            termino: termino || (session.estado === "ativa" ? "Ainda não informado" : "Horário não registrado"),
            intensidade: `${session.intensidade_geral}% nos cinco motores`,
            duracao: `${formatDuration(session.duracao_solicitada_s)} (solicitada)`,
            dispositivo: `ESP32 · ${session.device_id}`
        };
    }

    // A API simulada (tools/demo-api) marca as respostas com demonstracao: true. A faixa só aparece
    // com essa marca E com a página servida pelo Live Server local; a produção nunca atende os dois.
    function isDemoEnvironment(result, location) {
        return result?.demonstracao === true
            && location?.port === "5500"
            && DEMO_HOSTS.has(location?.hostname);
    }

    function summarizeSessions(sessoes) {
        return {
            total: sessoes.length,
            simulacao: sessoes.filter((session) => session.fisico === false).length,
            fisico: sessoes.filter((session) => session.fisico === true).length,
            inferidas: sessoes.filter((session) => session.encerramento === "inferido").length
        };
    }

    return {
        DURATION_OPTIONS_S,
        formatDateTime,
        parseSessionHistory,
        describeSessionCount,
        describeSessionMode,
        describeSession,
        summarizeSessions,
        isDemoEnvironment,
        formatDuration,
        formatCountdown,
        validateTurnOn,
        validateDeviceId,
        buildTurnOnPayload,
        buildTurnOffPayload,
        describeConnection,
        describeRequested,
        describeConfirmed,
        commandProblem
    };
}));
