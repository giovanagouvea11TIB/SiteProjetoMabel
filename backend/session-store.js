const MySQLStore = require("express-mysql-session");
const { createSessionPoolAdapter } = require("./database-reads");

function createSessionStore(session, pool, createStore = MySQLStore) {
    const Store = createStore(session);
    return new Store({
        createDatabaseTable: false,
        endConnectionOnClose: false,
        schema: {
            tableName: "mabel_web_sessions"
        }
    }, createSessionPoolAdapter(pool));
}

module.exports = { createSessionStore };
