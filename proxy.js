const { next } = require("@vercel/functions");

module.exports = async function proxy(request) {
    const requestUrl = new URL(request.url);
    const cookie = request.headers.get("cookie");

    try {
        const sessionResponse = await fetch(
            new URL("/api/auth/sessao", requestUrl.origin),
            {
                headers: cookie ? { cookie } : {},
                cache: "no-store"
            }
        );

        if (!sessionResponse.ok) {
            return new Response(
                "Não foi possível verificar a sessão.",
                {
                    status: 503,
                    headers: { "Cache-Control": "no-store" }
                }
            );
        }

        const session = await sessionResponse.json();

        if (session.autenticado !== true) {
            return new Response(null, {
                status: 302,
                headers: {
                    Location: new URL(
                        "/pages/login/login.html",
                        requestUrl
                    ).href,
                    "Cache-Control": "private, no-store"
                }
            });
        }

        return next();
    } catch {
        return new Response(
            "Não foi possível verificar a sessão.",
            {
                status: 503,
                headers: { "Cache-Control": "no-store" }
            }
        );
    }
};
