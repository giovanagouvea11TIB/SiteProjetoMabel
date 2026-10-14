const express = require("express");
const { pool, executeReadWithRetry } = require("../db");
const { sendDatabaseError } = require("../database-errors");
const requireAuth = require("../middleware/require-auth");

const router = express.Router();
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const PET_FIELDS = new Set([
    "nome",
    "identificacao",
    "idade_meses",
    "peso_kg",
    "condicao_saude"
]);

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

function normalizeOptionalText(value, field, maxLength, maxBytes = Infinity) {
    if (value === undefined || value === null) return { value: null };
    if (typeof value !== "string") {
        return { error: `${field} deve ser um texto.` };
    }

    const normalized = value.trim();
    if (!normalized) return { value: null };
    if (Array.from(normalized).length > maxLength || Buffer.byteLength(normalized, "utf8") > maxBytes) {
        return { error: `${field} excede o limite permitido.` };
    }

    return { value: normalized };
}

function validatePet(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { errors: ["Envie os dados do pet em um objeto JSON."] };
    }

    const unknownFields = Object.keys(body).filter((field) => !PET_FIELDS.has(field));
    if (unknownFields.length > 0) {
        return { errors: ["A requisição contém campos não permitidos."] };
    }

    const errors = [];
    const name = normalizeOptionalText(body.nome, "Nome", 120);
    if (name.error) errors.push(name.error);
    else if (!name.value) errors.push("Informe o nome do pet.");

    const identification = normalizeOptionalText(body.identificacao, "Identificação", 120);
    if (identification.error) errors.push(identification.error);

    const condition = normalizeOptionalText(body.condicao_saude, "Condição de saúde", 4000, 16000);
    if (condition.error) errors.push(condition.error);

    let age = null;
    if (body.idade_meses !== undefined && body.idade_meses !== null && body.idade_meses !== "") {
        const value = String(body.idade_meses);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
            errors.push("Idade deve ser um número inteiro entre 0 e 65535 meses.");
        } else {
            age = Number(value);
        }
    }

    let weight = null;
    if (body.peso_kg !== undefined && body.peso_kg !== null && body.peso_kg !== "") {
        const value = typeof body.peso_kg === "number"
            ? String(body.peso_kg)
            : typeof body.peso_kg === "string"
                ? body.peso_kg.trim()
                : "";
        if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0) {
            errors.push("Peso deve ser um número maior que zero, com até 3 casas decimais e no máximo 9999.999 kg.");
        } else {
            weight = value;
        }
    }

    if (errors.length > 0) return { errors };

    return {
        values: {
            nome: name.value,
            identificacao: identification.value,
            idade_meses: age,
            peso_kg: weight,
            condicao_saude: condition.value
        }
    };
}

function serializePet(row) {
    return {
        id: String(row.id),
        nome: row.nome,
        identificacao: row.identificacao,
        idade_meses: row.idade_meses,
        peso_kg: row.peso_kg === null ? null : String(row.peso_kg),
        condicao_saude: row.condicao_saude
    };
}

function handleDatabaseError(res, error, action) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
            sucesso: false,
            mensagem: "O perfil de pets ainda não está disponível. A estrutura do banco precisa ser preparada."
        });
    }

    return sendDatabaseError(
        res,
        error,
        `${action} perfil do pet`,
        "Não foi possível processar o perfil do pet."
    );
}

router.get("/pet", async (req, res) => {
    const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
    if (!usuarioId) {
        return res.status(401).json({
            sucesso: false,
            mensagem: "Autenticação necessária."
        });
    }

    try {
        const [pets] = await executeReadWithRetry(
            `SELECT id, nome, identificacao, idade_meses, peso_kg, condicao_saude
             FROM pets
             WHERE usuario_id = ?
             ORDER BY id ASC`,
            [usuarioId],
            "consultar pets do usuário"
        );

        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            pets: pets.map(serializePet)
        });
    } catch (error) {
        return handleDatabaseError(res, error, "consultar");
    }
});

router.post("/pet", async (req, res) => {
    const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
    if (!usuarioId) {
        return res.status(401).json({
            sucesso: false,
            mensagem: "Autenticação necessária."
        });
    }

    const validation = validatePet(req.body);
    if (validation.errors) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Verifique os dados informados.",
            erros: validation.errors
        });
    }

    try {
        const { values } = validation;
        const [result] = await pool.execute(
            `INSERT INTO pets
                (usuario_id, nome, identificacao, idade_meses, peso_kg, condicao_saude)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                usuarioId,
                values.nome,
                values.identificacao,
                values.idade_meses,
                values.peso_kg,
                values.condicao_saude
            ]
        );

        return res.status(201).json({
            sucesso: true,
            pet: {
                id: String(result.insertId),
                ...values
            }
        });
    } catch (error) {
        return handleDatabaseError(res, error, "cadastrar");
    }
});

router.put("/pet/:id", async (req, res) => {
    const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
    if (!usuarioId) {
        return res.status(401).json({
            sucesso: false,
            mensagem: "Autenticação necessária."
        });
    }

    const petId = parsePositiveBigInt(req.params.id);
    if (!petId) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Identificador do pet inválido."
        });
    }

    const validation = validatePet(req.body);
    if (validation.errors) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Verifique os dados informados.",
            erros: validation.errors
        });
    }

    try {
        const [ownedPets] = await executeReadWithRetry(
            "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
            [petId, usuarioId],
            "verificar propriedade do pet"
        );
        if (ownedPets.length === 0) {
            return res.status(404).json({
                sucesso: false,
                mensagem: "Pet não encontrado."
            });
        }

        const { values } = validation;
        const [result] = await pool.execute(
            `UPDATE pets
             SET nome = ?, identificacao = ?, idade_meses = ?, peso_kg = ?, condicao_saude = ?
             WHERE id = ? AND usuario_id = ?`,
            [
                values.nome,
                values.identificacao,
                values.idade_meses,
                values.peso_kg,
                values.condicao_saude,
                petId,
                usuarioId
            ]
        );

        if (result.affectedRows === 0) {
            const [stillOwned] = await executeReadWithRetry(
                "SELECT id FROM pets WHERE id = ? AND usuario_id = ? LIMIT 1",
                [petId, usuarioId],
                "confirmar propriedade do pet"
            );
            if (stillOwned.length === 0) {
                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Pet não encontrado."
                });
            }
        }

        return res.json({
            sucesso: true,
            pet: { id: petId, ...values }
        });
    } catch (error) {
        return handleDatabaseError(res, error, "atualizar");
    }
});

router.delete("/pet/:id", async (req, res) => {
    const usuarioId = parsePositiveBigInt(req.session?.usuario?.id);
    if (!usuarioId) {
        return res.status(401).json({
            sucesso: false,
            mensagem: "Autenticação necessária."
        });
    }

    const petId = parsePositiveBigInt(req.params.id);
    if (!petId) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Identificador do pet inválido."
        });
    }

    try {
        const [result] = await pool.execute(
            "DELETE FROM pets WHERE id = ? AND usuario_id = ?",
            [petId, usuarioId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                sucesso: false,
                mensagem: "Pet não encontrado."
            });
        }

        return res.json({
            sucesso: true,
            mensagem: "Pet excluído com sucesso."
        });
    } catch (error) {
        return handleDatabaseError(res, error, "excluir");
    }
});

module.exports = router;
