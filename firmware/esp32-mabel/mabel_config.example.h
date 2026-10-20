#pragma once

#define MABEL_WIFI_SSID "PREENCHA_COM_O_NOME_DO_WIFI"
#define MABEL_WIFI_PASSWORD "PREENCHA_COM_A_SENHA_DO_WIFI"
#define MABEL_API_BASE_URL "https://PREENCHA_COM_O_HOST_DO_BACKEND"
#define MABEL_DEVICE_TOKEN "PREENCHA_COM_O_MESMO_TOKEN_SEGURO_CONFIGURADO_NO_SERVIDOR"
#define MABEL_DEVICE_ID "mabel-esp32-01"

// Certificado PEM público da autoridade raiz que assinou o certificado do servidor.
// Para *.vercel.app, use a GTS Root R1 (veja o README). Não coloque chaves privadas aqui.
static const char MABEL_ROOT_CA[] = R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_ROOT_CA_CERTIFICATE
-----END CERTIFICATE-----
)PEM";
