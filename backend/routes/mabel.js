const crypto = require("node:crypto");
const express = require("express");

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const EXPECTED_FIELDS = [
    "device_id",
    "sensor_detectou",
    "contador_deteccoes",
    "uptime_ms"
];

function hasValidDeviceToken(req, configuredToken) {
    if (typeof configuredToken !== "string" || configuredToken.length < 32) return false;

    const authorization = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) return false;

    const received = Buffer.from(match[1], "utf8");
    const expected = Buffer.from(configuredToken, "utf8");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function validateDeviceId(value) {
    if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) {
        return "device_id deve conter de 1 a 64 caracteres alfanuméricos, ponto, hífen, dois-pontos ou sublinhado.";
    }
    return null;
}

function validateTelemetry(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "Envie um objeto JSON com os dados do dispositivo.";
    }

    const fields = Object.keys(body).sort();
    if (
        fields.length !== EXPECTED_FIELDS.length
        || fields.some((field, index) => field !== [...EXPECTED_FIELDS].sort()[index])
    ) {
        return "Informe somente device_id, sensor_detectou, contador_deteccoes e uptime_ms.";
    }
    const deviceIdError = validateDeviceId(body.device_id);
    if (deviceIdError) return deviceIdError;
    if (typeof body.sensor_detectou !== "boolean") {
        return "sensor_detectou deve ser booleano.";
    }
    if (!Number.isSafeInteger(body.contador_deteccoes) || body.contador_deteccoes < 0) {
        return "contador_deteccoes deve ser um inteiro não negativo seguro.";
    }
    if (!Number.isSafeInteger(body.uptime_ms) || body.uptime_ms < 0) {
        return "uptime_ms deve ser um inteiro não negativo seguro.";
    }
    return null;
}

function parsePositiveBigInt(value) {
    if (
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
        || (typeof value === "number" && !Number.isSafeInteger(value))
    ) {
        return null;
    }

    const text = String(value);
    if (!/^[1-9]\d*$/.test(text)) return null;

    try {
        const parsed = BigInt(text);
        return parsed <= MAX_SIGNED_BIGINT ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function createMabelRouter({
    deviceToken = process.env.MABEL_DEVICE_TOKEN,
    sessionMiddleware,
    executeReadWithRetry,
    executeWrite
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

    function readPetId(value, res) {
        const petId = parsePositiveBigInt(value);
        if (!petId) {
            res.status(400).json({
                sucesso: false,
                mensagem: "Informe um pet_id válido."
            });
            return null;
        }
        return petId;
    }

    async function findOwnedPet(petId, usuarioId) {
        const [pets] = await executeReadWithRetry(
            "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
            [petId, usuarioId],
            "confirmar propriedade do pet para Mabel"
        );
        return pets.length > 0;
    }

    async function findPetAssociation(petId) {
        const [associations] = await executeReadWithRetry(
            `SELECT device_id
             FROM mabel_pet_associations
             WHERE pet_id = ?
             LIMIT 1`,
            [petId],
            "consultar associação Mabel do pet"
        );
        return associations[0] || null;
    }

    async function findLatestDeviceStatus(deviceId) {
        const [statuses] = await executeReadWithRetry(
            `SELECT device_id, sensor_detectou, contador_deteccoes, uptime_ms,
                    UNIX_TIMESTAMP(ultimo_contato) * 1000 AS ultimo_contato_ms
             FROM mabel_device_status
             WHERE device_id = ?
             LIMIT 1`,
            [deviceId],
            "consultar a última telemetria Mabel"
        );
        return statuses[0] || null;
    }

    async function findCurrentPetStatus(petId, deviceId) {
        const [statuses] = await executeReadWithRetry(
            `SELECT s.device_id, s.sensor_detectou, s.contador_deteccoes, s.uptime_ms,
                    UNIX_TIMESTAMP(s.ultimo_contato) * 1000 AS ultimo_contato_ms
             FROM mabel_pet_associations a
             INNER JOIN mabel_device_status s
                ON s.device_id = a.device_id
             WHERE a.pet_id = ?
               AND a.device_id = ?
               AND s.ultimo_contato >= DATE_ADD(a.linked_at, INTERVAL 1 SECOND)
             LIMIT 1`,
            [petId, deviceId],
            "consultar telemetria do dispositivo associado ao pet"
        );
        return statuses[0] || null;
    }

    function serializeStatus(row, expectedDeviceId) {
        if (!row || row.device_id !== expectedDeviceId) return null;

        const sensorDetected = Number(row.sensor_detectou);
        const detectionCount = Number(row.contador_deteccoes);
        const uptimeMs = Number(row.uptime_ms);
        const receivedAtMs = Number(row.ultimo_contato_ms);
        if (
            (sensorDetected !== 0 && sensorDetected !== 1)
            || !Number.isSafeInteger(detectionCount)
            || detectionCount < 0
            || !Number.isSafeInteger(uptimeMs)
            || uptimeMs < 0
            || !Number.isFinite(receivedAtMs)
            || receivedAtMs <= 0
        ) {
            return null;
        }

        return {
            device_id: row.device_id,
            sensor_detectou: sensorDetected === 1,
            contador_deteccoes: detectionCount,
            uptime_ms: uptimeMs,
            ultimo_contato: new Date(receivedAtMs).toISOString()
        };
    }

    function sendAssociationConflict(res) {
        return res.status(409).json({
            sucesso: false,
            mensagem: "Este dispositivo ou pet já possui uma associação ativa."
        });
    }

    function handleAssociationError(res, error, next) {
        if (error?.code === "ER_NO_SUCH_TABLE") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "As associações Mabel ainda não estão disponíveis. A estrutura do banco precisa ser preparada."
            });
        }
        return next(error);
    }

    function handleTelemetryError(res, error, next) {
        if (error?.code === "ER_NO_SUCH_TABLE") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "A persistência da telemetria Mabel ainda não está disponível. A estrutura do banco precisa ser preparada."
            });
        }
        return next(error);
    }

    router.post("/dados", async (req, res, next) => {
        if (!requireDevice(req, res)) return;

        const validationError = validateTelemetry(req.body);
        if (validationError) {
            return res.status(400).json({ sucesso: false, mensagem: validationError });
        }
        if (typeof executeWrite !== "function" || typeof executeReadWithRetry !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "A persistência da telemetria Mabel não está disponível."
            });
        }

        try {
            await executeWrite(
                `INSERT INTO mabel_device_status
                    (device_id, sensor_detectou, contador_deteccoes, uptime_ms, ultimo_contato)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))
                 ON DUPLICATE KEY UPDATE
                    sensor_detectou = VALUES(sensor_detectou),
                    contador_deteccoes = VALUES(contador_deteccoes),
                    uptime_ms = VALUES(uptime_ms),
                    ultimo_contato = CURRENT_TIMESTAMP(3)`,
                [
                    req.body.device_id,
                    req.body.sensor_detectou ? 1 : 0,
                    req.body.contador_deteccoes,
                    req.body.uptime_ms
                ]
            );

            const status = serializeStatus(
                await findLatestDeviceStatus(req.body.device_id),
                req.body.device_id
            );
            if (!status) {
                return res.status(503).json({
                    sucesso: false,
                    mensagem: "A gravação da telemetria não pôde ser confirmada."
                });
            }

            res.set("Cache-Control", "no-store");
            return res.status(202).json({
                sucesso: true,
                mensagem: "Leitura recebida e persistida.",
                persistida: true,
                device_id: status.device_id,
                ultimo_contato: status.ultimo_contato
            });
        } catch (error) {
            return handleTelemetryError(res, error, next);
        }
    });

    router.post("/associacoes", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Envie pet_id e device_id em um objeto JSON."
            });
        }
        const fields = Object.keys(req.body).sort();
        if (fields.length !== 2 || fields[0] !== "device_id" || fields[1] !== "pet_id") {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Informe somente pet_id e device_id."
            });
        }

        const petId = parsePositiveBigInt(req.body.pet_id);
        if (!petId) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Informe um pet_id válido."
            });
        }
        const deviceIdError = validateDeviceId(req.body.device_id);
        if (deviceIdError) {
            return res.status(400).json({ sucesso: false, mensagem: deviceIdError });
        }
        if (typeof executeReadWithRetry !== "function" || typeof executeWrite !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "O gerenciamento de associações Mabel não está disponível."
            });
        }

        try {
            if (!(await findOwnedPet(petId, usuarioId))) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Pet não encontrado."
                });
            }
            await executeWrite(
                "INSERT INTO mabel_pet_associations (device_id, pet_id) VALUES (?, ?)",
                [req.body.device_id, petId]
            );
            res.set("Cache-Control", "no-store");
            return res.status(201).json({
                sucesso: true,
                associacao: {
                    device_id: req.body.device_id,
                    pet_id: petId
                }
            });
        } catch (error) {
            if (error?.code === "ER_DUP_ENTRY") return sendAssociationConflict(res);
            return handleAssociationError(res, error, next);
        }
    }));

    router.get("/associacoes", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        const petId = readPetId(req.query.pet_id, res);
        if (!petId) return;
        if (typeof executeReadWithRetry !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "A consulta de associações Mabel não está disponível."
            });
        }

        try {
            if (!(await findOwnedPet(petId, usuarioId))) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Pet não encontrado."
                });
            }
            const association = await findPetAssociation(petId);
            res.set("Cache-Control", "no-store");
            return res.json({
                sucesso: true,
                tem_associacao: Boolean(association),
                associacao: association
                    ? { device_id: association.device_id, pet_id: petId }
                    : null
            });
        } catch (error) {
            return handleAssociationError(res, error, next);
        }
    }));

    router.delete("/associacoes", (req, res, next) => withWebSession(req, res, next, async (usuarioId) => {
        const petId = readPetId(req.query.pet_id, res);
        if (!petId) return;
        if (typeof executeReadWithRetry !== "function" || typeof executeWrite !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "O gerenciamento de associações Mabel não está disponível."
            });
        }

        try {
            if (!(await findOwnedPet(petId, usuarioId))) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Pet não encontrado."
                });
            }
            const association = await findPetAssociation(petId);
            if (!association) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Este pet não possui uma associação Mabel."
                });
            }
            await executeWrite(
                "DELETE FROM mabel_pet_associations WHERE pet_id = ? AND device_id = ?",
                [petId, association.device_id]
            );
            res.set("Cache-Control", "no-store");
            return res.json({ sucesso: true, mensagem: "Dispositivo desvinculado do pet." });
        } catch (error) {
            return handleAssociationError(res, error, next);
        }
    }));

    router.get("/status", (req, res, next) => {
        if (req.get("authorization")) {
            if (!requireDevice(req, res)) return;
            if (typeof executeReadWithRetry !== "function") {
                return res.status(503).json({
                    sucesso: false,
                    mensagem: "A consulta da telemetria Mabel não está disponível."
                });
            }
            return executeReadWithRetry(
                `SELECT device_id, sensor_detectou, contador_deteccoes, uptime_ms,
                        UNIX_TIMESTAMP(ultimo_contato) * 1000 AS ultimo_contato_ms
                 FROM mabel_device_status
                 ORDER BY ultimo_contato DESC
                 LIMIT 1`,
                [],
                "consultar a última telemetria Mabel"
            ).then(([statuses]) => {
                const latest = serializeStatus(statuses[0], statuses[0]?.device_id);
                res.set("Cache-Control", "no-store");
                return res.json({
                    sucesso: true,
                    tem_dados: Boolean(latest),
                    ultimo_contato: latest?.ultimo_contato || null,
                    dados: latest
                });
            }).catch((error) => handleTelemetryError(res, error, next));
        }

        return withWebSession(req, res, next, async (usuarioId) => {
            const petId = readPetId(req.query.pet_id, res);
            if (!petId) return;
            if (typeof executeReadWithRetry !== "function") {
                return res.status(503).json({
                    sucesso: false,
                    mensagem: "A verificação de propriedade do pet não está disponível."
                });
            }

            try {
                if (!(await findOwnedPet(petId, usuarioId))) {
                    return res.status(404).json({
                        sucesso: false,
                        mensagem: "Pet não encontrado."
                    });
                }

                const association = await findPetAssociation(petId);
                const row = association
                    ? await findCurrentPetStatus(petId, association.device_id)
                    : null;
                const currentReading = serializeStatus(row, association?.device_id);
                res.set("Cache-Control", "no-store");
                return res.json({
                    sucesso: true,
                    tem_associacao: Boolean(association),
                    tem_dados: Boolean(currentReading),
                    device_id: association?.device_id || null,
                    ultimo_contato: currentReading?.ultimo_contato || null,
                    dados: currentReading
                });
            } catch (error) {
                return handleTelemetryError(res, error, next);
            }
        });
    });

    return router;
}

module.exports = {
    createMabelRouter,
    hasValidDeviceToken,
    parsePositiveBigInt,
    validateDeviceId,
    validateTelemetry
};
