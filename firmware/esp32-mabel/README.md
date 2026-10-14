# Firmware ESP32 Mabel

Firmware inicial para ESP32-WROOM-32, SW-420 digital e LED indicador. Ele envia o estado digital do sensor, o contador de bordas de detecção e `millis()` a cada cinco segundos. O SW-420 não mede intensidade clínica; nenhum percentual é calculado e nenhum motor é acionado.

## Ligações

- SW-420 `DO` -> GPIO 27, `VCC` -> `3V3` e `GND` -> `GND` do ESP32. Não alimente a saída lógica do sensor com 5 V: os GPIOs do ESP32 não são tolerantes a 5 V.
- LED -> GPIO 25 em série com resistor de 220 ohms -> GND.
- O firmware assume saída ativa em `LOW`; ajuste `SENSOR_ACTIVE_LEVEL` no `.ino` se o módulo tiver polaridade oposta.

## Configuração no Arduino IDE

1. Copie `mabel_config.example.h` para `mabel_config.h` na mesma pasta do sketch.
2. Configure SSID/senha do hotspot, `MABEL_API_BASE_URL`, `MABEL_DEVICE_ID` e um token aleatório de pelo menos 32 caracteres.
3. Configure a mesma variável `MABEL_DEVICE_TOKEN` no ambiente do backend. Não faça commit do arquivo `mabel_config.h` nem do token.
4. Na rede local, use a URL `http://IP_LOCAL_DO_COMPUTADOR:3000`, não `localhost`. Descubra o IP local do computador e permita o acesso à porta 3000 no firewall. O Express escuta na interface de rede, salvo restrições do sistema operacional.
5. Use HTTP sem TLS somente em uma rede local confiável. Não envie o token por HTTP através da internet pública.

O contador reinicia quando o ESP32 reinicia e `uptime_ms` é o contador de `millis()` do firmware.
