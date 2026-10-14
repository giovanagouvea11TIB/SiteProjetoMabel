# Projeto Mabel

## Configuração do servidor

O backend local e as funções da Vercel usam as mesmas variáveis de ambiente. Configure-as no ambiente local do servidor e no painel da Vercel; nunca publique seus valores:

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `DB_HOST` | Sim | Hostname do servidor MySQL |
| `DB_USER` | Sim | Usuário MySQL |
| `DB_PASSWORD` | Conforme a conta MySQL | Senha MySQL; pode ser vazia apenas se a conta permitir |
| `SESSION_SECRET` | Sim | Segredo de assinatura de sessão, longo e aleatório |
| `DB_PORT` | Não | Porta MySQL; padrão `3306` |
| `DB_DATABASE` | Não | Schema; padrão fixo `alunos_projetoMabel` |
| `DB_NAME` | Não (legado) | Alias de `DB_DATABASE`; se ambos forem definidos, precisam coincidir |
| `DB_CONNECTION_LIMIT` | Não | Limite de conexões por instância; padrão `10` local e `1` na Vercel |
| `DB_QUEUE_LIMIT` | Não | Fila máxima do pool; padrão `50` |
| `DB_SSL` | Não | Use `true` para habilitar TLS com a cadeia de certificados confiável pelo Node.js |
| `PORT` | Não | Porta HTTP local; padrão `3000` |
| `NODE_ENV` | Não | Defina `production` em produção para habilitar cookies `Secure` |
| `MABEL_DEVICE_TOKEN` | Sim para o ESP32 | Token aleatório de pelo menos 32 caracteres; configure no servidor e somente no arquivo local ignorado do firmware |

`EMAIL_USER` e `EMAIL_APP_PASSWORD` são opcionais para recursos de e-mail. Sem eles, o envio de e-mail não estará disponível, mas as APIs de perfil, sessão e vacinas continuam independentes.

O schema `alunos_projetoMabel` precisa estar preparado antes de iniciar a aplicação. O servidor não cria nem migra tabelas automaticamente. A tabela de sessões existente deve ser `mabel_web_sessions`, com `session_id`, `expires` e `data`.

A preferência de tema claro/escuro é salva localmente no navegador e reaplicada nas páginas públicas e internas; ela não é sincronizada entre dispositivos ou contas.

## Execução local

Configure as variáveis do backend em um arquivo `.env` na raiz do projeto ou no ambiente do processo e inicie com `npm start`. Para servir os arquivos estáticos localmente, o Express escuta em `PORT` ou `3000`.

## Vercel

Configure as variáveis de banco e sessão no ambiente de Preview/Production apropriado. O handler serverless reutiliza a aplicação Express e o pool do processo; o limite do pool é por instância serverless, não global. Configure `DB_SSL=true` se o provedor MySQL exigir TLS. Cookies de sessão usam `Secure` em produção e `SameSite=Lax`.

Não configure `DB_HOST`, usuário ou senha em arquivos versionados. Não use `DB_NAME` e `DB_DATABASE` com valores diferentes.

## ESP32 e telemetria Mabel

O backend expõe `POST /api/mabel/dados` para o ESP32, autenticado por `Authorization: Bearer <token>`, e `GET /api/mabel/status` para consultar o último estado recebido pelo mesmo token. Sem `MABEL_DEVICE_TOKEN` configurado, a API recusa a autenticação do dispositivo. Não envie o token em logs, repositórios ou tráfego HTTP pela internet pública.

O firmware Arduino IDE, os pinos e o uso do IP local do computador estão documentados em [firmware/esp32-mabel/README.md](./firmware/esp32-mabel/README.md). O arquivo local `firmware/esp32-mabel/mabel_config.h`, com Wi-Fi e token, é ignorado pelo Git.

### Persistência pendente de autorização

A inspeção somente de metadados encontrou `telemetria_mabel` com colunas de motores e estado do sensor, mas sem `device_id`, contador ou `uptime_ms`; `mabel_sessoes` não relaciona sessões a pets, e `mabel_eventos` exige uma sessão. Portanto, nenhuma dessas tabelas permite persistir essas leituras e garantir a propriedade do pet sem reutilizar indevidamente outro modelo.

Até haver autorização para uma migração de schema, `POST /api/mabel/dados` mantém apenas o último estado de cada dispositivo na memória do processo; os dados se perdem quando o servidor reinicia ou quando uma instância serverless termina. O status via token do dispositivo mostra essa leitura volátil. O acesso web exige sessão autenticada e `pet_id`, verifica a propriedade do pet e então retorna HTTP 409, sem revelar leituras não associadas.

Para habilitar persistência e leitura segura pelo site, será necessária uma associação administrativa de dispositivo a pet e uma tabela de leituras com, no mínimo, `device_id`, `sensor_detectou`, `contador_deteccoes`, `uptime_ms` e `recebido_em`, ligada à associação do dispositivo. Nenhuma tabela ou dado foi criado ou alterado nesta etapa.
