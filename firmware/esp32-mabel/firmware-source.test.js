const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const firmware = fs.readFileSync(path.join(__dirname, "esp32-mabel.ino"), "utf8");
const configExample = fs.readFileSync(path.join(__dirname, "mabel_config.example.h"), "utf8");

function functionBody(signature) {
    const start = firmware.indexOf(signature);
    assert.ok(start >= 0, `${signature} existe`);
    const open = firmware.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < firmware.length; index++) {
        if (firmware[index] === "{") depth++;
        if (firmware[index] === "}" && --depth === 0) return firmware.slice(open, index + 1);
    }
    throw new Error(`Corpo de ${signature} incompleto.`);
}

test("pinos previstos e acionamento físico bloqueado por padrão", () => {
    assert.match(firmware, /SENSOR_PIN = 13;/);
    assert.match(firmware, /LED_PIN = 14;/);
    assert.match(firmware, /MOTOR_PINS\[\] = \{32, 33, 25, 26, 27\};/);
    assert.match(firmware, /constexpr bool MOTORS_PHYSICAL_ENABLED = false;/);
    assert.match(functionBody("void holdMotorOutputsLow()"), /digitalWrite\(pin, LOW\)/);
    assert.ok(
        firmware.indexOf("holdMotorOutputsLow();") < firmware.indexOf("Serial.begin(115200);"),
        "as saídas dos motores vão para LOW antes de qualquer outra inicialização"
    );
});

test("em simulação nenhuma saída recebe PWM e a confirmação informa fisico corretamente", () => {
    assert.match(functionBody("bool motorsArePhysical()"), /return MOTORS_PHYSICAL_ENABLED && motorHardwareReady;/);
    const setup = functionBody("void setupMotorPwm()");
    assert.ok(setup.indexOf("if (!MOTORS_PHYSICAL_ENABLED)") < setup.indexOf("ledcAttach"), "PWM só é configurado com acionamento físico");
    const write = functionBody("void writeOutputs(uint32_t duty)");
    assert.match(write, /if \(motorsArePhysical\(\)\) \{[\s\S]*ledcWrite[\s\S]*\} else \{[\s\S]*digitalWrite\(pin, LOW\)/);
    assert.equal((firmware.match(/ledcWrite\(/g) || []).length, 2, "ledcWrite só em setupMotorPwm (zerar) e writeOutputs");
    assert.match(functionBody("void sendPendingAck()"), /doc\["fisico"\] = motorsArePhysical\(\);/);
});

test("o SW-420 apenas registra vibração e nunca aciona os motores", () => {
    const sensor = functionBody("void updateSensor()");
    assert.doesNotMatch(sensor, /controller|writeOutputs|ledcWrite|applyOutputs/);
    assert.match(sensor, /detectionCount\+\+/);
});

test("HTTPS valida o certificado, limita o handshake, sincroniza NTP e não usa setInsecure", () => {
    assert.doesNotMatch(firmware, /setInsecure/);
    assert.match(firmware, /secureClient\.setCACert\(MABEL_ROOT_CA\)/);
    assert.match(firmware, /secureClient\.setHandshakeTimeout\(TLS_HANDSHAKE_TIMEOUT_S\)/);
    assert.match(firmware, /TLS_HANDSHAKE_TIMEOUT_S = 8;/);
    assert.match(firmware, /url\.startsWith\("https:\/\/"\)/);
    assert.match(firmware, /configTime\(0, 0, "pool\.ntp\.org", "time\.google\.com"\)/);
    assert.match(firmware, /WiFi\.setAutoReconnect\(false\)/);
    assert.match(configExample, /REPLACE_WITH_ROOT_CA_CERTIFICATE/);
    assert.match(configExample, /PREENCHA_COM_O_MESMO_TOKEN/);
    assert.doesNotMatch(configExample, /PRIVATE KEY/);
});

test("proteção de segurança independe das requisições de rede", () => {
    const task = functionBody("void motorSafetyTask(void *)");
    assert.match(task, /controller\.enforceSafety\(millis\(\), wifiConnected\)/);
    assert.match(task, /vTaskDelay\(pdMS_TO_TICKS\(SAFETY_PERIOD_MS\)\)/);
    assert.match(task, /esp_task_wdt_reset\(\)/);
    assert.doesNotMatch(task, /HTTPClient|beginRequest|http\./, "a tarefa de segurança não faz rede");
    assert.match(firmware, /xTaskCreatePinnedToCore\(motorSafetyTask, "mabel_safety", 4096, nullptr, 3, nullptr, 1\)/);
    assert.match(firmware, /SAFETY_PERIOD_MS = 50;/);

    // Nenhuma requisição de rede acontece com o mutex dos motores travado.
    for (const name of ["void fetchConfig()", "void sendPendingAck()"]) {
        const body = functionBody(name);
        const segments = body.split("xSemaphoreTake(motorMutex");
        for (const segment of segments.slice(1)) {
            const locked = segment.slice(0, segment.indexOf("xSemaphoreGive(motorMutex)"));
            assert.doesNotMatch(locked, /http\.|beginRequest|\.GET\(|\.POST\(/, `${name} não faz rede com o mutex travado`);
        }
    }
});

test("contrato de rede com o backend", () => {
    assert.match(firmware, /"\/api\/mabel\/config\?device_id="/);
    assert.match(firmware, /"\/api\/mabel\/motores\/confirmacao"/);
    assert.match(firmware, /"\/api\/mabel\/dados"/);
    const fetch = functionBody("void fetchConfig()");
    for (const field of ["command_id", "estado_comando", "ligado", "intensidade", "duracao_restante_ms", "intervalo_consulta_ms"]) {
        assert.match(fetch, new RegExp(`"${field}"`), field);
    }
    assert.match(fetch, /controller\.handleConfigHttpError\(code\)/);
});
