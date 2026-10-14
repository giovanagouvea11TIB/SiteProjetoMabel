const crypto = require("node:crypto");
const express = require("express");

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
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
    if (typeof body.device_id !== "string" || !DEVICE_ID_PATTERN.test(body.device_id)) {
        return "device_id deve conter de 1 a 64 caracteres alfanuméricos, ponto, hífen, dois-pontos ou sublinhado.";
    }
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

function createMabelRouter({
    deviceToken = process.env.MABEL_DEVICE_TOKEN,
    sessionMiddleware,
    executeReadWithRetry,
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

        if (typeof sessionMiddleware !== "function") {
            return res.status(503).json({
                sucesso: false,
                mensagem: "A autenticação web não está disponível."
            });
        }

        return sessionMiddleware(req, res, (sessionError) => {
            if (sessionError) return next(sessionError);

            const usuarioId = req.session?.usuario?.id;
            if (
                (typeof usuarioId !== "string" && typeof usuarioId !== "number")
                || !/^[1-9]\d*$/.test(String(usuarioId))
            ) {
                return res.status(401).json({
                    sucesso: false,
                    mensagem: "Autenticação necessária."
                });
            }

            const petId = req.query.pet_id;
            if (typeof petId !== "string" || !/^[1-9]\d*$/.test(petId)) {
                return res.status(400).json({
                    sucesso: false,
                    mensagem: "Informe um pet_id válido para consultar o status."
                });
            }
            if (typeof executeReadWithRetry !== "function") {
                return res.status(503).json({
                    sucesso: false,
                    mensagem: "A verificação de propriedade do pet não está disponível."
                });
            }

            return executeReadWithRetry(
                "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
                [petId, String(usuarioId)],
                "confirmar propriedade do pet para consultar Mabel"
            ).then(([pets]) => {
                if (pets.length === 0) {
                    return res.status(404).json({
                        sucesso: false,
                        mensagem: "Pet não encontrado."
                    });
                }

                return res.status(409).json({
                    sucesso: false,
                    mensagem: "As leituras ainda não podem ser vinculadas com segurança a este pet. É necessária uma associação persistente entre dispositivo e pet."
                });
            }).catch(next);
        });
    });

    return router;
}

module.exports = { createMabelRouter, hasValidDeviceToken, validateTelemetry };
