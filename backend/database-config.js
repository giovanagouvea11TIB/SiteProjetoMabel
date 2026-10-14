const EXPECTED_DATABASE = "alunos_projetoMabel";

function integerSetting(env, name, fallback, minimum, maximum) {
    const value = env[name];
    if (value === undefined || value === "") return fallback;

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} deve ser um número inteiro entre ${minimum} e ${maximum}.`);
    }
    return parsed;
}

function resolveDatabaseConfig(env) {
    if (env.DB_DATABASE && env.DB_NAME && env.DB_DATABASE !== env.DB_NAME) {
        throw new Error("DB_DATABASE e DB_NAME devem apontar para o mesmo schema.");
    }

    const database = env.DB_DATABASE || env.DB_NAME || EXPECTED_DATABASE;
    if (database !== EXPECTED_DATABASE) {
        throw new Error(`O banco configurado deve ser ${EXPECTED_DATABASE}.`);
    }

    const host = typeof env.DB_HOST === "string" ? env.DB_HOST.trim() : "";
    const user = typeof env.DB_USER === "string" ? env.DB_USER.trim() : "";
    if (!host || !user) {
        throw new Error("Configure DB_HOST e DB_USER para conectar ao banco.");
    }

    const connectionLimit = integerSetting(
        env,
        "DB_CONNECTION_LIMIT",
        env.VERCEL ? 1 : 10,
        1,
        100
    );

    return {
        host,
        port: integerSetting(env, "DB_PORT", 3306, 1, 65535),
        user,
        password: env.DB_PASSWORD,
        database,
        supportBigNumbers: true,
        bigNumberStrings: true,
        waitForConnections: true,
        connectionLimit,
        maxIdle: connectionLimit,
        idleTimeout: 60000,
        connectTimeout: 10000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        queueLimit: integerSetting(env, "DB_QUEUE_LIMIT", 50, 1, 10000),
        charset: "utf8mb4",
        ...(env.DB_SSL === "true" || env.DB_SSL === "1" ? { ssl: {} } : {})
    };
}

module.exports = { EXPECTED_DATABASE, resolveDatabaseConfig };
