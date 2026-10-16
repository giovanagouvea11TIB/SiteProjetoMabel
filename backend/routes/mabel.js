const crypto = require("node:crypto");
const express = require("express");

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const MAX_DEVICE_STATES = 100;
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
    executeWrite,
    readings = new Map(),
    now = () => new Date()
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
            `SELECT device_id, UNIX_TIMESTAMP(linked_at) * 1000 AS linked_at_ms
             FROM mabel_pet_associations
             WHERE pet_id = ?
             LIMIT 1`,
            [petId],
            "consultar associação Mabel do pet"
        );
        return associations[0] || null;
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

    router.post("/dados", (req, res) => {
        if (!requireDevice(req, res)) return;

        const validationError = validateTelemetry(req.body);
        if (validationError) {
            return res.status(400).json({ sucesso: false, mensagem: validationError });
        }

        const receivedAt = now().toISOString();
        if (!readings.has(req.body.device_id) && readings.size >= MAX_DEVICE_STATES) {
            const oldestDeviceId = readings.keys().next().value;
            readings.delete(oldestDeviceId);
        }
        readings.delete(req.body.device_id);
        readings.set(req.body.device_id, {
            device_id: req.body.device_id,
            sensor_detectou: req.body.sensor_detectou,
            contador_deteccoes: req.body.contador_deteccoes,
            uptime_ms: req.body.uptime_ms,
            ultimo_contato: receivedAt
        });

        res.set("Cache-Control", "no-store");
        return res.status(202).json({
            sucesso: true,
            mensagem: "Leitura recebida. Ela ficará disponível somente enquanto este processo estiver ativo.",
            persistida: false,
            device_id: req.body.device_id,
            ultimo_contato: receivedAt
        });
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
            readings.delete(req.body.device_id);
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
            readings.delete(association.device_id);
            res.set("Cache-Control", "no-store");
            return res.json({ sucesso: true, mensagem: "Dispositivo desvinculado do pet." });
        } catch (error) {
            return handleAssociationError(res, error, next);
        }
    }));

    router.get("/status", (req, res, next) => {
        if (req.get("authorization")) {
            if (!requireDevice(req, res)) return;

            const latest = [...readings.values()]
                .sort((a, b) => b.ultimo_contato.localeCompare(a.ultimo_contato))[0] || null;
            res.set("Cache-Control", "no-store");
            return res.json({
                sucesso: true,
                tem_dados: Boolean(latest),
                ultimo_contato: latest?.ultimo_contato || null,
                dados: latest
            });
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
                const reading = association ? readings.get(association.device_id) || null : null;
                const readingIsCurrent = reading
                    && Number.isFinite(Number(association.linked_at_ms))
                    && Date.parse(reading.ultimo_contato) >= Number(association.linked_at_ms) + 1000;
                const currentReading = readingIsCurrent ? reading : null;
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
                return handleAssociationError(res, error, next);
            }
        });
    });

    return router;
}

module.exports = {
    createMabelRouter,
    hasValidDeviceToken,
    validateDeviceId,
    validateTelemetry
};
