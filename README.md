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

O backend recebe a telemetria do dispositivo em `POST /api/mabel/dados` e oferece consulta de status em `GET /api/mabel/status`. A autenticacao do dispositivo permanece no servidor e o segredo nao deve ser exposto ao frontend.

A configuracao do firmware, pinos e uso da rede local estao em [firmware/esp32-mabel/README.md](./firmware/esp32-mabel/README.md). O arquivo local `firmware/esp32-mabel/mabel_config.h`, com Wi-Fi e configuracao do dispositivo, e ignorado pelo Git.

### Persistencia da telemetria

`POST /api/mabel/dados` valida a autenticacao e o payload, depois grava atomicamente a leitura mais recente por dispositivo em `mabel_device_status` usando UPSERT. `persistida: true` so e retornado apos confirmacao do banco. `GET /api/mabel/status?pet_id=...` exige sessao autenticada, verifica a propriedade do pet e consulta somente o dispositivo associado; o horario precisa ser pelo menos um segundo posterior ao `linked_at` atual para compensar a precisao de segundos dessa coluna. A consulta autenticada do dispositivo tambem le do MySQL.

A migration `006_create_mabel_device_status.sql.template` e somente um template e nao foi aplicada. Execute-a apenas no banco aprovado, apos revisar o schema ativo.

Limitacao futura: `uptime_ms` e `contador_deteccoes`, isoladamente, nao ordenam perfeitamente as leituras depois de uma reinicializacao da ESP32. O protocolo do firmware nao foi ampliado nesta etapa.
