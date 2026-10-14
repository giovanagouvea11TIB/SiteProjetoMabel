const express = require("express");
const { pool, executeReadWithRetry } = require("../db");
const { sendDatabaseError } = require("../database-errors");
const requireAuth = require("../middleware/require-auth");

const router = express.Router();
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const RECORD_FIELDS = new Set([
    "nome_vacina",
    "status",
    "data_prevista",
    "data_aplicacao",
    "veterinario",
    "clinica",
    "observacoes"
]);
const VACCINE_CATALOG = [
    {
        id: "polivalente_v8_v10",
        nome: "Polivalente canina (V8/V10)",
        descricao: "Converse com o médico-veterinário sobre a vacina e o protocolo adequados para este pet."
    },
    {
        id: "antirrabica",
        nome: "Antirrábica",
        descricao: "A indicação e o calendário devem seguir a orientação veterinária e as regras locais."
    }
];
const CATALOG_STATUSES = new Set(["aplicada", "nao_aplicada", "desconhecida"]);
router.use(requireAuth);

function parsePositiveBigInt(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
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

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    if (year < 1000 || year > 9999) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function normalizeOptionalText(value, field, maxLength) {
    if (value === undefined || value === null) return { value: null };
    if (typeof value !== "string") return { error: `${field} deve ser texto.` };

    const normalized = value.trim();
    if (!normalized) return { value: null };
    if (Array.from(normalized).length > maxLength) {
        return { error: `${field} excede o limite permitido.` };
    }
    return { value: normalized };
}

function validateRecord(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: ["Envie os dados da vacina em um objeto JSON."] };
    }

    if (Object.keys(body).some((field) => !RECORD_FIELDS.has(field))) {
        return { errors: ["A requisição contém campos não permitidos."] };
    }

    const errors = [];
    const name = normalizeOptionalText(body.nome_vacina, "Nome da vacina", 120);
    if (name.error) errors.push(name.error);
    else if (!name.value) errors.push("Informe o nome da vacina.");

    if (body.status !== "prevista" && body.status !== "aplicada") {
        errors.push("Status deve ser prevista ou aplicada.");
    }

    const veterinarian = normalizeOptionalText(body.veterinario, "Veterinário", 120);
    const clinic = normalizeOptionalText(body.clinica, "Clínica", 160);
    const notes = normalizeOptionalText(body.observacoes, "Observações", 4000);
    for (const field of [veterinarian, clinic, notes]) {
        if (field.error) errors.push(field.error);
    }

    const scheduledDate = body.data_prevista === undefined || body.data_prevista === null || body.data_prevista === ""
        ? null
        : body.data_prevista;
    const applicationDate = body.data_aplicacao === undefined || body.data_aplicacao === null || body.data_aplicacao === ""
        ? null
        : body.data_aplicacao;

    for (const [date, label] of [
        [scheduledDate, "Data prevista"],
        [applicationDate, "Data da aplicação"]
    ]) {
        if (date !== null && !isValidDate(date)) {
            errors.push(`${label} deve ser uma data válida no formato AAAA-MM-DD.`);
        }
    }

    if (body.status === "prevista" && scheduledDate === null) {
        errors.push("Informe a data prevista para a dose.");
    }
    if (body.status === "prevista" && applicationDate !== null) {
        errors.push("Uma dose prevista não pode ter data de aplicação.");
    }
    if (errors.length > 0) return { errors };

    return {
        values: {
            nome_vacina: name.value,
            status: body.status,
            data_prevista: scheduledDate,
            data_aplicacao: applicationDate,
            veterinario: veterinarian.value,
            clinica: clinic.value,
            observacoes: notes.value
        }
    };
}

function serializeDate(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function serializeRecord(row) {
    return {
        id: String(row.id),
        pet_id: String(row.pet_id),
        nome_vacina: row.nome_vacina,
        status: row.status,
        data_prevista: serializeDate(row.data_prevista),
        data_aplicacao: serializeDate(row.data_aplicacao),
        veterinario: row.veterinario,
        clinica: row.clinica,
        observacoes: row.observacoes
    };
}

function handleDatabaseError(res, error, action) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
            sucesso: false,
            mensagem: "O Diário de Vacinas ainda não está disponível. A estrutura do banco precisa ser preparada."
        });
    }

    return sendDatabaseError(
        res,
        error,
        `${action} registro de vacina`,
        "Não foi possível processar o registro de vacina."
    );
}

async function getOwnedPet(usuarioId, petId) {
    const [pets] = await executeReadWithRetry(
        "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
        [petId, usuarioId],
        "validar propriedade do pet"
    );
    return pets.length > 0;
}

function getAuthenticatedUserId(req, res) {
    const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
    if (usuarioId) return usuarioId;

    res.status(401).json({
        sucesso: false,
        mensagem: "Autenticação necessária."
    });
    return null;
}

function invalidId(res) {
    return res.status(400).json({
        sucesso: false,
        mensagem: "Identificador inválido."
    });
}

function petNotFound(res) {
    return res.status(404).json({
        sucesso: false,
        mensagem: "Pet não encontrado."
    });
}

function recordNotFound(res) {
    return res.status(404).json({
        sucesso: false,
        mensagem: "Registro de vacina não encontrado."
    });
}

router.get("/notificacoes", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    try {
        const [rows] = await executeReadWithRetry(
            `SELECT v.id, v.pet_id, p.nome AS pet_nome, v.nome_vacina, v.data_prevista
             FROM pet_vacinas AS v
             INNER JOIN pets AS p ON p.id = v.pet_id
             WHERE p.usuario_id = ? AND v.status = 'prevista'
             ORDER BY v.data_prevista ASC, v.id ASC`,
            [usuarioId],
            "consultar notificações vacinais"
        );

        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            notificacoes: rows.map((row) => ({
                id: String(row.id),
                pet_id: String(row.pet_id),
                pet_nome: row.pet_nome,
                nome_vacina: row.nome_vacina,
                data_prevista: serializeDate(row.data_prevista)
            }))
        });
    } catch (error) {
        return handleDatabaseError(res, error, "consultar notificações de");
    }
});

router.get("/pets/:petId/registros", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    if (!petId) return invalidId(res);

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);

        const [rows] = await executeReadWithRetry(
            `SELECT id, pet_id, nome_vacina, status, data_prevista, data_aplicacao,
                    veterinario, clinica, observacoes
             FROM pet_vacinas
             WHERE pet_id = ?
             ORDER BY COALESCE(data_aplicacao, data_prevista) DESC, id DESC`,
            [petId],
            "consultar histórico de doses"
        );

        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            registros: rows.map(serializeRecord)
        });
    } catch (error) {
        return handleDatabaseError(res, error, "consultar");
    }
});

router.get("/pets/:petId/catalogo", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    if (!petId) return invalidId(res);

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);

        const [rows] = await executeReadWithRetry(
            `SELECT vacina_key, status, data_aplicacao
             FROM pet_vacina_catalogo
             WHERE pet_id = ?`,
            [petId],
            "consultar estado do catálogo vacinal"
        );
        const states = new Map(rows.map((row) => [row.vacina_key, row]));

        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            catalogo: VACCINE_CATALOG.map((vaccine) => {
                const state = states.get(vaccine.id);
                return {
                    ...vaccine,
                    status: state?.status || null,
                    data_aplicacao: serializeDate(state?.data_aplicacao)
                };
            })
        });
    } catch (error) {
        return handleDatabaseError(res, error, "consultar catálogo de vacinas para");
    }
});

router.put("/pets/:petId/catalogo/:vaccineKey", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    if (!petId) return invalidId(res);

    const vaccine = VACCINE_CATALOG.find((item) => item.id === req.params.vaccineKey);
    if (!vaccine) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Vacina do catálogo inválida."
        });
    }

    const body = req.body;
    if (
        !body
        || typeof body !== "object"
        || Array.isArray(body)
        || Object.keys(body).some((field) => !["status", "data_aplicacao", "preserve_history"].includes(field))
        || !CATALOG_STATUSES.has(body.status)
        || (body.preserve_history !== undefined && typeof body.preserve_history !== "boolean")
    ) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Informe uma situação válida para a vacina."
        });
    }

    const applicationDate = body.data_aplicacao === undefined || body.data_aplicacao === null || body.data_aplicacao === ""
        ? null
        : body.data_aplicacao;
    if (applicationDate !== null && !isValidDate(applicationDate)) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "A data da aplicação deve ser válida no formato AAAA-MM-DD."
        });
    }
    if (body.status !== "aplicada" && applicationDate !== null) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Informe uma data somente quando a vacina estiver marcada como aplicada."
        });
    }

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);
    } catch (error) {
        return handleDatabaseError(res, error, "validar pet para atualização do catálogo de vacinas");
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [previousRows] = await connection.execute(
            `SELECT status, data_aplicacao
             FROM pet_vacina_catalogo
             WHERE pet_id = ? AND vacina_key = ?
             FOR UPDATE`,
            [petId, vaccine.id]
        );
        const previous = previousRows[0];

        await connection.execute(
            `INSERT INTO pet_vacina_catalogo (pet_id, vacina_key, status, data_aplicacao)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), data_aplicacao = VALUES(data_aplicacao)`,
            [petId, vaccine.id, body.status, applicationDate]
        );

        const previousDate = previous ? serializeDate(previous.data_aplicacao) : null;
        if (
            body.preserve_history !== true
            &&
            body.status === "aplicada"
            && (!previous || previous.status !== "aplicada" || previousDate !== applicationDate)
        ) {
            const [matchingHistory] = await connection.execute(
                `SELECT id FROM pet_vacinas
                 WHERE pet_id = ? AND nome_vacina = ? AND status = 'aplicada'
                   AND data_aplicacao <=> ?
                 LIMIT 1
                 FOR UPDATE`,
                [petId, vaccine.nome, applicationDate]
            );
            if (matchingHistory.length === 0) {
                await connection.execute(
                    `INSERT INTO pet_vacinas
                        (pet_id, nome_vacina, status, data_prevista, data_aplicacao,
                         veterinario, clinica, observacoes)
                     VALUES (?, ?, 'aplicada', NULL, ?, NULL, NULL, NULL)`,
                    [petId, vaccine.nome, applicationDate]
                );
            }
        }

        await connection.commit();
        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            vacina: {
                ...vaccine,
                status: body.status,
                data_aplicacao: applicationDate
            }
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Falha ao reverter atualização do catálogo vacinal:", rollbackError.code || "erro não identificado");
            }
        }
        return handleDatabaseError(res, error, "atualizar catálogo de vacinas para");
    } finally {
        connection?.release();
    }
});

router.post("/pets/:petId/registros", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    if (!petId) return invalidId(res);

    const validation = validateRecord(req.body);
    if (validation.errors) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Verifique os dados informados.",
            erros: validation.errors
        });
    }

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);

        const { values } = validation;
        const [result] = await pool.execute(
            `INSERT INTO pet_vacinas
                (pet_id, nome_vacina, status, data_prevista, data_aplicacao,
                 veterinario, clinica, observacoes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                petId,
                values.nome_vacina,
                values.status,
                values.data_prevista,
                values.data_aplicacao,
                values.veterinario,
                values.clinica,
                values.observacoes
            ]
        );

        return res.status(201).json({
            sucesso: true,
            registro: {
                id: String(result.insertId),
                pet_id: petId,
                ...values
            }
        });
    } catch (error) {
        return handleDatabaseError(res, error, "cadastrar");
    }
});

router.put("/pets/:petId/registros/:recordId", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    const recordId = parsePositiveBigInt(req.params.recordId);
    if (!petId || !recordId) return invalidId(res);

    const validation = validateRecord(req.body);
    if (validation.errors) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Verifique os dados informados.",
            erros: validation.errors
        });
    }

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);

        const { values } = validation;
        const [result] = await pool.execute(
            `UPDATE pet_vacinas
             SET nome_vacina = ?, status = ?, data_prevista = ?, data_aplicacao = ?,
                 veterinario = ?, clinica = ?, observacoes = ?
             WHERE id = ? AND pet_id = ?`,
            [
                values.nome_vacina,
                values.status,
                values.data_prevista,
                values.data_aplicacao,
                values.veterinario,
                values.clinica,
                values.observacoes,
                recordId,
                petId
            ]
        );

        if (result.affectedRows === 0) {
            const [records] = await pool.execute(
                "SELECT id FROM pet_vacinas WHERE id = ? AND pet_id = ? LIMIT 1",
                [recordId, petId]
            );
            if (records.length === 0) return recordNotFound(res);
        }

        return res.json({
            sucesso: true,
            registro: {
                id: recordId,
                pet_id: petId,
                ...values
            }
        });
    } catch (error) {
        return handleDatabaseError(res, error, "atualizar");
    }
});

router.delete("/pets/:petId/registros/:recordId", async (req, res) => {
    const usuarioId = getAuthenticatedUserId(req, res);
    if (!usuarioId) return;

    const petId = parsePositiveBigInt(req.params.petId);
    const recordId = parsePositiveBigInt(req.params.recordId);
    if (!petId || !recordId) return invalidId(res);

    try {
        if (!(await getOwnedPet(usuarioId, petId))) return petNotFound(res);

        const [result] = await pool.execute(
            "DELETE FROM pet_vacinas WHERE id = ? AND pet_id = ?",
            [recordId, petId]
        );
        if (result.affectedRows === 0) return recordNotFound(res);

        return res.json({
            sucesso: true,
            mensagem: "Registro de vacina excluído com sucesso."
        });
    } catch (error) {
        return handleDatabaseError(res, error, "excluir");
    }
});

module.exports = router;
