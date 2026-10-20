const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const Demo = require("./sessoes-demo");

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), "utf8");
const DURACOES_DO_CONTROLE = [30, 60, 120, 300, 600];

test("sessões demonstrativas cobrem estados, intensidades e durações do Controle", () => {
    assert.equal(Demo.PET.descricao, "Mel (fictício)");
    assert.deepEqual(new Set(Demo.SESSOES.map((s) => s.estado)), new Set(["concluida", "interrompida", "cancelada"]));
    assert.ok(new Set(Demo.SESSOES.map((s) => s.nivel)).size >= 3, "intensidades variadas");
    assert.ok(new Set(Demo.SESSOES.map((s) => s.duracaoConfiguradaS)).size >= 3, "durações variadas");

    for (const sessao of Demo.SESSOES) {
        assert.ok(Number.isInteger(sessao.nivel) && sessao.nivel >= 1 && sessao.nivel <= Demo.NIVEIS, sessao.id);
        assert.ok(DURACOES_DO_CONTROLE.includes(sessao.duracaoConfiguradaS), `${sessao.id}: duração oferecida no Controle`);
        assert.ok(sessao.duracaoSimuladaS <= sessao.duracaoConfiguradaS, sessao.id);
        if (sessao.estado === "concluida") assert.equal(sessao.duracaoSimuladaS, sessao.duracaoConfiguradaS, sessao.id);
        if (sessao.estado === "interrompida") assert.ok(sessao.duracaoSimuladaS > 0 && sessao.duracaoSimuladaS < sessao.duracaoConfiguradaS, sessao.id);
        if (sessao.estado === "cancelada") {
            assert.equal(sessao.duracaoSimuladaS, 0, sessao.id);
            assert.equal(sessao.deteccoesSw420, 0, `${sessao.id}: sem sessão não há leituras`);
        }
        assert.ok(Object.isFrozen(sessao), "dados demonstrativos são somente leitura");
    }
});

test("a sessão 01 corresponde ao exemplo combinado e os textos são formatados em pt-BR", () => {
    const primeira = Demo.SESSOES[0];
    assert.equal(Demo.nomeSessao(primeira), "Sessão demonstrativa 01");
    assert.equal(Demo.formatarData(primeira.inicio), "15/10/2026");
    assert.equal(Demo.formatarHorario(primeira.inicio), "14h30");
    assert.equal(Demo.descreverNivel(primeira.nivel), "Nível 2 de 5 (40%)");
    assert.equal(Demo.formatarDuracao(primeira.duracaoConfiguradaS), "5 min");
    assert.equal(Demo.ESTADOS[primeira.estado], "Concluída");
    assert.match(Demo.descreverMotores(primeira), /Cinco módulos, comando sincronizado a 40% \(simulação\)/);
    assert.equal(Demo.formatarDuracao(80), "1 min 20 s");
    assert.equal(Demo.formatarDuracao(30), "30 s");
});

test("os cinco motores recebem a mesma intensidade e a sessão cancelada não envia comando", () => {
    const concluida = Demo.motoresDaSessao(Demo.SESSOES[1]);
    assert.deepEqual(concluida.map((m) => m.nome), ["M1", "M2", "M3", "M4", "M5"]);
    assert.ok(concluida.every((m) => m.intensidade === 60 && m.comando === "sincronizado"));
    const cancelada = Demo.SESSOES.find((s) => s.estado === "cancelada");
    assert.ok(Demo.motoresDaSessao(cancelada).every((m) => m.intensidade === 0 && m.comando === "sem comando"));
});

test("o resumo do Diário é calculado a partir das mesmas sessões do Controle", () => {
    const r = Demo.resumo();
    assert.equal(r.total, Demo.SESSOES.length);
    assert.equal(r.concluidas + r.interrompidas + r.canceladas, r.total);
    assert.equal(r.tempoSimuladoS, Demo.SESSOES.reduce((t, s) => t + s.duracaoSimuladaS, 0));
    assert.equal(r.deteccoesSw420, Demo.SESSOES.reduce((t, s) => t + s.deteccoesSw420, 0));
});

test("textos demonstrativos são identificados como fictícios e não fazem alegações clínicas", () => {
    assert.equal(Demo.AVISO, "DADOS FICTÍCIOS — DEMONSTRAÇÃO");
    const textos = [read("sessoes-demo.js"), read("demo-ui.js")].join("\n");
    assert.doesNotMatch(textos, /melhor(a|ou)|diagn[oó]stic|tratamento|cura|redu(z|ção|ziu) (d|o)s? tremor/i);
    for (const sessao of Demo.SESSOES) assert.match(sessao.observacao, /^Registro fictício:/);
    assert.match(read("demo-ui.js"), /não representa medida clínica/);
});

test("o modo demonstração não usa rede nem toca nos controles reais dos motores", () => {
    for (const arquivo of ["sessoes-demo.js", "demo-ui.js"]) {
        const fonte = read(arquivo);
        assert.doesNotMatch(fonte, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\/api\//, arquivo);
        assert.doesNotMatch(fonte, /innerHTML|insertAdjacentHTML|document\.write/, arquivo);
        assert.doesNotMatch(fonte, /motor-ligar-btn|motor-desligar-btn|controle-associar|localStorage|sessionStorage/, arquivo);
    }
});

test("Controle e Diário carregam a mesma fonte de dados em uma seção própria, separada do histórico real", () => {
    for (const [pagina, prefixo] of [["../controle/controle.html", "controle"], ["../diario/diario.html", "diario"]]) {
        const html = read(pagina);
        assert.match(html, /<link rel="stylesheet" href="\.\.\/demo\/demo\.css">/, pagina);
        assert.match(html, /<script src="\.\.\/demo\/sessoes-demo\.js"><\/script>\s*<script src="\.\.\/demo\/demo-ui\.js"><\/script>/, pagina);
        assert.match(html, new RegExp(`id="${prefixo}-demo" data-demo-view="${prefixo}"`), pagina);
        assert.match(html, new RegExp(`id="${prefixo}-demo-toggle" data-demo-toggle\\s+aria-expanded="false" aria-controls="${prefixo}-demo-conteudo"`), pagina);
        assert.match(html, new RegExp(`id="${prefixo}-demo-conteudo" hidden`), pagina);
    }
    // Os estados vazios reais continuam presentes e independentes da demonstração.
    assert.match(read("../controle/controle.html"), /Não há sessões reais disponíveis para exibição/);
    assert.match(read("../diario/diario.html"), /id="diary-sessions-empty"/);
});
