// Interface do modo demonstração (Controle da Órtese e Diário de Evolução).
// Apenas monta elementos na página a partir de window.MabelDemo: não faz requisições,
// não grava dados e não interage com os controles reais dos motores.
document.addEventListener("DOMContentLoaded", () => {
    const Demo = window.MabelDemo;
    const SVG_NS = "http://www.w3.org/2000/svg";
    if (!Demo) return;

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attrs)) {
            if (name === "text") node.textContent = value;
            else node.setAttribute(name, value);
        }
        for (const child of [].concat(children)) {
            if (child) node.append(child);
        }
        return node;
    }

    function svg(tag, attrs = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
    }

    function banner() {
        return el("div", { class: "demo-banner", role: "note" }, [
            el("strong", { class: "demo-banner-title", text: Demo.AVISO }),
            el("p", {
                text: "Sessões simuladas para apresentação acadêmica. Não foram enviadas à ESP32, "
                    + "não acionaram motores e não estão salvas no banco de dados."
            })
        ]);
    }

    function statusBadge(sessao) {
        return el("span", {
            class: `demo-badge demo-badge--${sessao.estado}`,
            text: Demo.ESTADOS[sessao.estado]
        });
    }

    function field(label, value, extraClass = "") {
        return el("div", { class: `demo-field ${extraClass}`.trim() }, [
            el("dt", { text: label }),
            el("dd", { text: value })
        ]);
    }

    function petLine() {
        return el("p", { class: "demo-pet" }, [
            el("span", { class: "demo-pet-label", text: "Animal" }),
            el("span", { class: "demo-pet-name", text: Demo.PET.descricao })
        ]);
    }

    // ---------- Controle da Órtese ----------

    function motorsRow(sessao) {
        const list = el("ul", { class: "demo-motors", "aria-label": "Estado simulado dos cinco motores" });
        for (const motor of Demo.motoresDaSessao(sessao)) {
            const item = el("li", {
                class: `demo-motor${motor.intensidade ? "" : " is-idle"}`,
                "aria-label": motor.intensidade
                    ? `${motor.nome}: ${motor.intensidade}%, comando ${motor.comando}`
                    : `${motor.nome}: ${motor.comando}`
            }, [
                el("span", { class: "demo-motor-name", text: motor.nome, "aria-hidden": "true" }),
                el("span", { class: "demo-motor-bar", "aria-hidden": "true" }, [
                    el("span", { style: `--level: ${motor.intensidade}%` })
                ])
            ]);
            list.append(item);
        }
        return list;
    }

    function controlSessionCard(sessao) {
        return el("li", { class: "demo-session" }, [
            el("article", { "aria-labelledby": `${sessao.id}-titulo` }, [
                el("header", { class: "demo-session-header" }, [
                    el("div", {}, [
                        el("h3", { id: `${sessao.id}-titulo`, text: Demo.nomeSessao(sessao) }),
                        el("p", {
                            class: "demo-session-when",
                            text: `${Demo.formatarData(sessao.inicio)} · ${Demo.formatarHorario(sessao.inicio)}`
                        })
                    ]),
                    statusBadge(sessao)
                ]),
                el("dl", { class: "demo-fields" }, [
                    field("Animal", Demo.PET.descricao),
                    field("Intensidade", Demo.descreverNivel(sessao.nivel)),
                    field("Duração configurada", Demo.formatarDuracao(sessao.duracaoConfiguradaS)),
                    field("Duração simulada", Demo.formatarDuracao(sessao.duracaoSimuladaS)),
                    field("Tipo", "Simulação"),
                    field("Confirmação da ESP32", "Não se aplica (sem hardware)")
                ]),
                el("div", { class: "demo-motors-block" }, [
                    el("p", { class: "demo-motors-title", text: Demo.descreverMotores(sessao) }),
                    motorsRow(sessao)
                ]),
                el("p", { class: "demo-reason", text: sessao.motivo })
            ])
        ]);
    }

    function renderControle(container) {
        const list = el("ol", { class: "demo-session-list", "aria-label": "Sessões demonstrativas" });
        for (const sessao of Demo.SESSOES) list.append(controlSessionCard(sessao));
        container.replaceChildren(banner(), petLine(), list);
    }

    // ---------- Diário de Evolução ----------

    function statTile(label, value) {
        return el("div", { class: "demo-stat" }, [
            el("dt", { text: label }),
            el("dd", { text: value })
        ]);
    }

    function summaryTiles() {
        const r = Demo.resumo();
        return el("dl", { class: "demo-stats", "aria-label": "Resumo das sessões demonstrativas" }, [
            statTile("Sessões", String(r.total)),
            statTile("Concluídas", `${r.concluidas} de ${r.total}`),
            statTile("Tempo simulado", Demo.formatarDuracao(r.tempoSimuladoS)),
            statTile("Detecções SW-420", String(r.deteccoesSw420))
        ]);
    }

    // Gráfico de barras: detecções fictícias do SW-420 por sessão (uma série, um eixo).
    // É desenhado na largura real do quadro, para os textos manterem o tamanho em qualquer tela.
    function drawChart(frame, tooltip) {
        const width = Math.max(280, Math.round(frame.clientWidth) || 640);
        const height = width < 480 ? 240 : 280;
        const margin = { top: 20, right: 8, bottom: 54, left: 34 };
        const plotW = width - margin.left - margin.right;
        const plotH = height - margin.top - margin.bottom;
        const sessoes = Demo.SESSOES;
        const maxValue = Math.max(20, Math.ceil(Math.max(...sessoes.map((s) => s.deteccoesSw420)) / 20) * 20);
        const step = plotW / sessoes.length;
        const barW = Math.min(44, step * 0.5);
        const y = (value) => margin.top + plotH - (value / maxValue) * plotH;

        const chart = svg("svg", {
            class: "demo-chart-svg",
            viewBox: `0 0 ${width} ${height}`,
            role: "img",
            "aria-labelledby": "demo-chart-title demo-chart-desc"
        });
        const title = svg("title", { id: "demo-chart-title" });
        title.textContent = "Detecções do SW-420 por sessão (dados fictícios)";
        const desc = svg("desc", { id: "demo-chart-desc" });
        desc.textContent = sessoes.map((s) =>
            `${Demo.nomeSessao(s)}, ${Demo.formatarData(s.inicio)}: ${s.deteccoesSw420} detecções`).join("; ");
        chart.append(title, desc);

        for (let value = 0; value <= maxValue; value += 20) {
            chart.append(svg("line", {
                class: value === 0 ? "demo-chart-baseline" : "demo-chart-grid",
                x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value)
            }));
            const label = svg("text", { class: "demo-chart-axis", x: margin.left - 8, y: y(value) + 4, "text-anchor": "end" });
            label.textContent = String(value);
            chart.append(label);
        }

        const showTip = (sessao, cx) => {
            tooltip.replaceChildren(
                el("strong", { text: Demo.nomeSessao(sessao) }),
                el("span", { text: `${Demo.formatarData(sessao.inicio)} · ${Demo.formatarHorario(sessao.inicio)}` }),
                el("span", { text: `${sessao.deteccoesSw420} detecções (fictício)` }),
                el("span", { text: `${Demo.descreverNivel(sessao.nivel)} · ${Demo.ESTADOS[sessao.estado]}` })
            );
            // Limita a posição para o balão não sair do quadro nas barras das pontas.
            tooltip.style.left = `${Math.min(70, Math.max(30, (cx / width) * 100))}%`;
            tooltip.hidden = false;
        };
        const hideTip = () => { tooltip.hidden = true; };

        sessoes.forEach((sessao, index) => {
            const cx = margin.left + step * index + step / 2;
            const top = y(sessao.deteccoesSw420);
            const h = margin.top + plotH - top;
            const x = cx - barW / 2;
            const r = Math.min(4, h);
            if (h > 0) {
                chart.append(svg("path", {
                    class: `demo-chart-bar demo-chart-bar--${sessao.estado}`,
                    d: `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`
                }));
            } else {
                const none = svg("text", { class: "demo-chart-none", x: cx, y: y(0) - 8, "text-anchor": "middle" });
                none.textContent = "sem sessão";
                chart.append(none);
            }
            const date = svg("text", { class: "demo-chart-axis", x: cx, y: height - margin.bottom + 20, "text-anchor": "middle" });
            date.textContent = Demo.formatarDataCurta(sessao.inicio);
            const name = svg("text", { class: "demo-chart-axis demo-chart-axis--muted", x: cx, y: height - margin.bottom + 38, "text-anchor": "middle" });
            name.textContent = `S${String(sessao.numero).padStart(2, "0")}`;
            const hit = svg("rect", {
                class: "demo-chart-hit",
                x: cx - step / 2, y: margin.top, width: step, height: plotH,
                tabindex: "0",
                "aria-label": `${Demo.nomeSessao(sessao)}: ${sessao.deteccoesSw420} detecções`
            });
            hit.addEventListener("mouseenter", () => showTip(sessao, cx));
            hit.addEventListener("focus", () => showTip(sessao, cx));
            hit.addEventListener("mouseleave", hideTip);
            hit.addEventListener("blur", hideTip);
            chart.append(date, name, hit);
        });

        tooltip.hidden = true;
        frame.replaceChildren(chart, tooltip);
        return width;
    }

    function detectionsChart() {
        const frame = el("div", { class: "demo-chart-frame" });
        const tooltip = el("div", { class: "demo-tooltip", role: "status", hidden: "" });
        let drawnWidth = 0;
        const redraw = () => {
            if (frame.clientWidth && Math.abs(frame.clientWidth - drawnWidth) > 8) drawnWidth = drawChart(frame, tooltip);
        };
        if (typeof ResizeObserver === "function") new ResizeObserver(redraw).observe(frame);
        else window.addEventListener("resize", redraw);
        requestAnimationFrame(redraw);
        return el("figure", { class: "demo-chart" }, [
            el("figcaption", {}, [
                el("strong", { text: "Detecções do SW-420 por sessão" }),
                el("span", { text: "Contagem fictícia de pulsos digitais do sensor; não representa medida clínica." })
            ]),
            frame
        ]);
    }

    function diaryRecord(sessao) {
        return el("li", { class: "demo-record" }, [
            el("article", { "aria-labelledby": `${sessao.id}-registro` }, [
                el("header", { class: "demo-session-header" }, [
                    el("div", {}, [
                        el("h3", { id: `${sessao.id}-registro`, text: Demo.nomeSessao(sessao) }),
                        el("p", {
                            class: "demo-session-when",
                            text: `${Demo.formatarData(sessao.inicio)} · ${Demo.formatarHorario(sessao.inicio)}`
                        })
                    ]),
                    statusBadge(sessao)
                ]),
                el("dl", { class: "demo-fields" }, [
                    field("Intensidade configurada", Demo.descreverNivel(sessao.nivel)),
                    field("Tempo da sessão",
                        `${Demo.formatarDuracao(sessao.duracaoSimuladaS)} de ${Demo.formatarDuracao(sessao.duracaoConfiguradaS)}`),
                    field("Detecções SW-420", `${sessao.deteccoesSw420} (fictício)`)
                ]),
                el("p", { class: "demo-reason", text: sessao.observacao })
            ])
        ]);
    }

    function renderDiario(container) {
        const list = el("ol", { class: "demo-record-list", "aria-label": "Registros demonstrativos" });
        for (const sessao of Demo.SESSOES) list.append(diaryRecord(sessao));
        container.replaceChildren(banner(), petLine(), summaryTiles(), detectionsChart(), list);
    }

    // ---------- Abrir e fechar ----------

    const RENDERERS = { controle: renderControle, diario: renderDiario };
    let openFromUrl = false;
    try {
        openFromUrl = new URLSearchParams(window.location.search).get("demo") === "1";
    } catch {
        openFromUrl = false;
    }

    for (const section of document.querySelectorAll("[data-demo-view]")) {
        const render = RENDERERS[section.dataset.demoView];
        const toggle = section.querySelector("[data-demo-toggle]");
        const content = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
        if (!render || !content) continue;

        const setOpen = (open) => {
            content.hidden = !open;
            if (open && !content.hasChildNodes()) render(content);
            toggle.setAttribute("aria-expanded", String(open));
            toggle.textContent = open ? "Ocultar sessões demonstrativas" : "Ver sessões demonstrativas";
        };

        toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
        setOpen(openFromUrl);
    }
});
