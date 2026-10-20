// Testes no computador da lógica dos motores extraída de esp32-mabel.ino.
// Executado por firmware/esp32-mabel/motor-logic.test.js; não é compilado pelo Arduino IDE.
#include <cstdio>
#include <cstring>

#include "mabel_motor_logic.generated.h"

using namespace mabel;

static int checks = 0;
static int failures = 0;
static const char *DEVICE = "mabel-esp32-01";

#define CHECK(condition)                                                             \
    do {                                                                             \
        checks++;                                                                    \
        if (!(condition)) {                                                          \
            failures++;                                                              \
            std::printf("FALHA %s:%d: %s\n", __FILE__, __LINE__, #condition);        \
        }                                                                            \
    } while (0)

static ConfigInput config(const char *commandId, const char *state, bool on, long intensity, long remainingMs,
                          const char *deviceId = DEVICE) {
    ConfigInput input = {};
    input.deviceId = deviceId;
    input.hasCommand = commandId != nullptr;
    input.commandId = commandId;
    input.commandState = state;
    input.motorFieldsPresent = true;
    input.requestedOn = on;
    input.intensity = intensity;
    input.remainingMs = remainingMs;
    return input;
}

static ConfigInput noCommand() {
    return config(nullptr, nullptr, false, 0, 0);
}

// Imprime a confirmação pendente em JSON (validada pelo backend no teste Node) e simula a resposta HTTP.
static bool takeAck(MotorController &controller, Ack &ack, int httpStatus = 200) {
    uint32_t sequence = 0;
    if (!controller.peekAck(ack, sequence)) return false;
    const bool hasId = ack.commandId[0] != '\0';
    std::printf(
        "ACK {\"device_id\":\"%s\",\"command_id\":%s%s%s,\"resultado\":\"%s\","
        "\"motores\":{\"ligado\":%s,\"intensidade\":%u},\"fisico\":false,\"motivo\":\"%s\"}\n",
        DEVICE, hasId ? "\"" : "", hasId ? ack.commandId : "null", hasId ? "\"" : "", ack.result,
        ack.state.on ? "true" : "false", static_cast<unsigned>(ack.state.intensity), ack.reason);
    controller.handleAckResponse(sequence, ack, httpStatus);
    return true;
}

static bool ackIs(const Ack &ack, const char *commandId, const char *result, const char *reason, bool on,
                  unsigned intensity) {
    return std::strcmp(ack.commandId, commandId) == 0 && std::strcmp(ack.result, result) == 0
        && std::strcmp(ack.reason, reason) == 0 && ack.state.on == on && ack.state.intensity == intensity;
}

static bool hasPendingAck(const MotorController &controller) {
    Ack ack;
    uint32_t sequence = 0;
    return controller.peekAck(ack, sequence);
}

// Controlador já iniciado, com a confirmação de reinício enviada e a referência de boot registrada.
static void boot(MotorController &controller, uint32_t nowMs = 1000) {
    controller.begin(DEVICE);
    Ack ack;
    takeAck(controller, ack);
    controller.handleConfig(noCommand(), nowMs);
}

static void turnOn(MotorController &controller, const char *id, unsigned intensity, long remainingMs, uint32_t nowMs) {
    controller.handleConfig(config(id, "pendente", true, intensity, remainingMs), nowMs);
    Ack ack;
    takeAck(controller, ack);
}

static void testBootStartsOffAndReportsRestart() {
    MotorController controller;
    controller.begin(DEVICE);
    CHECK(!controller.motors().on);
    Ack ack;
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "", "interrompido", "reinicio", false, 0));
}

static void testCommandBeforeRestartIsNotResumed() {
    MotorController controller;
    controller.begin(DEVICE);
    Ack ack;
    takeAck(controller, ack);
    controller.handleConfig(config("7", "pendente", true, 40, 60000), 1000);
    CHECK(!controller.motors().on);
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "7", "interrompido", "reinicio", false, 0));
    controller.handleConfig(config("7", "pendente", true, 40, 59000), 2000);
    CHECK(!controller.motors().on);
    CHECK(!hasPendingAck(controller));
    controller.handleConfig(config("8", "pendente", true, 50, 60000), 3000);
    CHECK(controller.motors().on && controller.motors().intensity == 50);
}

static void testPendingOffAtRestartIsConfirmed() {
    MotorController controller;
    controller.begin(DEVICE);
    Ack ack;
    takeAck(controller, ack);
    controller.handleConfig(config("7", "pendente", false, 0, 0), 1000);
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "7", "aplicado", "comando", false, 0));
}

static void testTurnOnTurnOffAndChangeIntensity() {
    MotorController controller;
    boot(controller);
    controller.handleConfig(config("10", "pendente", true, 40, 60000), 2000);
    CHECK(controller.motors().on && controller.motors().intensity == 40);
    CHECK(controller.offAt() == 62000);
    Ack ack;
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "10", "aplicado", "comando", true, 40));

    controller.handleConfig(config("11", "pendente", true, 70, 60000), 3000);
    CHECK(controller.motors().intensity == 70);
    CHECK(std::strcmp(controller.activeCommand(), "11") == 0);
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "11", "aplicado", "comando", true, 70));

    controller.handleConfig(config("12", "pendente", false, 0, 0), 4000);
    CHECK(!controller.motors().on);
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "12", "aplicado", "comando", false, 0));
}

static void testDurationEndsSession() {
    MotorController controller;
    boot(controller);
    turnOn(controller, "10", 40, 5000, 2000);
    CHECK(controller.enforceSafety(6999, true) == nullptr);
    CHECK(controller.motors().on);
    const char *reason = controller.enforceSafety(7000, true);
    CHECK(reason != nullptr && std::strcmp(reason, "duracao") == 0);
    CHECK(!controller.motors().on);
    Ack ack;
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "10", "interrompido", "duracao", false, 0));
}

static void testWifiLossAndCommunicationTimeout() {
    MotorController wifi;
    boot(wifi);
    turnOn(wifi, "10", 40, 60000, 2000);
    const char *reason = wifi.enforceSafety(2100, false);
    CHECK(reason != nullptr && std::strcmp(reason, "comunicacao") == 0);
    CHECK(!wifi.motors().on);
    Ack ack;
    CHECK(takeAck(wifi, ack));
    CHECK(ackIs(ack, "10", "interrompido", "comunicacao", false, 0));

    MotorController timeout;
    boot(timeout);
    turnOn(timeout, "10", 40, 60000, 2000);
    CHECK(timeout.enforceSafety(12000, true) == nullptr);
    timeout.handleConfig(config("10", "aplicado", true, 40, 50000), 11000);
    CHECK(timeout.enforceSafety(21000, true) == nullptr);
    CHECK(timeout.enforceSafety(21001, true) != nullptr);
    CHECK(!timeout.motors().on);
}

static void testOldAndInterruptedCommandsNeverTurnOn() {
    MotorController controller;
    boot(controller);
    turnOn(controller, "10", 40, 60000, 2000);
    controller.handleConfig(config("9", "pendente", true, 90, 60000), 3000);
    CHECK(controller.motors().intensity == 40);
    CHECK(!hasPendingAck(controller));

    controller.enforceSafety(3100, false);
    Ack ack;
    takeAck(controller, ack);
    controller.handleConfig(config("10", "aplicado", true, 40, 50000), 4000);
    CHECK(!controller.motors().on);
    CHECK(!hasPendingAck(controller));
    controller.handleConfig(config("9", "pendente", true, 90, 60000), 5000);
    CHECK(!controller.motors().on);
}

static void testInvalidCommandsAreRejectedAndTurnOff() {
    MotorController controller;
    boot(controller);
    turnOn(controller, "10", 40, 60000, 2000);

    ConfigInput invalid[] = {
        config("20", "pendente", true, 101, 60000),
        config("21", "pendente", true, 0, 60000),
        config("22", "pendente", true, 40, 0),
        config("23", "pendente", false, 5, 0),
        config("24", "pendente", true, 40, -1),
        config("25", "desconhecido", true, 40, 60000),
    };
    const char *ids[] = {"20", "21", "22", "23", "24", "25"};
    for (int index = 0; index < 6; index++) {
        controller.handleConfig(invalid[index], 3000 + index);
        CHECK(!controller.motors().on);
        Ack ack;
        CHECK(takeAck(controller, ack));
        CHECK(ackIs(ack, ids[index], "rejeitado", "invalido", false, 0));
    }
    controller.handleConfig(config("25", "desconhecido", true, 40, 60000), 4000);
    CHECK(!hasPendingAck(controller));

    ConfigInput missingFields = config("30", "pendente", true, 40, 60000);
    missingFields.motorFieldsPresent = false;
    controller.handleConfig(missingFields, 5000);
    Ack ack;
    CHECK(takeAck(controller, ack));
    CHECK(ackIs(ack, "30", "rejeitado", "invalido", false, 0));

    ConfigInput leadingZero = config("031", "pendente", true, 40, 60000);
    controller.handleConfig(leadingZero, 6000);
    CHECK(!controller.motors().on);
    CHECK(!hasPendingAck(controller));

    ConfigInput numericId = config(nullptr, "pendente", true, 40, 60000);
    numericId.hasCommand = true;
    controller.handleConfig(numericId, 7000);
    CHECK(!controller.motors().on);
    CHECK(!hasPendingAck(controller));
}

static void testOtherDeviceIsIgnored() {
    MotorController controller;
    boot(controller);
    turnOn(controller, "10", 40, 60000, 2000);
    CHECK(!controller.handleConfig(config("11", "pendente", true, 90, 60000, "mabel-esp32-99"), 9000));
    CHECK(controller.motors().intensity == 40);
    CHECK(controller.enforceSafety(12001, true) != nullptr);
    CHECK(!controller.handleConfig(config("11", "pendente", true, 90, 60000, nullptr), 13000));
    CHECK(!controller.motors().on);
}

static void testHttpErrorsAndAckRetries() {
    MotorController forbidden;
    boot(forbidden);
    turnOn(forbidden, "10", 40, 60000, 2000);
    forbidden.handleConfigHttpError(500);
    CHECK(forbidden.motors().on);
    forbidden.handleConfigHttpError(403);
    CHECK(!forbidden.motors().on);
    CHECK(!hasPendingAck(forbidden));

    MotorController retries;
    boot(retries);
    retries.handleConfig(config("10", "pendente", true, 40, 60000), 2000);
    Ack ack;
    uint32_t sequence = 0;
    CHECK(retries.peekAck(ack, sequence));
    retries.handleAckResponse(sequence, ack, -1);
    CHECK(hasPendingAck(retries));
    retries.handleAckResponse(sequence, ack, 503);
    CHECK(hasPendingAck(retries));
    retries.handleAckResponse(sequence, ack, 200);
    CHECK(!hasPendingAck(retries));

    MotorController refused;
    boot(refused);
    refused.handleConfig(config("10", "pendente", true, 40, 60000), 2000);
    CHECK(refused.peekAck(ack, sequence));
    refused.handleAckResponse(sequence, ack, 409);
    CHECK(!refused.motors().on);
    CHECK(takeAck(refused, ack));
    CHECK(ackIs(ack, "10", "interrompido", "recusado_servidor", false, 0));

    MotorController stale;
    boot(stale);
    stale.handleConfig(config("10", "pendente", true, 40, 60000), 2000);
    Ack first;
    uint32_t firstSequence = 0;
    stale.peekAck(first, firstSequence);
    stale.enforceSafety(2100, false);
    stale.handleAckResponse(firstSequence, first, 200);
    CHECK(stale.peekAck(ack, sequence));
    CHECK(ackIs(ack, "10", "interrompido", "comunicacao", false, 0));
    stale.handleAckResponse(sequence, ack, 409);
    CHECK(!hasPendingAck(stale));
}

static void testServerSideEndStates() {
    MotorController notPending;
    boot(notPending);
    turnOn(notPending, "10", 40, 60000, 2000);
    notPending.handleConfig(config("11", "expirado", false, 0, 0), 3000);
    CHECK(!notPending.motors().on);
    Ack ack;
    CHECK(takeAck(notPending, ack));
    CHECK(ackIs(ack, "10", "interrompido", "recusado_servidor", false, 0));

    MotorController completed;
    boot(completed);
    turnOn(completed, "10", 40, 60000, 2000);
    completed.handleConfig(config("10", "concluido", false, 0, 0), 3000);
    CHECK(takeAck(completed, ack));
    CHECK(ackIs(ack, "10", "interrompido", "duracao", false, 0));

    MotorController removed;
    boot(removed);
    turnOn(removed, "10", 40, 60000, 2000);
    removed.handleConfig(noCommand(), 3000);
    CHECK(!removed.motors().on);
    CHECK(takeAck(removed, ack));
    CHECK(ackIs(ack, "10", "interrompido", "recusado_servidor", false, 0));
}

static void testDurationOnlyShrinksAndIsBounded() {
    MotorController controller;
    boot(controller);
    turnOn(controller, "10", 40, 60000, 2000);
    controller.handleConfig(config("10", "aplicado", true, 40, 50000), 3000);
    CHECK(controller.offAt() == 53000);
    controller.handleConfig(config("10", "aplicado", true, 40, 59000), 4000);
    CHECK(controller.offAt() == 53000);

    MotorController bounded;
    boot(bounded);
    turnOn(bounded, "10", 40, 999999999L, 2000);
    CHECK(bounded.offAt() == 2000 + MAX_MOTOR_RUN_MS);
}

static void testMillisWraparound() {
    const uint32_t start = 0xFFFFF000UL;
    MotorController controller;
    boot(controller, start);
    turnOn(controller, "10", 40, 10000, start);
    CHECK(controller.enforceSafety(start + 9999U, true) == nullptr);
    const char *reason = controller.enforceSafety(start + 10000U, true);
    CHECK(reason != nullptr && std::strcmp(reason, "duracao") == 0);
}

int main() {
    testBootStartsOffAndReportsRestart();
    testCommandBeforeRestartIsNotResumed();
    testPendingOffAtRestartIsConfirmed();
    testTurnOnTurnOffAndChangeIntensity();
    testDurationEndsSession();
    testWifiLossAndCommunicationTimeout();
    testOldAndInterruptedCommandsNeverTurnOn();
    testInvalidCommandsAreRejectedAndTurnOff();
    testOtherDeviceIsIgnored();
    testHttpErrorsAndAckRetries();
    testServerSideEndStates();
    testDurationOnlyShrinksAndIsBounded();
    testMillisWraparound();
    std::printf("RESULTADO checks=%d falhas=%d\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
