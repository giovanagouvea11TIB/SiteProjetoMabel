// Projeto Mabel - firmware ESP-WROOM-32
// SW-420 (GPIO 13), LED (GPIO 14) e cinco módulos de motor vibratório V919 (GPIO 32, 33, 25, 26, 27).
// Requer: Arduino ESP32 Core 3.3.12, ArduinoJson 7 e o arquivo local mabel_config.h (não versionado).

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <time.h>

#include "mabel_config.h"

// ====================== CONFIGURAÇÃO DE ACIONAMENTO ======================
// false = SIMULAÇÃO: os comandos são processados e confirmados com "fisico": false,
// mas as cinco saídas permanecem em LOW. Só altere para true depois da validação
// elétrica dos módulos V919, da fonte de alimentação e dos limites de segurança.
constexpr bool MOTORS_PHYSICAL_ENABLED = false;
// Frequência e resolução do PWM. 1 kHz é o ponto de partida para módulos com
// transistor; ajuste somente depois de caracterizar o módulo real.
constexpr uint32_t MOTOR_PWM_FREQUENCY_HZ = 1000;
constexpr uint8_t MOTOR_PWM_RESOLUTION_BITS = 8;
// Percentual mínimo de PWM para o motor partir (0 = mapeamento linear). Defina após medir o módulo.
constexpr uint8_t MOTOR_MIN_EFFECTIVE_PERCENT = 0;

constexpr uint8_t SENSOR_PIN = 13;
constexpr uint8_t LED_PIN = 14;
constexpr uint8_t MOTOR_PINS[] = {32, 33, 25, 26, 27};
constexpr size_t MOTOR_COUNT = sizeof(MOTOR_PINS) / sizeof(MOTOR_PINS[0]);

constexpr uint32_t SEND_INTERVAL_MS = 5000;
constexpr uint32_t DEFAULT_CONFIG_INTERVAL_MS = 3000;
constexpr uint32_t MIN_CONFIG_INTERVAL_MS = 2000;
constexpr uint32_t MAX_CONFIG_INTERVAL_MS = 10000;
constexpr uint32_t ACK_RETRY_INTERVAL_MS = 1000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
constexpr uint32_t DEBOUNCE_MS = 40;
constexpr uint8_t SENSOR_ACTIVE_LEVEL = LOW;
constexpr int32_t HTTP_CONNECT_TIMEOUT_MS = 5000;
constexpr uint16_t HTTP_RESPONSE_TIMEOUT_MS = 5000;
constexpr unsigned long TLS_HANDSHAKE_TIMEOUT_S = 8;
constexpr uint32_t WATCHDOG_TIMEOUT_MS = 30000;
constexpr uint32_t NTP_WAIT_MS = 15000;
constexpr time_t MIN_VALID_EPOCH = 1735689600;  // 2025-01-01T00:00:00Z
constexpr size_t MAX_LOGGED_BODY_CHARS = 160;
constexpr uint32_t SAFETY_PERIOD_MS = 50;
constexpr uint32_t SAFETY_LOCK_TIMEOUT_MS = 20;
constexpr uint32_t SAFETY_FORCE_OFF_MS = 500;

// ====================== LÓGICA DOS MOTORES (C++ PURO) ======================
// Este bloco não usa nenhuma API do Arduino e é compilado e testado no computador
// (firmware/esp32-mabel/motor-logic.test.js). Mantenha os marcadores.
// MABEL_MOTOR_LOGIC_BEGIN
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace mabel {

constexpr uint32_t COMMUNICATION_TIMEOUT_MS = 10000;
constexpr uint32_t MAX_MOTOR_RUN_MS = 600000;
constexpr size_t COMMAND_ID_CAPACITY = 21;

struct MotorState {
    bool on;
    uint8_t intensity;
};

constexpr MotorState MOTORS_OFF = {false, 0};

enum class CommandState : uint8_t {
    Unknown,
    Pending,
    Applied,
    Completed,
    Expired,
    Rejected,
    Interrupted,
    Superseded
};

inline CommandState parseCommandState(const char *text) {
    if (text == nullptr) return CommandState::Unknown;
    if (strcmp(text, "pendente") == 0) return CommandState::Pending;
    if (strcmp(text, "aplicado") == 0) return CommandState::Applied;
    if (strcmp(text, "concluido") == 0) return CommandState::Completed;
    if (strcmp(text, "expirado") == 0) return CommandState::Expired;
    if (strcmp(text, "rejeitado") == 0) return CommandState::Rejected;
    if (strcmp(text, "interrompido") == 0) return CommandState::Interrupted;
    if (strcmp(text, "substituido") == 0) return CommandState::Superseded;
    return CommandState::Unknown;
}

// Aceita somente o formato enviado pelo backend: dígitos, sem zero à esquerda, até INT64_MAX.
inline bool parseCommandId(const char *text, uint64_t &value) {
    const size_t length = text == nullptr ? 0 : strlen(text);
    if (length == 0 || length > 19 || text[0] < '1' || text[0] > '9') return false;
    uint64_t parsed = 0;
    for (size_t index = 0; index < length; index++) {
        if (text[index] < '0' || text[index] > '9') return false;
        parsed = parsed * 10 + static_cast<uint64_t>(text[index] - '0');
    }
    if (parsed > static_cast<uint64_t>(INT64_MAX)) return false;
    value = parsed;
    return true;
}

// Campos já extraídos da resposta de GET /api/mabel/config.
struct ConfigInput {
    const char *deviceId;
    bool hasCommand;           // command_id diferente de null
    const char *commandId;     // nullptr quando command_id não é string
    const char *commandState;  // estado_comando
    bool motorFieldsPresent;   // ligado booleano, intensidade e duracao_restante_ms inteiros
    bool requestedOn;
    long intensity;
    long remainingMs;
};

struct Ack {
    char commandId[COMMAND_ID_CAPACITY];  // vazio = command_id null
    const char *result;
    const char *reason;
    MotorState state;
};

class MotorController {
public:
    void begin(const char *deviceId) {
        deviceId_ = deviceId;
        motors_ = MOTORS_OFF;
        activeCommand_[0] = '\0';
        lastHandled_ = 0;
        baselinePending_ = true;
        lastConfigOkAt_ = 0;
        offAt_ = 0;
        ackPending_ = false;
        ackSequence_ = 0;
        decision_ = "inicio";
        queueAck("", "interrompido", "reinicio", MOTORS_OFF);
    }

    // Retorna false quando a resposta não é deste dispositivo (nada muda).
    bool handleConfig(const ConfigInput &input, uint32_t nowMs) {
        if (input.deviceId == nullptr || deviceId_ == nullptr || strcmp(input.deviceId, deviceId_) != 0) {
            decision_ = "resposta de outro dispositivo ignorada";
            return false;
        }
        lastConfigOkAt_ = nowMs;

        uint64_t commandId = 0;
        const bool commandIdValid = input.hasCommand && parseCommandId(input.commandId, commandId);
        const CommandState state = parseCommandState(input.commandState);
        const bool valid = input.motorFieldsPresent
            && (!input.hasCommand || (commandIdValid && state != CommandState::Unknown))
            && input.intensity >= 0 && input.intensity <= 100 && input.remainingMs >= 0
            && (input.requestedOn ? (input.intensity >= 1 && input.remainingMs > 0) : input.intensity == 0);

        if (!valid) {
            motors_ = MOTORS_OFF;
            activeCommand_[0] = '\0';
            if (commandIdValid && commandId > lastHandled_) {
                lastHandled_ = commandId;
                queueAck(input.commandId, "rejeitado", "invalido", MOTORS_OFF);
            }
            decision_ = "comando inválido: motores desligados";
            return true;
        }

        if (!input.hasCommand) {
            baselinePending_ = false;
            stop("recusado_servidor", true);
            decision_ = "sem comando: motores desligados";
            return true;
        }

        const bool pending = state == CommandState::Pending;
        if (baselinePending_) {
            // Após reiniciar, nenhum comando anterior é retomado; é preciso um novo comando.
            baselinePending_ = false;
            if (commandId > lastHandled_) lastHandled_ = commandId;
            if (input.requestedOn) {
                queueAck(input.commandId, "interrompido", "reinicio", MOTORS_OFF);
                decision_ = "comando anterior ao reinício não retomado";
            } else {
                if (pending) queueAck(input.commandId, "aplicado", "comando", MOTORS_OFF);
                decision_ = "referência de reinício registrada";
            }
            return true;
        }

        if (commandId < lastHandled_) {
            if (!input.requestedOn) stop("recusado_servidor", true);
            decision_ = "comando antigo ignorado";
            return true;
        }

        if (commandId > lastHandled_) {
            lastHandled_ = commandId;
            if (!pending) {
                stop("recusado_servidor", true);
                decision_ = "comando novo não pendente: nada aplicado";
                return true;
            }
            if (input.requestedOn) {
                motors_ = {true, static_cast<uint8_t>(input.intensity)};
                setActiveCommand(input.commandId);
                offAt_ = nowMs + boundedRun(input.remainingMs);
                decision_ = "comando de ligar aplicado";
            } else {
                motors_ = MOTORS_OFF;
                activeCommand_[0] = '\0';
                decision_ = "comando de desligar aplicado";
            }
            queueAck(input.commandId, "aplicado", "comando", motors_);
            return true;
        }

        // Mesmo comando já tratado: só pode encurtar a duração ou desligar; nunca religa.
        if (!input.requestedOn) {
            stop(state == CommandState::Completed ? "duracao" : "recusado_servidor", true);
            decision_ = "comando atual sem acionamento";
        } else if (motors_.on && strcmp(activeCommand_, input.commandId) == 0) {
            const uint32_t candidate = nowMs + boundedRun(input.remainingMs);
            if (static_cast<int32_t>(candidate - offAt_) < 0) offAt_ = candidate;
            decision_ = "comando atual mantido";
        } else {
            decision_ = "comando interrompido não é retomado";
        }
        return true;
    }

    // Chamado periodicamente pela tarefa de segurança. Retorna o motivo quando desliga.
    const char *enforceSafety(uint32_t nowMs, bool wifiConnected) {
        if (!motors_.on) return nullptr;
        if (static_cast<int32_t>(nowMs - offAt_) >= 0) {
            stop("duracao", true);
            return "duracao";
        }
        if (!wifiConnected || nowMs - lastConfigOkAt_ > COMMUNICATION_TIMEOUT_MS) {
            stop("comunicacao", true);
            return "comunicacao";
        }
        return nullptr;
    }

    // 401, 403 ou 404 em GET /config: não há comando legítimo; desliga sem confirmação.
    void handleConfigHttpError(int httpStatus) {
        if (httpStatus == 401 || httpStatus == 403 || httpStatus == 404) {
            stop("recusado_servidor", false);
            decision_ = "configuração recusada pelo servidor: motores desligados";
        }
    }

    void emergencyStop() {
        stop("comunicacao", true);
    }

    bool peekAck(Ack &ack, uint32_t &sequence) const {
        if (!ackPending_) return false;
        ack = ack_;
        sequence = ackSequence_;
        return true;
    }

    // httpStatus <= 0 indica falha de transporte (nova tentativa).
    void handleAckResponse(uint32_t sequence, const Ack &sent, int httpStatus) {
        if (httpStatus == 409 && strcmp(sent.result, "aplicado") == 0
            && motors_.on && strcmp(activeCommand_, sent.commandId) == 0) {
            stop("recusado_servidor", true);
            decision_ = "aplicação recusada pelo servidor: motores desligados";
            return;
        }
        const bool current = ackPending_ && sequence == ackSequence_;
        if (current && (httpStatus == 200 || (httpStatus >= 400 && httpStatus < 500))) {
            ackPending_ = false;
        }
    }

    const MotorState &motors() const { return motors_; }
    const char *activeCommand() const { return activeCommand_; }
    uint64_t lastHandledCommandId() const { return lastHandled_; }
    uint32_t offAt() const { return offAt_; }
    const char *decision() const { return decision_; }

private:
    static uint32_t boundedRun(long remainingMs) {
        return static_cast<uint32_t>(remainingMs) < MAX_MOTOR_RUN_MS
            ? static_cast<uint32_t>(remainingMs)
            : MAX_MOTOR_RUN_MS;
    }

    void setActiveCommand(const char *commandId) {
        strncpy(activeCommand_, commandId, COMMAND_ID_CAPACITY - 1);
        activeCommand_[COMMAND_ID_CAPACITY - 1] = '\0';
    }

    void stop(const char *reason, bool report) {
        if (!motors_.on) return;
        char commandId[COMMAND_ID_CAPACITY];
        memcpy(commandId, activeCommand_, COMMAND_ID_CAPACITY);
        motors_ = MOTORS_OFF;
        activeCommand_[0] = '\0';
        if (report) queueAck(commandId, "interrompido", reason, MOTORS_OFF);
    }

    void queueAck(const char *commandId, const char *result, const char *reason, const MotorState &state) {
        strncpy(ack_.commandId, commandId, COMMAND_ID_CAPACITY - 1);
        ack_.commandId[COMMAND_ID_CAPACITY - 1] = '\0';
        ack_.result = result;
        ack_.reason = reason;
        ack_.state = state;
        ackPending_ = true;
        ackSequence_++;
    }

    const char *deviceId_ = nullptr;
    MotorState motors_ = MOTORS_OFF;
    char activeCommand_[COMMAND_ID_CAPACITY] = {0};
    uint64_t lastHandled_ = 0;
    bool baselinePending_ = true;
    uint32_t lastConfigOkAt_ = 0;
    uint32_t offAt_ = 0;
    Ack ack_ = {{0}, "", "", MOTORS_OFF};
    bool ackPending_ = false;
    uint32_t ackSequence_ = 0;
    const char *decision_ = "";
};

}  // namespace mabel
// MABEL_MOTOR_LOGIC_END

// ====================== ESTADO COMPARTILHADO ======================

WiFiClientSecure secureClient;
bool rootCaConfigured = false;
bool wifiReportedConnected = false;
uint32_t wifiConnectedAt = 0;
uint32_t lastWiFiAttemptAt = 0;
bool ntpStarted = false;
bool timeSynced = false;
bool ntpWarningShown = false;

bool stableSensorState = false;
bool lastRawSensorState = false;
uint32_t lastSensorChangeAt = 0;
uint32_t detectionCount = 0;
uint32_t lastSendAt = 0;
uint32_t lastConfigAttemptAt = 0;
uint32_t configIntervalMs = DEFAULT_CONFIG_INTERVAL_MS;
uint32_t lastAckAttemptAt = 0;
uint32_t lastAckSequenceAttempted = 0;

// controller e outputState só são acessados com motorMutex.
SemaphoreHandle_t motorMutex = nullptr;
mabel::MotorController controller;
mabel::MotorState outputState = mabel::MOTORS_OFF;
bool motorHardwareReady = false;
volatile bool emergencyOffPending = false;

// ====================== SAÍDAS DOS MOTORES ======================

void holdMotorOutputsLow() {
    // Primeira ação do boot: saídas em LOW para que os módulos permaneçam desligados.
    for (const uint8_t pin : MOTOR_PINS) {
        pinMode(pin, OUTPUT);
        digitalWrite(pin, LOW);
    }
}

bool motorsArePhysical() {
    return MOTORS_PHYSICAL_ENABLED && motorHardwareReady;
}

uint32_t dutyFor(const mabel::MotorState &state) {
    if (!state.on || state.intensity == 0) return 0;
    const uint32_t maxDuty = (1UL << MOTOR_PWM_RESOLUTION_BITS) - 1;
    const uint32_t percent = MOTOR_MIN_EFFECTIVE_PERCENT
        + ((100UL - MOTOR_MIN_EFFECTIVE_PERCENT) * state.intensity + 50) / 100;
    return (maxDuty * percent + 50) / 100;
}

void setupMotorPwm() {
    if (!MOTORS_PHYSICAL_ENABLED) {
        Serial.println("[MOTOR] MODO SIMULAÇÃO: acionamento físico bloqueado; as saídas dos 5 V919 ficam em LOW.");
        return;
    }
    motorHardwareReady = true;
    for (const uint8_t pin : MOTOR_PINS) {
        if (!ledcAttach(pin, MOTOR_PWM_FREQUENCY_HZ, MOTOR_PWM_RESOLUTION_BITS)) {
            motorHardwareReady = false;
            Serial.printf("[MOTOR] Falha ao configurar PWM no GPIO %u.\n", pin);
        } else {
            ledcWrite(pin, 0);
        }
    }
    if (!motorHardwareReady) {
        for (const uint8_t pin : MOTOR_PINS) {
            ledcDetach(pin);
        }
        holdMotorOutputsLow();
        Serial.println("[MOTOR] PWM indisponível; motores mantidos desligados.");
        return;
    }
    Serial.printf("[MOTOR] ACIONAMENTO FÍSICO HABILITADO: PWM %lu Hz, %u bits.\n",
        static_cast<unsigned long>(MOTOR_PWM_FREQUENCY_HZ), MOTOR_PWM_RESOLUTION_BITS);
}

void writeOutputs(uint32_t duty) {
    if (motorsArePhysical()) {
        for (const uint8_t pin : MOTOR_PINS) {
            ledcWrite(pin, duty);
        }
    } else {
        for (const uint8_t pin : MOTOR_PINS) {
            digitalWrite(pin, LOW);
        }
    }
}

// Exige motorMutex. Reflete nas saídas o estado decidido pelo controlador.
void applyOutputsLocked() {
    const mabel::MotorState &target = controller.motors();
    if (target.on == outputState.on && target.intensity == outputState.intensity) return;
    const uint32_t duty = dutyFor(target);
    writeOutputs(duty);
    outputState = target;
    if (target.on) {
        Serial.printf("[MOTOR] %s os 5 V919 a %u%% (duty %lu/%lu).\n",
            motorsArePhysical() ? "Ligados" : "SIMULAÇÃO: ligaria",
            target.intensity,
            static_cast<unsigned long>(duty),
            static_cast<unsigned long>((1UL << MOTOR_PWM_RESOLUTION_BITS) - 1));
    } else {
        Serial.printf("[MOTOR] %s.\n", motorsArePhysical() ? "Motores desligados" : "SIMULAÇÃO: motores desligados");
    }
}

// Proteção independente das requisições de rede: roda a cada 50 ms, com prioridade
// maior que o laço principal, e desliga os motores por duração, Wi-Fi ou timeout.
void motorSafetyTask(void *) {
    esp_task_wdt_add(nullptr);
    uint32_t lockFailures = 0;
    for (;;) {
        esp_task_wdt_reset();
        const bool wifiConnected = WiFi.status() == WL_CONNECTED;
        if (xSemaphoreTake(motorMutex, pdMS_TO_TICKS(SAFETY_LOCK_TIMEOUT_MS)) == pdTRUE) {
            lockFailures = 0;
            if (emergencyOffPending) {
                controller.emergencyStop();
                outputState = {true, 0};  // força a reescrita das saídas
                emergencyOffPending = false;
            }
            const char *reason = controller.enforceSafety(millis(), wifiConnected);
            applyOutputsLocked();
            xSemaphoreGive(motorMutex);
            if (reason != nullptr) {
                Serial.printf("[SEGURANCA] Motores desligados pela tarefa de segurança: %s.\n", reason);
            }
        } else if (++lockFailures * SAFETY_PERIOD_MS >= SAFETY_FORCE_OFF_MS && !emergencyOffPending) {
            writeOutputs(0);
            emergencyOffPending = true;
            Serial.println("[SEGURANCA] Controle travado: saídas forçadas para desligado.");
        }
        vTaskDelay(pdMS_TO_TICKS(SAFETY_PERIOD_MS));
    }
}

// ====================== WI-FI, NTP E HTTPS ======================

const char *wifiStatusName(wl_status_t status) {
    switch (status) {
        case WL_IDLE_STATUS: return "ocioso";
        case WL_NO_SSID_AVAIL: return "SSID não encontrado (confira o nome e se a rede é 2,4 GHz)";
        case WL_CONNECTED: return "conectado";
        case WL_CONNECT_FAILED: return "falha na conexão (confira a senha)";
        case WL_CONNECTION_LOST: return "conexão perdida";
        case WL_DISCONNECTED: return "desconectado";
        default: return "estado desconhecido";
    }
}

void onWiFiDisconnected(WiFiEvent_t event, WiFiEventInfo_t info) {
    const uint8_t reason = info.wifi_sta_disconnected.reason;
    Serial.printf("[WIFI] Desconectado. Motivo %u: %s\n",
        reason, WiFi.disconnectReasonName(static_cast<wifi_err_reason_t>(reason)));
}

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false);  // reconexão controlada em maintainWiFi()
    WiFi.onEvent(onWiFiDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    WiFi.begin(MABEL_WIFI_SSID, MABEL_WIFI_PASSWORD);
    lastWiFiAttemptAt = millis();
    Serial.println("[WIFI] Iniciando conexão ao Wi-Fi.");
}

void maintainWiFi() {
    const wl_status_t status = WiFi.status();
    if (status == WL_CONNECTED) {
        if (!wifiReportedConnected) {
            wifiReportedConnected = true;
            wifiConnectedAt = millis();
            Serial.printf("[WIFI] Conectado. IP %s, sinal %d dBm.\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
            if (!ntpStarted) {
                configTime(0, 0, "pool.ntp.org", "time.google.com");
                ntpStarted = true;
                Serial.println("[NTP] Sincronização do relógio iniciada.");
            }
        }
        return;
    }
    if (wifiReportedConnected) {
        wifiReportedConnected = false;
        Serial.println("[WIFI] Conexão perdida.");
    }

    const uint32_t now = millis();
    if (now - lastWiFiAttemptAt < WIFI_RETRY_INTERVAL_MS) return;
    lastWiFiAttemptAt = now;
    Serial.printf("[WIFI] Sem conexão (status %d: %s). Nova tentativa.\n", status, wifiStatusName(status));
    WiFi.disconnect(false, false);
    WiFi.begin(MABEL_WIFI_SSID, MABEL_WIFI_PASSWORD);
}

bool clockReady() {
    if (timeSynced) return true;
    const time_t now = time(nullptr);
    if (now >= MIN_VALID_EPOCH) {
        timeSynced = true;
        struct tm utc;
        gmtime_r(&now, &utc);
        char text[32];
        strftime(text, sizeof(text), "%Y-%m-%d %H:%M:%S", &utc);
        Serial.printf("[NTP] Relógio sincronizado: %s UTC.\n", text);
        return true;
    }
    if (millis() - wifiConnectedAt >= NTP_WAIT_MS) {
        if (!ntpWarningShown) {
            ntpWarningShown = true;
            Serial.println("[NTP] Relógio não sincronizado; tentando HTTPS mesmo assim. Erros de data no TLS indicam este problema.");
        }
        return true;
    }
    return false;
}

bool networkReady() {
    return rootCaConfigured && WiFi.status() == WL_CONNECTED && clockReady();
}

bool beginRequest(HTTPClient &http, const String &path) {
    const String url = String(MABEL_API_BASE_URL) + path;
    if (!url.startsWith("https://")) {
        Serial.println("[CONFIG] MABEL_API_BASE_URL deve começar com https://. Requisição cancelada.");
        return false;
    }
    http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
    http.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);
    http.setReuse(true);
    if (!http.begin(secureClient, url)) {
        Serial.println("[HTTP] Não foi possível iniciar a requisição; confira a URL.");
        return false;
    }
    http.addHeader("Authorization", String("Bearer ") + MABEL_DEVICE_TOKEN);
    return true;
}

void logTransportFailure(const char *operation, int code) {
    char tlsError[128] = {0};
    const int tlsCode = secureClient.lastError(tlsError, sizeof(tlsError));
    Serial.printf("[HTTP] %s falhou antes da resposta: %d (%s).\n",
        operation, code, HTTPClient::errorToString(code).c_str());
    if (tlsCode != 0) {
        Serial.printf("[TLS] Erro %d: %s\n", tlsCode, tlsError);
    } else {
        Serial.println("[REDE] Sem erro TLS registrado; confira URL, DNS, firewall ou sinal.");
    }
}

String responseSummary(String body) {
    body.replace('\r', ' ');
    body.replace('\n', ' ');
    if (body.length() > MAX_LOGGED_BODY_CHARS) body = body.substring(0, MAX_LOGGED_BODY_CHARS) + "...";
    return body;
}

// ====================== COMANDOS E CONFIRMAÇÕES ======================

void fetchConfig() {
    HTTPClient http;
    if (!beginRequest(http, String("/api/mabel/config?device_id=") + MABEL_DEVICE_ID)) return;
    const int code = http.GET();
    if (code <= 0) {
        logTransportFailure("Consulta de comandos", code);
        http.end();
        return;
    }
    const String body = http.getString();
    http.end();

    if (code != 200) {
        Serial.printf("[HTTP] Consulta de comandos: status %d. %s\n", code, responseSummary(body).c_str());
        xSemaphoreTake(motorMutex, portMAX_DELAY);
        controller.handleConfigHttpError(code);
        applyOutputsLocked();
        xSemaphoreGive(motorMutex);
        return;
    }

    JsonDocument doc;
    const DeserializationError error = deserializeJson(doc, body);
    if (error) {
        Serial.printf("[API] JSON de configuração inválido: %s\n", error.c_str());
        return;
    }

    const JsonVariantConst command = doc["command_id"];
    const JsonVariantConst motores = doc["motores"];
    mabel::ConfigInput input = {};
    input.deviceId = doc["device_id"].is<const char *>() ? doc["device_id"].as<const char *>() : nullptr;
    input.hasCommand = !command.isNull();
    input.commandId = command.is<const char *>() ? command.as<const char *>() : nullptr;
    input.commandState = doc["estado_comando"].is<const char *>() ? doc["estado_comando"].as<const char *>() : nullptr;
    input.motorFieldsPresent = motores["ligado"].is<bool>()
        && motores["intensidade"].is<long>()
        && motores["duracao_restante_ms"].is<long>();
    input.requestedOn = motores["ligado"] | false;
    input.intensity = motores["intensidade"] | -1L;
    input.remainingMs = motores["duracao_restante_ms"] | -1L;

    const uint32_t interval = doc["intervalo_consulta_ms"] | DEFAULT_CONFIG_INTERVAL_MS;
    configIntervalMs = constrain(interval, MIN_CONFIG_INTERVAL_MS, MAX_CONFIG_INTERVAL_MS);

    xSemaphoreTake(motorMutex, portMAX_DELAY);
    const uint64_t previousCommand = controller.lastHandledCommandId();
    controller.handleConfig(input, millis());
    applyOutputsLocked();
    const char *decision = controller.decision();
    const bool changed = controller.lastHandledCommandId() != previousCommand;
    xSemaphoreGive(motorMutex);

    if (changed || strcmp(decision, "comando atual mantido") != 0) {
        Serial.printf("[CMD] command_id=%s estado=%s: %s.\n",
            input.commandId ? input.commandId : "null",
            input.commandState ? input.commandState : "null",
            decision);
    }
}

void sendPendingAck() {
    mabel::Ack ack;
    uint32_t sequence = 0;
    xSemaphoreTake(motorMutex, portMAX_DELAY);
    const bool hasAck = controller.peekAck(ack, sequence);
    xSemaphoreGive(motorMutex);
    if (!hasAck) return;
    if (sequence == lastAckSequenceAttempted && millis() - lastAckAttemptAt < ACK_RETRY_INTERVAL_MS) return;
    lastAckSequenceAttempted = sequence;
    lastAckAttemptAt = millis();

    JsonDocument doc;
    doc["device_id"] = MABEL_DEVICE_ID;
    if (ack.commandId[0] != '\0') {
        doc["command_id"] = ack.commandId;
    } else {
        doc["command_id"] = nullptr;
    }
    doc["resultado"] = ack.result;
    JsonObject reported = doc["motores"].to<JsonObject>();
    reported["ligado"] = ack.state.on;
    reported["intensidade"] = ack.state.intensity;
    doc["fisico"] = motorsArePhysical();
    doc["motivo"] = ack.reason;
    String payload;
    serializeJson(doc, payload);

    int code = -1;
    String summary;
    HTTPClient http;
    if (beginRequest(http, "/api/mabel/motores/confirmacao")) {
        http.addHeader("Content-Type", "application/json");
        code = http.POST(payload);
        if (code > 0) {
            summary = responseSummary(http.getString());
        } else {
            logTransportFailure("Confirmação", code);
        }
        http.end();
    }

    if (code > 0) {
        Serial.printf("[ACK] %s/%s do comando %s: status %d. %s\n",
            ack.result, ack.reason, ack.commandId[0] ? ack.commandId : "null", code, summary.c_str());
    }
    xSemaphoreTake(motorMutex, portMAX_DELAY);
    controller.handleAckResponse(sequence, ack, code);
    applyOutputsLocked();
    xSemaphoreGive(motorMutex);
}

// ====================== SENSOR E TELEMETRIA ======================

void updateSensor() {
    const uint32_t now = millis();
    const bool rawDetected = digitalRead(SENSOR_PIN) == SENSOR_ACTIVE_LEVEL;

    if (rawDetected != lastRawSensorState) {
        lastRawSensorState = rawDetected;
        lastSensorChangeAt = now;
    }

    if (rawDetected != stableSensorState && now - lastSensorChangeAt >= DEBOUNCE_MS) {
        stableSensorState = rawDetected;
        if (stableSensorState) {
            detectionCount++;
        }
        // O SW-420 só registra vibração e acende o LED; ele nunca aciona os motores.
        digitalWrite(LED_PIN, stableSensorState ? HIGH : LOW);
    }
}

void sendTelemetry() {
    JsonDocument doc;
    doc["device_id"] = MABEL_DEVICE_ID;
    doc["sensor_detectou"] = stableSensorState;
    doc["contador_deteccoes"] = detectionCount;
    doc["uptime_ms"] = millis();
    String payload;
    serializeJson(doc, payload);

    HTTPClient http;
    if (!beginRequest(http, "/api/mabel/dados")) return;
    http.addHeader("Content-Type", "application/json");
    const int code = http.POST(payload);
    if (code <= 0) {
        logTransportFailure("Telemetria", code);
    } else {
        Serial.printf("[HTTP] Telemetria: status %d. %s\n", code, responseSummary(http.getString()).c_str());
    }
    http.end();
}

// ====================== WATCHDOG, SETUP E LOOP ======================

const char *resetReasonName(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "energização";
        case ESP_RST_SW: return "reinício por software";
        case ESP_RST_PANIC: return "falha (panic)";
        case ESP_RST_INT_WDT: return "watchdog de interrupção";
        case ESP_RST_TASK_WDT: return "watchdog de tarefa";
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_BROWNOUT: return "queda de tensão (brownout): verifique a alimentação";
        case ESP_RST_EXT: return "pino de reset";
        default: return "outro";
    }
}

void setupWatchdog() {
    esp_task_wdt_config_t config = {};
    config.timeout_ms = WATCHDOG_TIMEOUT_MS;
    config.idle_core_mask = 1 << 0;
    config.trigger_panic = true;
    esp_err_t result = esp_task_wdt_reconfigure(&config);
    if (result == ESP_ERR_INVALID_STATE) result = esp_task_wdt_init(&config);
    if (result == ESP_OK) result = esp_task_wdt_add(nullptr);
    Serial.printf("[WDT] Watchdog de %lu s %s.\n",
        static_cast<unsigned long>(WATCHDOG_TIMEOUT_MS / 1000),
        result == ESP_OK ? "ativo" : "não pôde ser configurado");
}

void setup() {
    holdMotorOutputsLow();
    Serial.begin(115200);
    pinMode(SENSOR_PIN, INPUT);
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    lastRawSensorState = digitalRead(SENSOR_PIN) == SENSOR_ACTIVE_LEVEL;
    stableSensorState = lastRawSensorState;
    lastSensorChangeAt = millis();
    digitalWrite(LED_PIN, stableSensorState ? HIGH : LOW);

    const esp_reset_reason_t resetReason = esp_reset_reason();
    Serial.printf("[BOOT] Motivo do reinício: %d (%s).\n", resetReason, resetReasonName(resetReason));
    setupMotorPwm();
    setupWatchdog();

    motorMutex = xSemaphoreCreateMutex();
    controller.begin(MABEL_DEVICE_ID);
    if (motorMutex == nullptr
        || xTaskCreatePinnedToCore(motorSafetyTask, "mabel_safety", 4096, nullptr, 3, nullptr, 1) != pdPASS) {
        Serial.println("[SEGURANCA] Falha ao criar a proteção dos motores; reiniciando.");
        delay(1000);
        ESP.restart();
    }

    const String rootCa(MABEL_ROOT_CA);
    rootCaConfigured = rootCa.indexOf("BEGIN CERTIFICATE") >= 0 && rootCa.indexOf("REPLACE_WITH") < 0;
    if (rootCaConfigured) {
        secureClient.setCACert(MABEL_ROOT_CA);
        secureClient.setHandshakeTimeout(TLS_HANDSHAKE_TIMEOUT_S);
    } else {
        Serial.println("[CONFIG] MABEL_ROOT_CA não contém um certificado PEM; nenhuma requisição será feita.");
    }

    Serial.printf("[CONFIG] API: %s | device_id: %s | V919 nos GPIO 32, 33, 25, 26, 27.\n",
        MABEL_API_BASE_URL, MABEL_DEVICE_ID);
    connectWiFi();
}

void loop() {
    esp_task_wdt_reset();
    updateSensor();
    maintainWiFi();

    if (networkReady()) {
        sendPendingAck();
        esp_task_wdt_reset();
        if (millis() - lastConfigAttemptAt >= configIntervalMs) {
            lastConfigAttemptAt = millis();
            fetchConfig();
        } else if (millis() - lastSendAt >= SEND_INTERVAL_MS) {
            lastSendAt = millis();
            sendTelemetry();
        }
    }

    delay(5);
}
