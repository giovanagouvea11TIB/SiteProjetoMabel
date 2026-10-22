const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createPage, session, history } = require("../controle/page-test-dom");

const html = fs.readFileSync(path.join(__dirname, "diario.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "diario.js"), "utf8");
const DIARY_SCRIPT = path.join(__dirname, "diario.js");
const PETS = { sucesso: true, pets: [{ id: 22, nome: "Mel" }, { id: 23, nome: "Thor" }] };

async function startDiario(pets = PETS) {
    const page = createPage([DIARY_SCRIPT]);
    page.start();
    await page.respond("/api/perfil/pet", 200, pets);
    return page;
}

function recordCount(page) {
    return page.element("diary-sessions-list").childElementCount;
}

test("o Diário lista as sessões reais do animal selecionado com intensidade, duração solicitada e modo", async () => {
    const page = await startDiario();
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [
        session({ id: "3", fisico: false }),
        session({ id: "2", fisico: true, estado: "sem_confirmacao", encerramento: "inferido", termino_em: null }),
        session({ id: "1", fisico: null, device_id: "<b>mabel</b>" })
    ]));

    assert.equal(page.element("diary-sessions-empty-state").hidden, true);
    assert.equal(page.element("diary-sessions-list").hidden, false);
    assert.equal(recordCount(page), 3);
    const text = page.element("diary-sessions-list").textContent;
    assert.match(text, /40% nos cinco motores/);
    assert.match(text, /2 min \(solicitada\)/);
    assert.match(text, /Simulação: nenhum motor foi acionado/);
    assert.match(text, /Acionamento físico \(declarado pela ESP32\)/);
    assert.match(text, /Modo não informado/);
    assert.match(text, /Sem confirmação de término/);
    assert.match(text, /Inferido pela perda de comunicação; a ESP32 não confirmou/);
    assert.match(text, /ESP32 · <b>mabel<\/b>/, "dados da API são exibidos como texto");

    assert.equal(page.element("diary-summary").hidden, false);
    assert.equal(page.element("diary-summary-count").textContent, "3 sessões reais registradas.");
    assert.equal(page.element("diary-stat-total").textContent, "3");
    assert.equal(page.element("diary-stat-simulacao").textContent, "1");
    assert.equal(page.element("diary-stat-fisico").textContent, "1");
    assert.equal(page.element("diary-stat-inferidas").textContent, "1");
});

test("o Diário exibe o término registrado e não inventa horários ausentes", async () => {
    const page = await startDiario();
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [
        session({ id: "3", termino_em: "2026-10-21T14:05:12.000Z" }),
        session({ id: "2", estado: "sem_confirmacao", encerramento: "inferido", termino_em: null }),
        session({ id: "1", estado: "ativa", encerramento: null, termino_em: null })
    ]));

    const terms = page.element("diary-sessions-list")
        .findAll((node) => node.tagName === "DT" && node.textContent === "Término registrado")
        .length;
    assert.equal(terms, 3, "cada sessão mostra o campo de término");

    const [finished, inferred, active] = page.element("diary-sessions-list").children.map((item) => item.textContent);
    const expected = new Date("2026-10-21T14:05:12.000Z").toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    assert.match(finished, new RegExp(`Término registrado ${expected.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    assert.match(expected, /^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/, "data e hora em pt-BR");
    assert.match(inferred, /Término registrado Horário não registrado/, "a inferência não ganha horário");
    assert.match(active, /Término registrado Ainda não informado/);
});

test("com mais_registros o Diário deixa claro que conta apenas os registros carregados", async () => {
    const page = await startDiario();
    const sessoes = Array.from({ length: 50 }, (_, index) => session({ id: String(60 - index) }));
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", sessoes, true));
    assert.equal(page.element("diary-stat-total").textContent, "50+");
    assert.match(
        page.element("diary-summary-count").textContent,
        /^Exibindo as 50 sessões reais mais recentes\. Há registros anteriores que não foram carregados\. Os totais abaixo consideram apenas os registros carregados\.$/
    );
});

test("o Diário mostra histórico vazio, falhas e trocas rápidas de animal sem misturar registros", async () => {
    const page = await startDiario();
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", []));
    assert.equal(page.element("diary-sessions-empty").textContent, "Nenhuma sessão real foi registrada para Mel.");
    assert.equal(page.element("diary-chart-empty").textContent, "Ainda não há sessões reais de Mel para resumir.");
    assert.equal(page.element("diary-summary").hidden, true);
    assert.equal(page.element("diary-sessions-list").hidden, true);

    const selector = page.element("diary-pet-selector");
    assert.equal(selector.hidden, false, "o seletor continua disponível com mais de um animal");
    selector.value = "23";
    selector.dispatch("change");
    assert.equal(page.element("diary-sessions-empty").textContent, "Carregando as sessões reais de Thor...");
    selector.value = "22";
    selector.dispatch("change");
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, history("22", [session({ id: "9" })]));
    await page.respond("/api/mabel/sessoes?pet_id=23", 200, history("23", [session({ id: "7" }), session({ id: "8" })]));
    assert.equal(recordCount(page), 1, "a resposta atrasada de Thor é ignorada");
    assert.equal(page.storage.get("mabel.selectedPetId"), "22");

    selector.value = "23";
    selector.dispatch("change");
    assert.equal(recordCount(page), 0, "os registros de Mel somem enquanto Thor carrega");
    await page.fail("/api/mabel/sessoes?pet_id=23");
    assert.equal(page.element("diary-sessions-error").hidden, false);
    assert.match(page.element("diary-sessions-error").textContent, /Não foi possível conectar ao servidor/);
    assert.equal(page.element("diary-sessions-empty").textContent, "As sessões reais de Thor não puderam ser carregadas.");
    assert.equal(recordCount(page), 0);

    selector.value = "22";
    selector.dispatch("change");
    assert.equal(page.element("diary-sessions-error").hidden, true);
    await page.respond("/api/mabel/sessoes?pet_id=22", 200, { sucesso: true, pet_id: "22", sessoes: null });
    assert.equal(page.element("diary-sessions-error").textContent, "A resposta do histórico de sessões é inválida.");
    assert.equal(recordCount(page), 0);
});

test("o Diário redireciona quando a sessão expira e trata conta sem animais", async () => {
    const expired = await startDiario();
    await expired.respond("/api/mabel/sessoes?pet_id=22", 401, { sucesso: false });
    assert.deepEqual(expired.redirects, ["/pages/login/login.html"]);

    const empty = await startDiario({ sucesso: true, pets: [] });
    assert.equal(empty.pending("/api/mabel/sessoes").length, 0);
    assert.equal(empty.element("diary-sessions-empty").textContent, "Nenhum animal está cadastrado nesta conta.");
    assert.equal(empty.element("diary-profile-link").hidden, false);
});

test("o Diário mostra a faixa de demonstração somente quando identifica a API simulada", async () => {
    const LIVE_SERVER = { port: "5500", hostname: "127.0.0.1" };
    const bannerFor = async (location, pets) => {
        const page = createPage([DIARY_SCRIPT], { location });
        page.start();
        assert.equal(page.element("ambiente-demonstracao").hidden, true, "a faixa começa oculta");
        await page.respond("/api/perfil/pet", 200, pets);
        return page.element("ambiente-demonstracao").hidden;
    };
    assert.equal(await bannerFor(LIVE_SERVER, { ...PETS, demonstracao: true }), false);
    assert.equal(await bannerFor(LIVE_SERVER, PETS), true, "API real no Live Server: sem faixa");
    assert.equal(await bannerFor(undefined, { ...PETS, demonstracao: true }), true, "site publicado: sem faixa");
    assert.equal(await bannerFor({ port: "5500", hostname: "10.0.0.5" }, { ...PETS, demonstracao: true }), true);

    const banner = html.match(/<p class="demo-environment-banner" id="ambiente-demonstracao"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(banner);
    assert.match(banner[0], /\shidden>/);
    assert.equal(
        banner[1].replace(/<[^>]+>/g, ""),
        "AMBIENTE DE DEMONSTRAÇÃO — Os dados apresentados são fictícios. Nenhum comando é enviado à ESP32."
    );
});

test("a página do Diário separa os dados reais da demonstração e não faz afirmações clínicas", () => {
    assert.match(html, /<script src="\.\.\/controle\/controle-state\.js"><\/script>\s*<script src="\.\/diario\.js"><\/script>/);
    for (const id of ["diary-sessions-list", "diary-summary", "diary-sessions-error"]) {
        assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), id);
    }
    assert.match(html, /id="diary-sessions-error"[^>]*role="alert"/);
    assert.match(html, /não mede tremores nem avalia evolução clínica/);
    assert.match(html, /não a duração realizada/);
    const realIndex = html.indexOf('id="diary-sessions-list"');
    const demoIndex = html.indexOf('id="diario-demo"');
    assert.ok(realIndex > 0 && demoIndex > realIndex);

    assert.match(script, /\/api\/mabel\/sessoes\?pet_id=/);
    assert.match(script, /response\.status === 401/);
    assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|MabelDemo|<svg|canvas/);
    const visibleText = `${html} ${script}`;
    assert.doesNotMatch(visibleText, /melhor(a|ou)|redu(z|ção|ziu) (d|o)s? tremor|diagn[oó]stic/i);
});
