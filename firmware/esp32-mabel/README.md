# Firmware ESP32 Mabel

Firmware para placa de desenvolvimento ESP-WROOM-32 com sensor SW-420, LED indicador e cinco módulos de motor vibratório V919, controlados pelo aplicativo Mabel. Ele:

- envia a telemetria do SW-420 (`POST /api/mabel/dados`) a cada 5 s;
- consulta o comando dos motores (`GET /api/mabel/config`) a cada 3 s;
- aplica liga/desliga, intensidade (0–100%) e duração da sessão nos cinco canais PWM;
- confirma ao backend o estado realmente aplicado (`POST /api/mabel/motores/confirmacao`), com `fisico` indicando se o acionamento foi real ou simulado.

O SW-420 apenas registra vibrações e acende o LED. Ele **não** aciona os motores e não mede intensidade clínica.

## Acionamento físico bloqueado

`MOTORS_PHYSICAL_ENABLED = false` (no início do `.ino`). Nesse modo, todo o controle funciona — comandos, intensidade, duração, proteções e confirmações —, mas as cinco saídas permanecem em `LOW` e as confirmações informam `"fisico": false`. O aplicativo exibe esse estado como **simulação**. Só altere para `true` depois de concluir a lista de verificação abaixo.

## Módulos V919 — o que se sabe

Não foi encontrada documentação pública para o código "V919". Módulos de motor vibratório com três terminais (`IN`/`S`, `VCC`, `GND`) costumam ter um transistor ou MOSFET e diodo na placa, alimentação de 3,3–5 V, corrente de 35–120 mA por módulo e aceitam PWM (fichas comerciais recomendam a partir de 1 kHz). **Isso precisa ser confirmado no módulo comprado** antes do acionamento físico:

1. Fotografe frente e verso de um módulo (componentes, marcações do transistor/MOSFET, diodo, resistores e serigrafia) e o anúncio/datasheet de compra.
2. Confirme que existe driver na placa (transistor/MOSFET + diodo de roda livre). Sem driver, o motor **não** pode ser ligado ao sinal `IN`.
3. Meça, com fonte de bancada limitada em corrente, a corrente de cada módulo a 100% e na partida.
4. Confirme que o módulo liga com sinal de 3,3 V em `IN` (lógica do ESP32) quando alimentado com a tensão escolhida em `VCC`.
5. Verifique se o módulo responde ao PWM em 1 kHz sem aquecimento; ajuste `MOTOR_PWM_FREQUENCY_HZ` e `MOTOR_MIN_EFFECTIVE_PERCENT` com base nas medições.

## Ligações previstas (sujeitas à verificação do modelo físico)

| Componente | GPIO | Observação |
|---|---|---|
| SW-420 `DO` | 13 | `VCC` em 3V3. Os GPIOs do ESP32 não toleram 5 V. |
| LED | 14 | Com resistor de 220 Ω para GND. Pode piscar no boot. |
| V919 1 `IN` | 32 | |
| V919 2 `IN` | 33 | |
| V919 3 `IN` | 25 | ADC2: só não pode ser entrada analógica com Wi-Fi; saída PWM não é afetada. |
| V919 4 `IN` | 26 | ADC2, idem. |
| V919 5 `IN` | 27 | ADC2, idem. |

Nenhum desses GPIOs é pino de strapping (0, 2, 5, 12, 15) nem está ligado à flash (6–11). O PWM usa `ledcAttach`/`ledcWrite` do Core 3.3.12, 8 bits, mesma intensidade nos cinco canais.

Alimentação:

- **Nunca alimente os motores pelos GPIOs** e não use o pino 3V3 da placa para os cinco módulos: o regulador da placa também alimenta o Wi-Fi (picos de ~0,5 A) e uma queda de tensão reinicia o ESP32 (`brownout`, registrado no Monitor Serial).
- Use uma fonte de 5 V separada para os `VCC` dos V919, dimensionada para pelo menos 1,5 A (5 × ~120 mA em regime, com folga para a corrente de partida), com **GND comum** entre a fonte e o ESP32.
- Capacitor de desacoplamento de 100 nF junto a cada módulo e um eletrolítico de 470–1000 µF na entrada de 5 V dos motores.
- Resistor de pull-down de 10 kΩ em cada `IN` (se o módulo não tiver), para manter o motor desligado enquanto o ESP32 reinicia.
- Se o módulo não tiver diodo de roda livre, ele precisa ser adicionado (por exemplo, 1N4148/1N5819 em antiparalelo com o motor).

## Segurança implementada no firmware

- Saídas dos motores em `LOW` antes de qualquer outra inicialização.
- Tarefa de segurança FreeRTOS (a cada 50 ms, prioridade acima do laço principal) que desliga os motores por fim da duração, perda de Wi-Fi ou 10 s sem consulta válida — **mesmo enquanto uma requisição HTTPS está bloqueada**.
- Após reiniciar, nenhum comando anterior é retomado; é preciso um novo comando do aplicativo.
- Comandos com `command_id` menor que o último tratado, de outro `device_id`, inválidos ou já interrompidos nunca ligam os motores; comandos inválidos são confirmados como `rejeitado`.
- Respostas 401/403/404 na consulta desligam os motores; 409 na confirmação de uma aplicação desliga os motores e informa a interrupção.
- Duração limitada a 600 s; a duração só pode ser encurtada pelo servidor, nunca estendida.
- Watchdog de 30 s nas duas tarefas; timeout do handshake TLS reduzido de 120 s (padrão do core) para 8 s.
- HTTPS com `setCACert(MABEL_ROOT_CA)`, sem `setInsecure()`, e relógio sincronizado por NTP.

A lógica de decisão dos motores fica entre os marcadores `MABEL_MOTOR_LOGIC_BEGIN/END` do `.ino`, em C++ puro, e é testada no computador por `motor-logic.test.js` (requer um compilador C++; defina `MABEL_CXX`, por exemplo `zig c++`).

## Configuração no Arduino IDE

1. Instale o core **esp32 3.3.12** e a biblioteca **ArduinoJson 7**.
2. Copie `mabel_config.example.h` para `mabel_config.h` na mesma pasta do sketch (o arquivo é ignorado pelo Git).
3. Preencha SSID e senha (rede 2,4 GHz), `MABEL_API_BASE_URL` (`https://...`, sem barra no final), `MABEL_DEVICE_ID` e o mesmo `MABEL_DEVICE_TOKEN` configurado no backend.
4. Em `MABEL_ROOT_CA`, coloque o certificado público da CA raiz do servidor. Para `*.vercel.app`, a cadeia atual é `*.vercel.app -> WR1 -> GTS Root R1`; use a **GTS Root R1** autoassinada (SHA-256 `D9:47:43:2A:BD:E7:B7:FA:90:FC:2E:6B:59:10:1B:12:80:E0:E1:C7:E4:E4:0F:A3:C6:88:7F:FF:57:A7:F4:CF`, válida até 2036).
5. Placa **ESP32 Dev Module**, Monitor Serial em 115200 baud.

Testes de desenvolvimento nunca devem ser feitos no animal. Os limites de intensidade e duração para uso da órtese devem ser definidos por um profissional veterinário.
