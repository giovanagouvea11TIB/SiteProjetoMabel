// DOM mínimo para executar os scripts das páginas Controle e Diário nos testes, sem navegador.
// Não interpreta HTML: o texto só entra pelos mesmos caminhos usados pelas páginas (textContent).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
    constructor(tagName, id = "") {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.children = [];
        this.ownText = "";
        this.hidden = false;
        this.disabled = false;
        this.value = "";
        this.className = "";
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.style = { setProperty() {} };
        const element = this;
        this.classList = {
            add(name) { element.toggleClass(name, true); },
            remove(name) { element.toggleClass(name, false); },
            toggle(name, force) { element.toggleClass(name, force); },
            contains(name) { return element.className.split(/\s+/).includes(name); }
        };
    }

    toggleClass(name, force) {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enable = force === undefined ? !names.has(name) : Boolean(force);
        if (enable) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
    }

    get textContent() {
        return this.children.length ? this.children.map((child) => child.textContent).join(" ") : this.ownText;
    }

    set textContent(value) {
        this.children = [];
        this.ownText = String(value);
    }

    get childElementCount() {
        return this.children.length;
    }

    append(...nodes) {
        for (const node of nodes) {
            if (!(node instanceof FakeElement)) throw new Error("O DOM de teste aceita apenas elementos.");
            this.children.push(node);
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.ownText = "";
        this.append(...nodes);
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
    }

    dispatch(type) {
        for (const listener of this.listeners[type] || []) listener({ target: this });
    }

    findAll(predicate) {
        return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.findAll(predicate)]);
    }

    findByClass(className) {
        return this.findAll((node) => node.classList.contains(className));
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function jsonResponse(status, body) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Cada chamada a fetch fica pendente até o teste responder, para simular respostas fora de ordem.
// location simula o endereço da página: por padrão, o site publicado (sem porta 5500).
function createPage(scriptPaths, { durations = [], location = { port: "", hostname: "localhost" } } = {}) {
    const elements = new Map();
    const getElement = (id) => {
        if (!elements.has(id)) elements.set(id, new FakeElement("div", id));
        return elements.get(id);
    };
    const durationButtons = durations.map((seconds) => {
        const button = new FakeElement("button");
        button.dataset.duracao = String(seconds);
        return button;
    });
    const documentListeners = {};
    const requests = [];
    const intervals = [];
    const storage = new Map();
    const redirects = [];
    // Relógio da página: parado até o teste avançá-lo, para que a contagem regressiva seja determinística.
    let currentTime = Date.now();
    class PageDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [currentTime]));
        }

        static now() {
            return currentTime;
        }
    }

    const document = {
        visibilityState: "visible",
        getElementById: getElement,
        querySelectorAll: (selector) => (selector === "[data-duracao]" ? durationButtons : []),
        createElement: (tag) => new FakeElement(tag),
        addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); }
    };

    function fetch(url, options) {
        const pending = deferred();
        requests.push({ url, options, ...pending });
        return pending.promise;
    }

    class Option extends FakeElement {
        constructor(text, value) {
            super("option");
            this.textContent = text;
            this.value = value;
        }
    }

    const window = {
        location: { search: "", ...location, assign: (url) => redirects.push(url) },
        confirm: () => true
    };
    const context = vm.createContext({
        window,
        document,
        fetch,
        Option,
        console,
        URLSearchParams,
        sessionStorage: {
            getItem: (key) => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        setInterval: (callback, delay) => intervals.push({ callback, delay }) - 1,
        clearInterval: (id) => { if (intervals[id]) intervals[id].cleared = true; },
        Date: PageDate,
        JSON,
        Number,
        String,
        Boolean,
        Error,
        Promise
    });
    context.globalThis = context;
    window.MabelApiResponse = undefined;

    for (const scriptPath of ["../../js/api-response.js", "./controle-state.js", ...scriptPaths]) {
        const file = path.resolve(__dirname, scriptPath);
        vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    }
    for (const name of ["MabelApiResponse", "MabelControleState"]) window[name] = context[name];

    return {
        element: getElement,
        durationButtons,
        requests,
        redirects,
        storage,
        start() {
            for (const listener of documentListeners.DOMContentLoaded || []) listener();
        },
        pending(fragment) {
            return requests.filter((request) => !request.settled && request.url.includes(fragment));
        },
        async respond(fragment, status, body) {
            const [request] = this.pending(fragment);
            if (!request) throw new Error(`Nenhuma requisição pendente para ${fragment}`);
            request.settled = true;
            request.resolve(jsonResponse(status, body));
            await flush();
        },
        async fail(fragment) {
            const [request] = this.pending(fragment);
            if (!request) throw new Error(`Nenhuma requisição pendente para ${fragment}`);
            request.settled = true;
            request.reject(new TypeError("Failed to fetch"));
            await flush();
        },
        async poll() {
            for (const interval of intervals.filter((item) => item.delay === 3000 && !item.cleared)) interval.callback();
            await flush();
        },
        // Avança o relógio da página e executa o intervalo de 1 s do cronômetro.
        async tick(milliseconds = 1000) {
            currentTime += milliseconds;
            for (const interval of intervals.filter((item) => item.delay === 1000 && !item.cleared)) interval.callback();
            await flush();
        }
    };
}

async function flush() {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
}

function session(overrides = {}) {
    return {
        id: "1",
        tipo_sessao: "real",
        estado: "concluida",
        encerramento: "confirmado",
        device_id: "mabel-esp32-01",
        command_id: "10",
        fisico: false,
        intensidade_geral: 40,
        motores: [40, 40, 40, 40, 40],
        duracao_solicitada_s: 120,
        inicio_em: "2026-10-21T14:03:12.000Z",
        termino_em: "2026-10-21T14:05:12.000Z",
        criado_em: "2026-10-21T14:03:11.840Z",
        ...overrides
    };
}

function history(petId, sessoes, maisRegistros = false) {
    return { sucesso: true, pet_id: petId, limite: 50, mais_registros: maisRegistros, sessoes };
}

module.exports = { createPage, flush, session, history };
