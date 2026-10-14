const REWRITTEN_PATH_PARAMETER = "__mabel_api_path";
const API_SERVICES = new Set(["perfil", "vacinas", "mabel"]);

function rewriteApiRequestUrl(requestUrl) {
    const url = new URL(requestUrl, "http://localhost");
    const paths = url.searchParams.getAll(REWRITTEN_PATH_PARAMETER);
    if (paths.length === 0) return requestUrl;
    if (paths.length !== 1) return null;

    const segments = paths[0].split("/");
    if (
        segments.length < 2
        || !API_SERVICES.has(segments[0])
        || segments.some((segment) =>
            !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === ".."
        )
    ) {
        return null;
    }

    url.pathname = `/api/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
    url.searchParams.delete(REWRITTEN_PATH_PARAMETER);
    return `${url.pathname}${url.search}`;
}

module.exports = { rewriteApiRequestUrl };
