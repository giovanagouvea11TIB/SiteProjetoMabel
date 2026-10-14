#include <HTTPClient.h>
#include <WiFi.h>

#include "mabel_config.h"

constexpr uint8_t SENSOR_PIN = 27;
constexpr uint8_t LED_PIN = 25;
constexpr uint32_t SEND_INTERVAL_MS = 5000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
constexpr uint32_t DEBOUNCE_MS = 40;
constexpr uint8_t SENSOR_ACTIVE_LEVEL = LOW;

bool stableSensorState = false;
bool lastRawSensorState = false;
uint32_t lastSensorChangeAt = 0;
uint32_t lastSendAt = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t detectionCount = 0;

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(MABEL_WIFI_SSID, MABEL_WIFI_PASSWORD);
    lastWiFiAttemptAt = millis();
    Serial.println("Iniciando conexão ao Wi-Fi.");
}

void maintainWiFi() {
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }

    const uint32_t now = millis();
    if (now - lastWiFiAttemptAt < WIFI_RETRY_INTERVAL_MS) {
        return;
    }

    lastWiFiAttemptAt = now;
    WiFi.reconnect();
    Serial.println("Tentando reconectar ao Wi-Fi.");
}

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
        digitalWrite(LED_PIN, stableSensorState ? HIGH : LOW);
    }
}

void sendTelemetry() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    HTTPClient http;
    http.setTimeout(3000);
    const String endpoint = String(MABEL_API_BASE_URL) + "/api/mabel/dados";
    if (!http.begin(endpoint)) {
        Serial.println("Não foi possível iniciar a requisição HTTP.");
        return;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", String("Bearer ") + MABEL_DEVICE_TOKEN);

    const String payload =
        String("{\"device_id\":\"") + MABEL_DEVICE_ID
        + "\",\"sensor_detectou\":" + (stableSensorState ? "true" : "false")
        + ",\"contador_deteccoes\":" + String(detectionCount)
        + ",\"uptime_ms\":" + String(millis()) + "}";

    const int responseCode = http.POST(payload);
    if (responseCode > 0) {
        Serial.print("Telemetria enviada. HTTP ");
        Serial.println(responseCode);
    } else {
        Serial.print("Falha na requisição HTTP: ");
        Serial.println(responseCode);
    }

    http.end();
}

void setup() {
    Serial.begin(115200);
    pinMode(SENSOR_PIN, INPUT);
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);

    lastRawSensorState = digitalRead(SENSOR_PIN) == SENSOR_ACTIVE_LEVEL;
    stableSensorState = lastRawSensorState;
    lastSensorChangeAt = millis();
    digitalWrite(LED_PIN, stableSensorState ? HIGH : LOW);

    connectWiFi();
}

void loop() {
    updateSensor();
    maintainWiFi();

    const uint32_t now = millis();
    if (now - lastSendAt >= SEND_INTERVAL_MS) {
        lastSendAt = now;
        sendTelemetry();
    }

    delay(5);
}
