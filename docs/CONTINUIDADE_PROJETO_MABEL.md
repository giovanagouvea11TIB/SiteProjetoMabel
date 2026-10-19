# Continuidade do Projeto Mabel

Este documento registra o estado observado no repositório em 14/10/2026. Ele descreve o código versionado; não confirma a disponibilidade ou o conteúdo do banco de dados, de serviços externos ou do hardware.

## Objetivo

O Projeto Mabel apresenta e desenvolve uma solução assistiva para apoiar a estimulação motora e a reabilitação de cães com sequelas da cinomose. O repositório reúne o site público, áreas web autenticadas para perfis de pets e vacinas, uma API Node.js/MySQL e um firmware ESP32 experimental para envio de telemetria de um sensor SW-420.

O site também contém um jogo. O site público e o jogo estão fora do escopo das próximas alterações de continuidade descritas aqui e não devem ser alterados sem uma solicitação específica.

## Estrutura principal

| Caminho | Função observada |
| --- | --- |
| `index.html`, `pages/` | Páginas públicas: apresentação, produto, instruções, equipe, referências, cadastro, login e jogo. |
| `pages/jogo/` | Arquivos próprios do jogo público; preservar sem alterações nesta tarefa de continuidade. |
| `assets/images/` | Imagens, ícones e demais recursos visuais. |
| `styles/globals.css`, `pages/style.css` | Estilos globais e estilos da página inicial. |
| `js/script.js`, `js/api-response.js` | Comportamento compartilhado do site e utilitário comum de resposta da API. |
| `software/` | Páginas internas autenticadas: início, perfil, diário, vacinas e controle. |
| `backend/server.js` | Configura o Express, sessões, rotas da API, proteção das páginas internas e arquivos estáticos; inicia o servidor local. |
| `backend/routes/` | Rotas de autenticação, avatar, avaliação, pets, vacinas e telemetria Mabel. |
| `backend/middleware/require-auth.js` | Protege rotas e páginas que exigem sessão autenticada. |
| `backend/db.js`, `backend/database-config.js`, `backend/database-reads.js`, `backend/session-store.js` | Pool MySQL, configuração, repetição controlada de leituras e armazenamento de sessão. O armazenamento de sessão não cria a tabela automaticamente. |
| `backend/migrations/*.sql.template` | Modelos SQL para preparar estruturas de pets, vacinas e avatar. São modelos, não uma ferramenta de migração automática. |
| `backend/*test.js`, `backend/routes/*test.js`, `software/*/*.test.js`, `js/*test.js` | Testes automatizados declarados no script `test` do `package.json`. |
| `api/` | Adaptadores de entrada para as funções da Vercel, que encaminham requisições para a aplicação Express compartilhada. |
| `proxy.js`, `vercel.json` | Proteção/encaminhamento de páginas internas e rewrites da API na Vercel. |
| `firmware/esp32-mabel/` | Sketch Arduino para ESP32 e instruções de configuração e ligação do sensor. |
| `README.md` | Referência existente para variáveis, execução, Vercel e telemetria. Consultar junto a este documento; confirmar informações de infraestrutura antes de agir nelas. |
| `package.json`, `package-lock.json` | Dependências e comandos npm; o lockfile permite instalação reproduzível por `npm ci`. |

## Preparar e iniciar localmente

O `package.json` não declara uma versão mínima do Node.js. Instale uma versão de Node.js com npm compatível com as dependências e com a API `node:test` usada pelos testes.

1. Na raiz do repositório, instale as dependências registradas no lockfile:

   ```sh
   npm ci
   ```

2. Configure as variáveis necessárias no ambiente local ou em `.env` na raiz. Consulte a tabela do `README.md`; ela lista, entre outras, as configurações de MySQL e sessão. O servidor exige `DB_HOST`, `DB_USER` e `SESSION_SECRET`. `DB_PASSWORD` depende da configuração da conta. O banco esperado pelo código é `alunos_projetoMabel`; `DB_NAME`, quando usado em lugar de `DB_DATABASE`, deve apontar para o mesmo schema.

3. Prepare previamente o schema e a tabela de sessões. O servidor e o armazenamento de sessão não executam migrações nem criam essas tabelas na inicialização. Os arquivos `backend/migrations/*.sql.template` são modelos que exigem revisão e aprovação antes de qualquer execução.

4. Inicie a aplicação:

   ```sh
   npm start
   ```

   O servidor usa `PORT` ou, por padrão, a porta `3000`. O código exige `MABEL_DEVICE_TOKEN` válido para autenticar o dispositivo; sem essa configuração, a rota de telemetria não aceita o token do dispositivo. As credenciais Wi-Fi e a configuração local do firmware ficam no arquivo ignorado `firmware/esp32-mabel/mabel_config.h`, criado a partir de `mabel_config.example.h`.

O banco, os serviços de e-mail e o ESP32 não foram conectados ou verificados nesta passagem. A configuração de ambiente precisa ser validada pela equipe responsável, sem compartilhar os valores.

## Testes

O comando configurado no `package.json` é:

```sh
npm test
```

Ele executa testes Node.js para banco/runtime, deployment e rewrites da API, rotas Mabel/pets/vacinas/avatar, estado de home e vacinas, e o utilitário de respostas da API.

**Resultado desta revisão:** Node.js `v24.22.0` e npm `11.19.1` estão disponíveis, mas `node_modules` não está presente. `npm test` foi executado sem instalar dependências: 58 testes foram descobertos, 56 passaram e 2 arquivos de teste falharam ao carregar módulos ausentes (`express-mysql-session` em `backend/database-runtime.test.js` e `express` em `backend/routes/mabel.test.js`). Portanto, a suíte não passou integralmente; os 56 testes aprovados são apenas os que puderam ser executados. Não foram executados testes manuais de navegador, integração com MySQL, Vercel ou hardware. Não foi feita instalação de dependências.

## API, autenticação e comunicação com ESP32

### Aplicação web e API

O backend comum está em `backend/server.js`; em ambiente local ele também serve os arquivos do projeto. A entrada serverless em `api/[...path].js` encaminha para a mesma aplicação, e `vercel.json` define rewrites de perfil, vacinas e Mabel.

As rotas principais observadas são:

- `/api/auth/cadastro`, `/api/auth/login`, `/api/auth/logout` e `/api/auth/sessao`: cadastro, sessão e autenticação. A senha é armazenada como hash bcrypt; o login regenera e salva a sessão.
- `/api/auth/avatar`: operações de avatar autenticadas.
- `/api/perfil/pet`: listagem, criação, atualização e remoção de pets autenticados.
- `/api/vacinas/...`: notificações, registros e catálogo de vacinas vinculados a pets.
- `/api/mabel/dados` e `/api/mabel/status`: recepção de telemetria e consulta de status.
- `/api/status` e `/api/teste-db`: status simples do serviço e teste de conexão MySQL, respectivamente.

As sessões usam cookie `mabel.sid` com `httpOnly`, `SameSite=Lax`, validade de oito horas e `Secure` em produção/Vercel. As páginas sob `/software` exigem sessão; rotas de perfil e vacinas também aplicam autenticação. O CORS permite requisições sem `Origin` e o servidor local em `localhost`/`127.0.0.1:5500`, conforme a configuração atual.

### ESP32 e telemetria

O firmware em `firmware/esp32-mabel/esp32-mabel.ino` lê o sinal digital do SW-420 no GPIO 27, aciona um LED no GPIO 25 e tenta enviar uma leitura a cada cinco segundos via HTTP. O corpo enviado inclui `device_id`, `sensor_detectou`, `contador_deteccoes` e `uptime_ms`. A documentação do firmware recomenda usar o endereço IP local do computador, não `localhost`, quando o ESP32 acessa o servidor local. O firmware documentado não aciona motores e não calcula intensidade clínica.

`POST /api/mabel/dados` exige autenticacao do dispositivo, valida o payload e grava por UPSERT a leitura mais recente em `mabel_device_status`. Retorna `persistida: true` somente apos confirmar a gravacao. O status autenticado pelo dispositivo tambem consulta a leitura persistida no MySQL.

Sem autenticacao do dispositivo, `GET /api/mabel/status?pet_id=...` exige sessao web, verifica que o pet pertence ao usuario e consulta somente o dispositivo associado. Sem associacao e sem leitura atual sao estados distintos. As rotas de associacao nao aceitam `usuario_id` enviado pelo cliente. As migrations 005 e 006 sao templates e nao foram aplicadas ao banco real.

## Estado funcional e validação

### Implementado no código (não equivale a validação em produção)

- Site público e páginas internas, com as rotas e funcionalidades web listadas acima.
- Sessões MySQL, cadastro/login e rotas de perfil e vacinas dependentes do schema apropriado.
- Recebe, valida e persiste no MySQL a telemetria mais recente da ESP32.
- Esboço de firmware para leitura do sensor e envio periódico dos campos definidos.

### Verificação efetivamente obtida nesta passagem

- `npm test` concluiu com 81 testes aprovados e nenhuma falha.
- `git diff --check` concluiu sem erros.
- Os testes usam banco mockado; nenhuma migration foi aplicada e nenhum banco real ou ESP32 foi acessado nesta passagem.

## Vínculo persistente dispositivo–pet

O backend implementa associação ativa 1:1 entre dispositivo e pet. A associação pertence ao usuário que possui o pet; unicidade no banco impede associar um dispositivo ou pet mais de uma vez. Desvincular remove a linha e permite reassociar o dispositivo. Excluir o pet remove o vínculo por `ON DELETE CASCADE`. A ESP32 continua enviando `device_id`; o vínculo não altera o firmware.

O status web exige que `ultimo_contato` seja pelo menos um segundo posterior ao `linked_at` atual. A coluna `linked_at` tem precisao de segundos; essa margem evita classificar como atual uma leitura anterior na mesma janela de segundo, mas pode atrasar brevemente a exibicao de uma leitura valida.

A tabela guarda uma linha por dispositivo e substitui a leitura anterior, sem manter historico ilimitado de eventos. Ela nao tem FK para a associacao; a ESP32 pode transmitir antes do pareamento e a linha permanece apos desvincular.

## Persistência das leituras

A migration `006_create_mabel_device_status.sql.template` define a leitura mais recente por `device_id`, com sensor, contador, uptime e `ultimo_contato`. A tabela nao tem FK para associacoes.

As migrations 005 e 006 sao templates e nao foram executadas; o schema ativo nao foi consultado. Limitacao futura: `uptime_ms` e `contador_deteccoes` nao ordenam perfeitamente leituras apos reinicializacoes da ESP32. O protocolo do firmware nao foi alterado.

## Próxima tarefa recomendada

**Revisar e aplicar as migrations 005 e 006 no banco aprovado** apos confirmar o schema ativo e obter autorizacao.

Arquivos e superfícies a considerar após a decisão:

- `backend/routes/mabel.js`: persistência da leitura, consulta e verificação de associação.
- `backend/migrations/005_create_mabel_pet_associations.sql.template` e `backend/migrations/006_create_mabel_device_status.sql.template`: templates ainda nao aplicados.
- `backend/routes/mabel.test.js`: cobertura de autenticacao, acesso ao pet, gravacao e consulta persistidas.
- `backend/routes/pets.js` ou uma nova rota administrativa/dispositivos: somente se a decisão incluir gerenciamento de associação pela aplicação.
- `software/controle/`: interface de estado do dispositivo, somente se o escopo aprovado incluir essa superfície.
- `firmware/esp32-mabel/esp32-mabel.ino`: alterar apenas se o modelo aprovado exigir campos ou comportamento adicional do dispositivo.

Critérios de conclusão recomendados:

1. O fluxo aprovado associa cada dispositivo a um pet e define quem pode criar, alterar e remover essa associação.
2. A leitura válida é gravada de forma durável com identificador do dispositivo, estado do sensor, contador, uptime e horário de recebimento.
3. A API web só devolve leituras de um dispositivo associado a um pet pertencente ao usuário autenticado; pet sem vínculo e vínculo de outro usuário não revelam leituras.
4. Testes automatizados cobrem sucesso, validação, autenticação, associação ausente/incorreta, persistência e falhas do banco.
5. Migração, execução no banco correto e eventual teste com firmware são revisados e autorizados separadamente.

## Cuidados de ambiente, banco e publicação

- Nunca adicionar valores de `.env`, credenciais, tokens, dados pessoais ou a configuração real do firmware ao Git. Não copiar valores de desenvolvimento para Preview/Production sem autorização.
- O token de dispositivo deve ser configurado apenas nos ambientes apropriados do backend e no arquivo local ignorado do firmware. Não o registrar em logs ou enviar por HTTP em rede pública.
- Confirmar ambiente e schema MySQL antes de qualquer operação. Não executar modelos/migrações em banco de produção sem revisão, autorização, plano de backup e procedimento de reversão.
- Não presumir que as tabelas de sessão ou aplicação existem porque o servidor inicia localmente: a aplicação não faz criação automática de schema.
- Na Vercel, configure segredos no ambiente correto, considere pools de banco por instancia e confirme a necessidade de TLS do provedor.
- Não publicar nem alterar configurações de produção como parte da continuidade. Validar testes e ambiente de Preview antes de qualquer publicação, que exige autorização própria.

## Fora do escopo: site público e jogo

Não alterar o site público em `index.html` e `pages/`, nem o jogo em `pages/jogo/` ou seus recursos/estilos, para resolver a persistência do dispositivo. Essas superfícies devem permanecer como estão, salvo solicitação explícita da equipe.
