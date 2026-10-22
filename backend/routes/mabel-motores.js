const express = require("express");
const { hasValidDeviceToken, parsePositiveBigInt, validateDeviceId } = require("./mabel");

const MIN_INTENSITY = 1;
const MAX_INTENSITY = 100;
const MIN_DURATION_S = 5;
const MAX_DURATION_S = 600;
// Um comando de ligar só pode começar dentro desta janela; depois disso ele expira sem acionar.
const START_WINDOW_MS = 30000;
// Sem consulta da ESP32 por este período, o dispositivo é considerado offline.
const OFFLINE_AFTER_MS = 15000;
const POLL_INTERVAL_MS = 3000;
// linked_at tem precisão de segundos; comandos e confirmações precisam ser posteriores ao segundo seguinte.
const ASSOCIATION_GRACE_MS = 1000;
const COMMAND_ID_PATTERN = /^[1-9]\d{0,18}$/;
const CONFIRMATION_RESULTS = new Set(["aplicado", "rejeitado", "interrompido"]);
const INTERRUPTION_REASONS = new Set(["duracao", "comunicacao", "reinicio", "recusado_servidor"]);
const MOTORS_OFF = Object.freeze({ ligado: false, intensidade: 0, duracao_restante_ms: 0 });
const SESSION_HISTORY_LIMIT = 50;
// concluida/interrompida foram confirmadas pela ESP32; sem_confirmacao é só inferida pela falta de contato.
const SESSION_ENDINGS = Object.freeze({
    concluida: "confirmado",
    interrompida: "confirmado",
    sem_confirmacao: "inferido"
});

const SQL = {
    now: "SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS agora_ms",
    ownedPet: "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
    ownedPetForUpdate: "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1 FOR UPDATE",
    associationByPet: `SELECT device_id, pet_id, UNIX_TIMESTAMP(linked_at) * 1000 AS linked_ms
         FROM mabel_pet_associations
         WHERE pet_id = ?
         LIMIT 1`,
    associationByDevice: `SELECT device_id, pet_id, UNIX_TIMESTAMP(linked_at) * 1000 AS linked_ms
         FROM mabel_pet_associations
         WHERE device_id = ?
         LIMIT 1`,
    latestCommand: `SELECT id, device_id, pet_id, ligado, intensidade, duracao_s, status, motivo,
                UNIX_TIMESTAMP(solicitado_em) * 1000 AS solicitado_ms,
                UNIX_TIMESTAMP(atualizado_em) * 1000 AS atualizado_ms
         FROM mabel_motor_commands
         WHERE device_id = ? AND pet_id = ? AND solicitado_em >= FROM_UNIXTIME(?)
         ORDER BY id DESC
         LIMIT 1`,
    latestCommandId: "SELECT MAX(id) AS id FROM mabel_motor_commands WHERE device_id = ?",
    commandById: `SELECT id, device_id, pet_id, usuario_id, ligado, intensidade, duracao_s, status, motivo,
                UNIX_TIMESTAMP(solicitado_em) * 1000 AS solicitado_ms,
                UNIX_TIMESTAMP(atualizado_em) * 1000 AS atualizado_ms
         FROM mabel_motor_commands
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
    insertCommand: `INSERT INTO mabel_motor_commands
            (device_id, pet_id, usuario_id, ligado, intensidade, duracao_s)
         VALUES (?, ?, ?, ?, ?, ?)`,
    supersedePending: `UPDATE mabel_motor_commands
         SET status = 'substituido', atualizado_em = CURRENT_TIMESTAMP(3)
         WHERE device_id = ? AND id < ? AND status = 'pendente'`,
    applyCommand: `UPDATE mabel_motor_commands
         SET status = 'aplicado', motivo = 'comando', atualizado_em = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'pendente'`,
    finishCommand: `UPDATE mabel_motor_commands
         SET status = ?, motivo = ?, atualizado_em = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status IN ('pendente', 'aplicado')`,
    heartbeat: `INSERT INTO mabel_motor_state (device_id)
         VALUES (?)
         ON DUPLICATE KEY UPDATE ultimo_contato = CURRENT_TIMESTAMP(3)`,
    upsertState: `INSERT INTO mabel_motor_state
            (device_id, command_id, ligado, intensidade, fisico, motivo, confirmado_em)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
            command_id = VALUES(command_id),
            ligado = VALUES(ligado),
            intensidade = VALUES(intensidade),
            fisico = VALUES(fisico),
            motivo = VALUES(motivo),
            confirmado_em = CURRENT_TIMESTAMP(3),
            ultimo_contato = CURRENT_TIMESTAMP(3)`,
    motorState: `SELECT device_id, command_id, ligado, intensidade, fisico, motivo,
                UNIX_TIMESTAMP(ultimo_contato) * 1000 AS ultimo_contato_ms,
                UNIX_TIMESTAMP(confirmado_em) * 1000 AS confirmado_ms
         FROM mabel_motor_state
         WHERE device_id = ?
         LIMIT 1`,
    sessionByCommand: `SELECT id
         FROM mabel_sessoes
         WHERE command_id = ?
         LIMIT 1
         FOR UPDATE`,
    // inicio_em e termino_em são DATETIME (sem fuso): sessões vinculadas a comandos os gravam em UTC,
    // com UTC_TIMESTAMP(), que trunca no segundo e nunca fica depois da confirmação.
    // Os cinco motores recebem a mesma intensidade; fisico = 0 indica confirmação em simulação.
    insertSession: `INSERT INTO mabel_sessoes
            (usuario_id, pet_id, device_id, command_id, tipo_sessao, estado, intensidade_geral,
             motor1, motor2, motor3, motor4, motor5, duracao_segundos, fisico, inicio_em)
         VALUES (?, ?, ?, ?, 'real', 'ativa', ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    // Desligamento ou nova intensidade confirmados: o término é o instante da própria confirmação.
    endPetSessionsNow: `UPDATE mabel_sessoes
         SET estado = 'interrompida', termino_em = UTC_TIMESTAMP()
         WHERE device_id = ? AND pet_id = ? AND estado = 'ativa'`,
    // Sem horário: a ESP32 confirma que parou, mas não quando (reinício, ou sessão já sem confirmação).
    endPetSessionsUntimed: `UPDATE mabel_sessoes
         SET estado = 'interrompida'
         WHERE device_id = ? AND pet_id = ? AND estado IN ('ativa', 'sem_confirmacao')`,
    endCommandSessionNow: `UPDATE mabel_sessoes
         SET estado = ?, termino_em = UTC_TIMESTAMP()
         WHERE command_id = ? AND estado = 'ativa'`,
    endCommandSessionUntimed: `UPDATE mabel_sessoes
         SET estado = ?
         WHERE command_id = ? AND estado IN ('ativa', 'sem_confirmacao')`,
    // Inferência por lacuna de comunicação: não há confirmação da ESP32, então nada além do estado muda.
    markSessionsUnconfirmed: `UPDATE mabel_sessoes
         SET estado = 'sem_confirmacao'
         WHERE device_id = ? AND pet_id = ? AND estado = 'ativa'`,
    // Sessões vinculadas a comandos: o DATETIME é UTC e a diferença até a época é aritmética pura,
    // independente do fuso da conexão. Sessões legadas (command_id NULL) mantêm a leitura no fuso
    // da conexão, como antes. NULL continua NULL. Busca um registro além do limite apenas para
    // indicar que há mais histórico.
    sessionHistory: `SELECT id, device_id, command_id, tipo_sessao, estado, intensidade_geral,
                motor1, motor2, motor3, motor4, motor5, duracao_segundos, fisico,
                CASE WHEN command_id IS NULL THEN UNIX_TIMESTAMP(inicio_em)
                     ELSE TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', inicio_em)
                END * 1000 AS inicio_ms,
                CASE WHEN command_id IS NULL THEN UNIX_TIMESTAMP(termino_em)
                     ELSE TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', termino_em)
                END * 1000 AS termino_ms,
                UNIX_TIMESTAMP(criado_em) * 1000 AS criado_ms
         FROM mabel_sessoes
         WHERE pet_id = ? AND usuario_id = ?
         ORDER BY criado_em DESC, id DESC
         LIMIT ${SESSION_HISTORY_LIMIT + 1}`
};

function hasExactKeys(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateMotorValues(motores) {
    if (!hasExactKeys(motores, ["ligado", "intensidade"])) {
        return "motores deve conter somente ligado e intensidade.";
    }
    if (typeof motores.ligado !== "boolean") return "motores.ligado deve ser booleano.";
    if (
        !Number.isSafeInteger(motores.intensidade)
        || motores.intensidade < 0
        || motores.intensidade > MAX_INTENSITY
    ) {
        return "motores.intensidade deve ser um inteiro de 0 a 100.";
    }
    if (motores.ligado && motores.intensidade < MIN_INTENSITY) {
        return "Com os motores ligados, a intensidade deve ser de 1 a 100.";
    }
    if (!motores.ligado && motores.intensidade !== 0) {
        return "Com os motores desligados, a intensidade deve ser 0.";
    }
    return null;
}

function validateMotorCommand(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { error: "Envie o comando dos motores em um objeto JSON." };
    }
    if (typeof body.ligado !== "boolean") return { error: "ligado deve ser booleano." };

    const keys = body.ligado ? ["pet_id", "ligado", "intensidade", "duracao_s"] : ["pet_id", "ligado"];
    if (!hasExactKeys(body, keys)) {
        return {
            error: body.ligado
                ? "Para ligar, informe somente pet_id, ligado, intensidade e duracao_s."
                : "Para desligar, informe somente pet_id e ligado."
        };
    }

    const petId = parsePositiveBigInt(body.pet_id);
    if (!petId) return { error: "Informe um pet_id válido." };
    if (!body.ligado) {
        return { command: { petId, ligado: false, intensidade: 0, duracaoS: 0 } };
    }
    if (
        !Number.isSafeInteger(body.intensidade)
        || body.intensidade < MIN_INTENSITY
        || body.intensidade > MAX_INTENSITY
    ) {
        return { error: "A intensidade deve ser um inteiro de 1 a 100." };
    }
    if (
        !Number.isSafeInteger(body.duracao_s)
        || body.duracao_s < MIN_DURATION_S
        || body.duracao_s > MAX_DURATION_S
    ) {
        return { error: "duracao_s deve ser um inteiro de 5 a 600 segundos." };
    }
    return {
        command: { petId, ligado: true, intensidade: body.intensidade, duracaoS: body.duracao_s }
    };
}

function validateConfirmation(body) {
    if (!hasExactKeys(body, ["device_id", "command_id", "resultado", "motores", "fisico", "motivo"])) {
        return { error: "Informe somente device_id, command_id, resultado, motores, fisico e motivo." };
    }
    const deviceIdError = validateDeviceId(body.device_id);
    if (deviceIdError) return { error: deviceIdError };
    if (
        body.command_id !== null
        && (typeof body.command_id !== "string"
            || !COMMAND_ID_PATTERN.test(body.command_id)
            || !parsePositiveBigInt(body.command_id))
    ) {
        return { error: "command_id deve ser null ou uma string numérica positiva." };
    }
    if (!CONFIRMATION_RESULTS.has(body.resultado)) {
        return { error: "resultado deve ser aplicado, rejeitado ou interrompido." };
    }
    const motorError = validateMotorValues(body.motores);
    if (motorError) return { error: motorError };
    if (typeof body.fisico !== "boolean") return { error: "fisico deve ser booleano." };

    if (body.resultado === "aplicado" && (body.command_id === null || body.motivo !== "comando")) {
        return { error: "Uma aplicação exige command_id e motivo comando." };
    }
    if (body.resultado === "rejeitado"
        && (body.command_id === null || body.motivo !== "invalido" || body.motores.ligado)) {
        return { error: "Uma rejeição exige command_id, motivo invalido e motores desligados." };
    }
    if (body.resultado === "interrompido"
        && (!INTERRUPTION_REASONS.has(body.motivo) || body.motores.ligado)) {
        return {
            error: "Uma interrupção exige motores desligados e motivo duracao, comunicacao, reinicio ou recusado_servidor."
        };
    }

    return {
        confirmation: {
            deviceId: body.device_id,
            commandId: body.command_id,
            resultado: body.resultado,
            motores: body.motores,
            fisico: body.fisico,
            motivo: body.motivo
        }
    };
}

function toIsoString(milliseconds) {
    if (milliseconds === null || milliseconds === undefined) return null;
    const value = Number(milliseconds);
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function describeCommand(row, agoraMs) {
    if (!row) return null;

    const ligado = Number(row.ligado) === 1;
    const idadeMs = Math.max(0, agoraMs - Number(row.solicitado_ms));
    let estado = row.status;
    if (estado === "pendente" && ligado && idadeMs > START_WINDOW_MS) estado = "expirado";
    const restanteMs = ligado ? Math.max(0, Number(row.duracao_s) * 1000 - idadeMs) : 0;
    const ativo = ligado && (estado === "pendente" || estado === "aplicado") && restanteMs > 0;
    if (estado === "aplicado" && ligado && restanteMs === 0) estado = "concluido";

    return {
        command_id: String(row.id),
        ligado,
        intensidade: Number(row.intensidade),
        duracao_s: Number(row.duracao_s),
        estado,
        motivo: row.motivo || null,
        ativo,
        duracao_restante_ms: ativo ? restanteMs : 0,
        solicitado_em: toIsoString(row.solicitado_ms),
        atualizado_em: toIsoString(row.atualizado_ms)
    };
}

// duracao_segundos é a duração solicitada no comando, não a realizada; dados ausentes ficam null.
function describeSession(row) {
    const nullableString = (value) => (value === null || value === undefined ? null : String(value));
    return {
        id: String(row.id),
        tipo_sessao: row.tipo_sessao,
        estado: row.estado,
        encerramento: SESSION_ENDINGS[row.estado] || null,
        device_id: row.device_id,
        command_id: nullableString(row.command_id),
        fisico: row.fisico === null || row.fisico === undefined ? null : Number(row.fisico) === 1,
        intensidade_geral: Number(row.intensidade_geral),
        motores: [row.motor1, row.motor2, row.motor3, row.motor4, row.motor5].map(Number),
        duracao_solicitada_s: Number(row.duracao_segundos),
        inicio_em: toIsoString(row.inicio_ms),
        termino_em: toIsoString(row.termino_ms),
        criado_em: toIsoString(row.criado_ms)
    };
}

function isOnline(state, agoraMs) {
    if (!state) return false;
    const lastContactMs = Number(state.ultimo_contato_ms);
    return Number.isFinite(lastContactMs) && agoraMs - lastContactMs <= OFFLINE_AFTER_MS;
}

function describeConfirmedState(state, association) {
    if (!state || state.confirmado_ms === null || state.confirmado_ms === undefined) return null;
    const confirmedMs = Number(state.confirmado_ms);
    if (!Number.isFinite(confirmedMs) || confirmedMs < association.linkedMs + ASSOCIATION_GRACE_MS) {
        return null;
    }
    return {
        command_id: state.command_id === null ? null : String(state.command_id),
        ligado: Number(state.ligado) === 1,
        intensidade: Number(state.intensidade),
        fisico: Number(state.fisico) === 1,
        motivo: state.motivo || null,
        confirmado_em: toIsoString(confirmedMs)
    };
}

function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

async function withTransaction(pool, operation) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function selectRows(executor, query, params) {
    const [rows] = await executor.execute(query, params);
    return rows;
}

async function readNow(executor) {
    const [row] = await selectRows(executor, SQL.now, []);
    return Number(row.agora_ms);
}

async function findAssociation(executor, query, value) {
    const [row] = await selectRows(executor, query, [value]);
    if (!row) return null;
    return { deviceId: row.device_id, petId: String(row.pet_id), linkedMs: Number(row.linked_ms) };
}

async function findLatestCommand(executor, association) {
    const [row] = await selectRows(executor, SQL.latestCommand, [
        association.deviceId,
        association.petId,
        (association.linkedMs + ASSOCIATION_GRACE_MS) / 1000
    ]);
    return row || null;
}

async function findMotorState(executor, deviceId) {
    const [row] = await selectRows(executor, SQL.motorState, [deviceId]);
    return row || null;
}

// Uma sessão só existe a partir da aplicação confirmada de um comando de ligar; confirmações
// repetidas do mesmo comando encontram a sessão já registrada e não alteram nada.
async function startSession(connection, row, fisico) {
    const [existing] = await selectRows(connection, SQL.sessionByCommand, [row.id]);
    if (existing) return;

    await endPetSessions(connection, row.device_id, row.pet_id);
    const intensidade = Number(row.intensidade);
    await connection.execute(SQL.insertSession, [
        row.usuario_id,
        row.pet_id,
        row.device_id,
        row.id,
        intensidade,
        intensidade,
        intensidade,
        intensidade,
        intensidade,
        intensidade,
        Number(row.duracao_s),
        fisico ? 1 : 0
    ]);
}

// Desligamento ou nova intensidade confirmados: a sessão ativa termina na própria confirmação;
// uma sessão já sem confirmação parou antes, em horário desconhecido.
async function endPetSessions(connection, deviceId, petId) {
    await connection.execute(SQL.endPetSessionsNow, [deviceId, petId]);
    await connection.execute(SQL.endPetSessionsUntimed, [deviceId, petId]);
}

// Duração esgotada é informada pela ESP32 no próprio instante do término; comunicação e
// reinício só são informados depois, então o horário real da parada fica desconhecido.
async function endCommandSession(connection, commandId, motivo) {
    if (motivo === "duracao") {
        await connection.execute(SQL.endCommandSessionNow, ["concluida", commandId]);
        await connection.execute(SQL.endCommandSessionUntimed, ["concluida", commandId]);
    } else if (motivo === "comunicacao" || motivo === "reinicio") {
        await connection.execute(SQL.endCommandSessionUntimed, ["interrompida", commandId]);
    }
}

// Sem contato por OFFLINE_AFTER_MS, a ESP32 já desligou por segurança (o firmware para após 10 s
// sem resposta de /config e não retoma o comando); a sessão passa a ser apenas inferida como encerrada.
async function markUnconfirmedSessions(executor, association, state, agoraMs) {
    if (!state || isOnline(state, agoraMs)) return;
    await executor.execute(SQL.markSessionsUnconfirmed, [association.deviceId, association.petId]);
}

const ERROR_RESPONSES = {
    MABEL_PET_NOT_FOUND: [404, "Pet não encontrado."],
    MABEL_NO_PET_ASSOCIATION: [409, "Associe um dispositivo Mabel a este pet antes de enviar comandos."],
    MABEL_DEVICE_OFFLINE: [409, "A ESP32 está offline; o comando de ligar não foi registrado. O desligamento continua disponível."],
    MABEL_NO_DEVICE_ASSOCIATION: [403, "O dispositivo não possui uma associação ativa."],
    MABEL_COMMAND_NOT_FOUND: [404, "Comando não encontrado para este dispositivo."],
    MABEL_COMMAND_STALE: [409, "O comando pertence a uma associação anterior do dispositivo."],
    MABEL_COMMAND_SUPERSEDED: [409, "O comando foi substituído por outro mais recente."],
    MABEL_COMMAND_NOT_ACTIVE: [409, "O comando não está mais válido para aplicação."],
    MABEL_STATE_MISMATCH: [409, "O estado informado difere do comando solicitado."]
};

function createMabelMotorRouter({
    deviceToken = process.env.MABEL_DEVICE_TOKEN,
    sessionMiddleware,
    pool
}) {
    const router = express.Router();

    function requireDevice(req, res) {
        if (typeof deviceToken !== "string" || deviceToken.length < 32) {
            res.status(503).json({
                sucesso: false,
                mensagem: "A autenticação do dispositivo não está configurada no servidor."
            });
            return false;
        }
        if (!hasValidDeviceToken(req, deviceToken)) {
            res.status(401).json({
                sucesso: false,
                mensagem: "Autenticação do dispositivo inválida."
            });
            return false;
        }
        return true;
    }

    function withWebSession(req, res, next, handler) {
        if (typeof sessionMiddleware !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "A autenticação web não está disponível."
            });
        }

        return sessionMiddleware(req, res, (sessionError) => {
            if (sessionError) return next(sessionError);

            const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
            if (!usuarioId) {
                return res.status(401).json({
                    sucesso: false,
                    mensagem: "Autenticação necessária."
                });
            }
            return Promise.resolve(handler(usuarioId)).catch(next);
        });
    }

    function requirePool(res) {
        if (!pool || typeof pool.getConnection !== "function" || typeof pool.execute !== "function") {
            res.status(503).json({
                sucesso: false,
                mensagem: "O controle dos motores Mabel não está disponível."
            });
            return false;
        }
        return true;
    }

    function handleError(res, error, next, extraBody = {}) {
        const known = ERROR_RESPONSES[error?.code];
        if (known) {
            return res.status(known[0]).json({ sucesso: false, mensagem: known[1], ...extraBody });
        }
        if (error?.code === "ER_NO_SUCH_TABLE") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "O controle dos motores ainda não está disponível. A estrutura do banco precisa ser preparada.",
                ...extraBody
            });
        }
        return next(error);
    }

    router.post("/motores", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        const { command, error } = validateMotorCommand(req.body);
        if (error) return res.status(400).json({ sucesso: false, mensagem: error });
        if (!requirePool(res)) return;

        try {
            const result = await withTransaction(pool, async (connection) => {
                const [pet] = await selectRows(connection, SQL.ownedPetForUpdate, [command.petId, usuarioId]);
                if (!pet) throw codedError("MABEL_PET_NOT_FOUND");
                const association = await findAssociation(connection, SQL.associationByPet, command.petId);
                if (!association) throw codedError("MABEL_NO_PET_ASSOCIATION");
                if (command.ligado) {
                    const agoraMs = await readNow(connection);
                    if (!isOnline(await findMotorState(connection, association.deviceId), agoraMs)) {
                        throw codedError("MABEL_DEVICE_OFFLINE");
                    }
                }

                const [insert] = await connection.execute(SQL.insertCommand, [
                    association.deviceId,
                    command.petId,
                    usuarioId,
                    command.ligado ? 1 : 0,
                    command.intensidade,
                    command.duracaoS
                ]);
                await connection.execute(SQL.supersedePending, [association.deviceId, insert.insertId]);
                const [row] = await selectRows(connection, SQL.commandById, [insert.insertId]);
                return {
                    deviceId: association.deviceId,
                    comando: describeCommand(row, await readNow(connection))
                };
            });

            res.set("Cache-Control", "private, no-store");
            return res.status(201).json({
                sucesso: true,
                device_id: result.deviceId,
                comando: result.comando
            });
        } catch (error) {
            return handleError(res, error, next);
        }
    }));

    router.get("/motores", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        const petId = parsePositiveBigInt(req.query.pet_id);
        if (!petId) return res.status(400).json({ sucesso: false, mensagem: "Informe um pet_id válido." });
        if (!requirePool(res)) return;

        try {
            const [pet] = await selectRows(pool, SQL.ownedPet, [petId, usuarioId]);
            if (!pet) throw codedError("MABEL_PET_NOT_FOUND");

            res.set("Cache-Control", "private, no-store");
            const association = await findAssociation(pool, SQL.associationByPet, petId);
            if (!association) {
                return res.json({
                    sucesso: true,
                    tem_associacao: false,
                    device_id: null,
                    online: false,
                    ultimo_contato: null,
                    offline_apos_ms: OFFLINE_AFTER_MS,
                    solicitado: null,
                    confirmado: null
                });
            }

            const agoraMs = await readNow(pool);
            const state = await findMotorState(pool, association.deviceId);
            await markUnconfirmedSessions(pool, association, state, agoraMs);
            return res.json({
                sucesso: true,
                tem_associacao: true,
                device_id: association.deviceId,
                online: isOnline(state, agoraMs),
                ultimo_contato: toIsoString(state?.ultimo_contato_ms),
                offline_apos_ms: OFFLINE_AFTER_MS,
                solicitado: describeCommand(await findLatestCommand(pool, association), agoraMs),
                confirmado: describeConfirmedState(state, association)
            });
        } catch (error) {
            return handleError(res, error, next);
        }
    }));

    router.get("/sessoes", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        const petId = parsePositiveBigInt(req.query.pet_id);
        if (!petId) return res.status(400).json({ sucesso: false, mensagem: "Informe um pet_id válido." });
        if (!requirePool(res)) return;

        try {
            const [pet] = await selectRows(pool, SQL.ownedPet, [petId, usuarioId]);
            if (!pet) throw codedError("MABEL_PET_NOT_FOUND");

            // Consulta pelo pet e pelo usuário, não pelo dispositivo associado agora.
            const rows = await selectRows(pool, SQL.sessionHistory, [petId, usuarioId]);
            res.set("Cache-Control", "private, no-store");
            return res.json({
                sucesso: true,
                pet_id: String(petId),
                limite: SESSION_HISTORY_LIMIT,
                mais_registros: rows.length > SESSION_HISTORY_LIMIT,
                sessoes: rows.slice(0, SESSION_HISTORY_LIMIT).map(describeSession)
            });
        } catch (error) {
            if (error?.code === "ER_NO_SUCH_TABLE" || error?.code === "ER_BAD_FIELD_ERROR") {
                return res.status(503).json({
                    sucesso: false,
                    mensagem: "O histórico de sessões ainda não está disponível. A estrutura do banco precisa ser preparada."
                });
            }
            return handleError(res, error, next);
        }
    }));

    router.get("/config", async (req, res, next) => {
        if (!requireDevice(req, res)) return;
        const deviceIdError = validateDeviceId(req.query.device_id);
        if (deviceIdError) return res.status(400).json({ sucesso: false, mensagem: deviceIdError });
        if (!requirePool(res)) return;
        const deviceId = req.query.device_id;

        try {
            const comando = await withTransaction(pool, async (connection) => {
                const association = await findAssociation(connection, SQL.associationByDevice, deviceId);
                if (!association) throw codedError("MABEL_NO_DEVICE_ASSOCIATION");
                const agoraMs = await readNow(connection);
                await markUnconfirmedSessions(
                    connection,
                    association,
                    await findMotorState(connection, deviceId),
                    agoraMs
                );
                await connection.execute(SQL.heartbeat, [deviceId]);

                const row = await findLatestCommand(connection, association);
                const described = describeCommand(row, agoraMs);
                if (described && row.status === "pendente" && described.estado === "expirado") {
                    await connection.execute(SQL.finishCommand, ["expirado", "janela_inicio", row.id]);
                }
                return described;
            });

            res.set("Cache-Control", "no-store");
            return res.json({
                sucesso: true,
                device_id: deviceId,
                command_id: comando ? comando.command_id : null,
                estado_comando: comando ? comando.estado : null,
                motores: comando?.ativo
                    ? {
                        ligado: true,
                        intensidade: comando.intensidade,
                        duracao_restante_ms: comando.duracao_restante_ms
                    }
                    : { ...MOTORS_OFF },
                intervalo_consulta_ms: POLL_INTERVAL_MS
            });
        } catch (error) {
            res.set("Cache-Control", "no-store");
            return handleError(res, error, next, { motores: { ...MOTORS_OFF } });
        }
    });

    router.post("/motores/confirmacao", async (req, res, next) => {
        if (!requireDevice(req, res)) return;
        const { confirmation, error } = validateConfirmation(req.body);
        if (error) return res.status(400).json({ sucesso: false, mensagem: error });
        if (!requirePool(res)) return;

        try {
            const estadoComando = await withTransaction(pool, async (connection) => {
                const association = await findAssociation(
                    connection,
                    SQL.associationByDevice,
                    confirmation.deviceId
                );
                if (!association) throw codedError("MABEL_NO_DEVICE_ASSOCIATION");
                await markUnconfirmedSessions(
                    connection,
                    association,
                    await findMotorState(connection, confirmation.deviceId),
                    await readNow(connection)
                );

                let commandState = null;
                if (confirmation.commandId) {
                    const [row] = await selectRows(connection, SQL.commandById, [confirmation.commandId]);
                    if (!row || row.device_id !== confirmation.deviceId) throw codedError("MABEL_COMMAND_NOT_FOUND");
                    if (
                        String(row.pet_id) !== association.petId
                        || Number(row.solicitado_ms) < association.linkedMs + ASSOCIATION_GRACE_MS
                    ) {
                        throw codedError("MABEL_COMMAND_STALE");
                    }

                    const comando = describeCommand(row, await readNow(connection));
                    if (confirmation.resultado === "aplicado") {
                        const [latest] = await selectRows(connection, SQL.latestCommandId, [confirmation.deviceId]);
                        if (String(latest?.id) !== String(row.id)) throw codedError("MABEL_COMMAND_SUPERSEDED");
                        if (
                            !["pendente", "aplicado"].includes(comando.estado)
                            || (comando.ligado && !comando.ativo)
                        ) {
                            throw codedError("MABEL_COMMAND_NOT_ACTIVE");
                        }
                        if (
                            comando.ligado !== confirmation.motores.ligado
                            || comando.intensidade !== confirmation.motores.intensidade
                        ) {
                            throw codedError("MABEL_STATE_MISMATCH");
                        }
                        await connection.execute(SQL.applyCommand, [row.id]);
                        if (comando.ligado) {
                            await startSession(connection, row, confirmation.fisico);
                        } else {
                            await endPetSessions(connection, row.device_id, row.pet_id);
                        }
                        commandState = "aplicado";
                    } else {
                        const [update] = await connection.execute(SQL.finishCommand, [
                            confirmation.resultado,
                            confirmation.motivo,
                            row.id
                        ]);
                        if (confirmation.resultado === "interrompido") {
                            await endCommandSession(connection, row.id, confirmation.motivo);
                        }
                        commandState = update.affectedRows === 1 ? confirmation.resultado : comando.estado;
                    }
                } else if (confirmation.motivo === "reinicio") {
                    await connection.execute(SQL.endPetSessionsUntimed, [confirmation.deviceId, association.petId]);
                }

                await connection.execute(SQL.upsertState, [
                    confirmation.deviceId,
                    confirmation.commandId,
                    confirmation.motores.ligado ? 1 : 0,
                    confirmation.motores.intensidade,
                    confirmation.fisico ? 1 : 0,
                    confirmation.motivo
                ]);
                return commandState;
            });

            res.set("Cache-Control", "no-store");
            return res.json({
                sucesso: true,
                command_id: confirmation.commandId,
                resultado: confirmation.resultado,
                estado_comando: estadoComando
            });
        } catch (error) {
            return handleError(res, error, next);
        }
    });

    return router;
}

module.exports = {
    createMabelMotorRouter,
    describeCommand,
    validateConfirmation,
    validateMotorCommand,
    START_WINDOW_MS,
    OFFLINE_AFTER_MS,
    POLL_INTERVAL_MS
};
