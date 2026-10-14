const express = require("express");
const { pool, executeReadWithRetry, getUsersTableName } = require("../db");
const requireAuth = require("../middleware/require-auth");
const { sendDatabaseError } = require("../database-errors");

const router = express.Router();
const AVATARS = new Set([
    "paw",
    "flower",
    "heart",
    "star",
    "fish",
    "dog",
    "cat",
    "horse",
    "butterfly",
    "rabbit",
    "bird",
    "leaf"
]);

router.use(requireAuth);

function getSessionUserId(req, res) {
    const id = req.session?.usuario?.id;
    if ((typeof id !== "string" && typeof id !== "number") || !/^[1-9]\d*$/.test(String(id))) {
        res.status(401).json({ sucesso: false, mensagem: "Autenticação necessária." });
        return null;
    }
    return String(id);
}

function handleAvatarError(res, error) {
    if (error?.code === "ER_BAD_FIELD_ERROR") {
        return res.status(503).json({
            sucesso: false,
            mensagem: "A personalização de avatar ainda não está disponível."
        });
    }
    return sendDatabaseError(
        res,
        error,
        "processar avatar da conta",
        "Não foi possível processar o avatar."
    );
}

router.get("/", async (req, res) => {
    const usuarioId = getSessionUserId(req, res);
    if (!usuarioId) return;

    try {
        const tabelaUsuarios = await getUsersTableName();
        const [rows] = await executeReadWithRetry(
            `SELECT avatar_id FROM \`${tabelaUsuarios}\` WHERE id = ? LIMIT 1`,
            [usuarioId],
            "consultar avatar da conta"
        );
        if (rows.length === 0) {
            return res.status(401).json({ sucesso: false, mensagem: "Autenticação necessária." });
        }

        res.set("Cache-Control", "private, no-store");
        return res.json({
            sucesso: true,
            avatar: AVATARS.has(rows[0].avatar_id) ? rows[0].avatar_id : "paw"
        });
    } catch (error) {
        return handleAvatarError(res, error);
    }
});

router.put("/", async (req, res) => {
    const usuarioId = getSessionUserId(req, res);
    if (!usuarioId) return;

    if (
        !req.body
        || typeof req.body !== "object"
        || Array.isArray(req.body)
        || Object.keys(req.body).length !== 1
        || typeof req.body.avatar !== "string"
        || !AVATARS.has(req.body.avatar)
    ) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Selecione um avatar válido."
        });
    }

    try {
        const tabelaUsuarios = await getUsersTableName();
        const [result] = await pool.execute(
            `UPDATE \`${tabelaUsuarios}\` SET avatar_id = ? WHERE id = ?`,
            [req.body.avatar, usuarioId]
        );
        if (result.affectedRows === 0) {
            const [rows] = await executeReadWithRetry(
                `SELECT id FROM \`${tabelaUsuarios}\` WHERE id = ? LIMIT 1`,
                [usuarioId],
                "confirmar conta autenticada"
            );
            if (rows.length === 0) {
                return res.status(401).json({ sucesso: false, mensagem: "Autenticação necessária." });
            }
        }

        res.set("Cache-Control", "private, no-store");
        return res.json({ sucesso: true, avatar: req.body.avatar });
    } catch (error) {
        return handleAvatarError(res, error);
    }
});

module.exports = router;
