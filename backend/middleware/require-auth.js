
function requireAuth(req, res, next) {
    if (req.session?.usuario?.id) {
        return next();
    }

    if (req.originalUrl.startsWith("/software")) {
        return res.redirect("/pages/login/login.html");
    }

    return res.status(401).json({
        sucesso: false,
        mensagem: "Autenticação necessária."
    });
}

module.exports = requireAuth;
