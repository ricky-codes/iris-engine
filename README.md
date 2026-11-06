# IRIS Engine

Motor de IA da IRIS: recebe um pedido do Salesforce, confirma no StepAccess que o utilizador tem acesso, junta as memórias da org e do utilizador e devolve a resposta da IA.

Orgs, utilizadores, licenças e contagem de utilização vivem só no **StepAccess**. A IRIS guarda apenas memórias, prompts, modelos e a configuração das ferramentas, e nunca guarda pedidos nem respostas.

Stack: TypeScript, Node.js 22, Fastify 5, TypeBox (validação por JSON Schema), Vitest. Corre em Docker.

## Arranque rápido

```bash
# Docker (Postgres + migrações + serviço)
docker compose up --build
curl localhost:8080/readyz
# Se a porta 8080 ou a 55432 estiverem ocupadas: PORT=8081 POSTGRES_PORT=55433 docker compose up --build

# Local
npm ci
cp .env.example .env   # opcional
npm run dev
```

## Deploy no servidor

```bash
cd ~/iris-engine
./deploy.sh              # git pull, backup da BD, rebuild, espera pelo serviço saudável
./deploy.sh --no-pull    # sem git pull (usa o código que lá está)
./deploy.sh --no-backup  # sem backup da base de dados
```

O script confirma primeiro que o `.env` tem tudo o que a produção exige (sem mostrar valores), guarda um backup em `backups/` (os últimos 14) e no fim diz se o motor e a API de administração ficaram ligados. Use-o em vez de `docker compose restart`, que não relê o `.env`.

## Scripts

| Comando           | O que faz                                                      |
| ----------------- | -------------------------------------------------------------- |
| `npm run dev`     | Servidor com recarga automática                                |
| `npm run build`   | Compila para `dist/`                                           |
| `npm start`       | Corre a versão compilada                                       |
| `npm run migrate` | Aplica as migrações SQL (precisa de `DATABASE_URL`)            |
| `npm run tui`     | Interface interativa das memórias                              |
| `npm test`        | Testes (os de base de dados só correm com `TEST_DATABASE_URL`) |
| `npm run check`   | Typecheck, lint, formatação e testes (usar no CI)              |

## Configuração

Variáveis de ambiente, validadas no arranque (`src/config.ts`). Com configuração inválida, o processo termina com código 1 e a lista de problemas. Ver `.env.example`.

As marcadas com **(definição)** são só o valor inicial: mudam-se sem reiniciar em `PATCH /v1/admin/settings` e o valor gravado na base de dados (`engine_setting`) prevalece. Cada instância volta a ler a tabela a cada 30 s. Os limites das memórias (500 caracteres, 50 por org, 20 por utilizador) também são definições, sem variável de ambiente. Ver [`docs/ADMIN_API.md`](docs/ADMIN_API.md#56-definições).

| Variável                                                  | Omissão                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `development`                                                                                 |
| `HOST`                                                    | `0.0.0.0`                                                                                     |
| `PORT`                                                    | `8080`                                                                                        |
| `LOG_LEVEL`                                               | `info`                                                                                        |
| `MAX_BODY_BYTES`                                          | `1048576`                                                                                     |
| `SHUTDOWN_TIMEOUT_MS`                                     | `10000`                                                                                       |
| `DATABASE_URL`                                            | _(vazio)_                                                                                     |
| `MIGRATIONS_DIR`                                          | `migrations`                                                                                  |
| `API_SECRET`                                              | _(vazio)_ — segredo partilhado com o Salesforce, ≥ 32 caracteres                              |
| `STEPACCESS_URL`, `_USER`, `_PASSWORD`, `_COMPONENT_UUID` | _(vazio)_ — todos ou nenhum                                                                   |
| `STEPACCESS_TIMEOUT_MS`                                   | `3000` — (definição) 100 a 30000                                                              |
| `STEPACCESS_USAGE_TIMEOUT_MS`                             | `10000` — (definição) tempo máximo do envio do custo, em segundo plano (100 a 60000)          |
| `STEPACCESS_BYPASS`                                       | `false` — proibido em produção                                                                |
| `ACCESS_MODE`                                             | `stepaccess` — ou `open`: acesso só pelo `API_SECRET`, sem StepAccess (permitido em produção) |
| `OPENROUTER_API_KEY`                                      | _(vazio)_                                                                                     |
| `OPENROUTER_BASE_URL`                                     | `https://openrouter.ai/api/v1`                                                                |
| `LLM_DEFAULT_MODEL`                                       | `google/gemini-2.5-flash` — (definição)                                                       |
| `LLM_FALLBACK_MODELS`                                     | _(vazio)_ — (definição) modelos de recurso por omissão, separados por vírgulas (máximo 3)     |
| `LLM_TOTAL_TIMEOUT_MS`                                    | `30000` — (definição) teto de tempo das chamadas ao modelo de um pedido (2000 a 115000)       |
| `LLM_MAX_ATTEMPTS`                                        | `2` — (definição) tentativas por modelo até obter uma resposta válida (1 a 5)                 |
| `LLM_BREAKER_THRESHOLD`, `LLM_BREAKER_OPEN_MS`            | `3` falhas seguidas (1 a 20) e `60000` ms (1000 a 3600000) com o modelo saltado (definição)   |
| `STREAM_ENABLED`                                          | `true` — (definição) `false` recusa `"stream": true` em todas as ferramentas                  |
| `RATE_LIMIT_PER_MINUTE`                                   | `0` — (definição) pedidos por minuto e por org, por instância (429 acima); 0 = sem limite     |
| `ENABLE_DIAGNOSTIC_TOOL`                                  | `false`                                                                                       |
| `ADMIN_API_SECRET`                                        | _(vazio)_ — liga a API de administração; ≥ 32 caracteres, diferente do `API_SECRET`           |

## Endpoints

| Método e caminho           | Função                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`             | Processo vivo                                                                                                                                                             |
| `GET /readyz`              | Dependências acessíveis (200 ou 503, com estado por check)                                                                                                                |
| `GET /v1/tools`            | Lista as ferramentas disponíveis e se aceitam streaming (precisa de credencial)                                                                                           |
| `POST /v1/tools/<nome>`    | Corre uma ferramenta (precisa de credencial). Com `"stream": true`, responde em SSE (ver [Streaming](#streaming))                                                         |
| `GET /v1/memories`         | Regras da org e memórias do utilizador (`?orgId=…&userId=…`, opcional `&tool=…`). Precisa de credencial; não conta utilização no StepAccess                               |
| `POST /v1/memories`        | Guarda uma memória do utilizador (`{orgId, userId, content, tools?}`). Precisa de credencial; não conta utilização                                                        |
| `DELETE /v1/memories/<id>` | Apaga uma memória do próprio utilizador (`?orgId=…&userId=…`); as da org e as de colegas dão 404                                                                          |
| `/v1/admin/*`              | API de administração para o StepAccess: estado, métricas, topologia, definições, ferramentas, prompts, memórias, playground. Ver [`docs/ADMIN_API.md`](docs/ADMIN_API.md) |

Todas as respostas levam `X-Request-Id`. Os erros têm sempre este formato:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "O pedido não é válido.",
    "details": [{ "path": "body.age", "issue": "must be >= 0" }],
    "requestId": "…"
  }
}
```

## Motor

Um pedido `POST /v1/tools/<nome>` passa sempre por estes passos, por esta ordem (os mesmos ids de `src/engine/pipeline.ts`, que a consola mostra em `GET /v1/admin/tools/:name/pipeline`):

1. **Pedido** (`request`): `Authorization: Bearer <API_SECRET>`, comparada em tempo constante (falha: **401**, antes de olhar para o corpo); depois `orgId` (`00D…`, 18 caracteres), `userId` (`005…`, 18 caracteres), `version` opcional e os campos da ferramenta. Campos a mais são recusados. Falha: **422**, sem gastar utilização.
2. **Ligada** (`gate`): modelo, temperatura, limites e prompt. A base de dados (`tool_config`, versão ativa em `prompt_version`) substitui os valores do código. Ferramenta desativada: **503** `tool_disabled`. `stream: true` com o streaming desligado (na ferramenta ou em geral): **422**.
3. **Limite de pedidos** (`rate`): pedidos por minuto e por org, por instância. Com um limite próprio da ferramenta, conta à parte (por org e ferramenta). Acima: **429** `rate_limited`, com `Retry-After`.
4. **Acesso** (`access`): `GET /v1/access` ao StepAccess com org, utilizador e o componente IRIS. Conta utilização. Sem acesso: **403** `access_denied`; limite atingido: **429** `quota_exceeded`; StepAccess indisponível ou resposta inesperada: **503** `service_unavailable` (falha fechada).
5. **Memórias** (`memories`): as da org (regras da empresa, prevalecem) e as do utilizador, que valham para esta ferramenta.
6. **Prompt** (`prompt`): as memórias entram no prompt numa secção própria, uma por linha.
7. **Cadeia de modelos** (`models`, OpenRouter): resposta em JSON com o esquema da ferramenta, só em fornecedores que não guardam nem treinam com os dados (`data_collection: deny`); modelos de recurso e disjuntor por modelo. Indisponível: **502** `provider_unavailable`; tempo esgotado: **504** `timeout`.
8. **Validação** (`validate`): se a resposta não cumprir o esquema, tenta de novo no mesmo modelo (`maxAttempts`, 2 por omissão) e depois passa ao seguinte; no fim: **502** `invalid_model_output`.
9. **Resposta** (`response`): JSON ou SSE; o custo vai para o StepAccess em segundo plano.

Resposta: `{ "tool": "<nome>", "version": <n>, "result": { … } }`. Nada é guardado: dos pedidos ficam só linhas de log com id, ferramenta, modelo, tokens, número de memórias e duração.

Uma ferramenta é um módulo em `src/tools/` (ver `src/tools/diagnostic.ts`): nome, versão, entrada, saída, prompt de origem e valores por omissão. O motor regista-a no catálogo `tool` ao arrancar.

### Streaming

Algumas ferramentas têm um campo de texto livre na resposta (declaram `stream: { field }` em `src/tools/`). O pedido escolhe se quer a resposta em streaming, com `"stream": true` no corpo; sem isso, ou com `false`, a resposta é o JSON de sempre. `GET /v1/tools` diz quais as ferramentas que o aceitam (`streaming: true`); noutras, `stream: true` dá **422**. Hoje só a `diagnostic`. O streaming desliga-se em geral (`streamEnabled`) ou só numa ferramenta (`PUT /v1/admin/tools/:name/config`).

```bash
curl -N -X POST localhost:8080/v1/tools/diagnostic \
  -H "Authorization: Bearer <API_SECRET>" -H 'Content-Type: application/json' \
  -d '{"orgId":"00D…","userId":"005…","message":"Olá IRIS","stream":true}'
```

A resposta é `text/event-stream`, com estes eventos (`data` é sempre JSON):

| Evento   | Quando                                                                                        | `data`                                         |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `start`  | Passaram a credencial, a validação, a configuração e o acesso; vai chamar-se o modelo         | `{tool, version, requestId}`                   |
| `delta`  | Mais um pedaço do campo de texto                                                              | `{text}`                                       |
| `reset`  | Deitar fora o texto recebido: vem aí outra tentativa (resposta inválida ou modelo de recurso) | `{}`                                           |
| `result` | O fim: o JSON completo e validado, igual ao do pedido sem streaming                           | `{tool, version, result}`                      |
| `error`  | Falhou depois de começar. Mesmo formato dos erros normais                                     | `{error: {code, message, details, requestId}}` |

- Os erros **anteriores** ao `start` (credencial, validação, ferramenta desligada, limite de pedidos, sem acesso) saem como JSON normal, com o estado HTTP de sempre (401, 422, 403…). Depois do `start` o estado já seguiu (200) e os erros vão no evento `error`.
- O texto dos `delta` é provisório: só o `result` está validado. Se chegar `reset` ou `error`, o cliente deve descartar o que mostrou.
- Utilização, custo e métricas contam exatamente como num pedido normal.

### Experimentar com o OpenRouter

No `.env` (nunca no Git):

```bash
API_SECRET=<openssl rand -base64 48>
STEPACCESS_BYPASS=true          # enquanto o StepAccess não estiver ligado (proibido em produção)
OPENROUTER_API_KEY=sk-or-...
ENABLE_DIAGNOSTIC_TOOL=true
```

Depois de `docker compose up --build`:

```bash
curl -s -X POST localhost:8080/v1/tools/diagnostic \
  -H "Authorization: Bearer <API_SECRET>" -H 'Content-Type: application/json' \
  -d '{"orgId":"00DgL00000O7vLVUAZ","userId":"005gL00000GpOQTQA3","message":"Olá IRIS, estás a funcionar?"}'
```

Para ver as memórias a funcionar, crie uma regra da org e repita o pedido:
`docker compose run --rm admin add-org-memory --org-id 00DgL00000O7vLVUAZ --text "Responder sempre a rimar."`

Sem a configuração completa, o serviço arranca só com `/healthz` e `/readyz` e diz no log o que falta.

## Administração das memórias

Orgs e utilizadores **não** se criam aqui: gerem-se no StepAccess. Na IRIS só se gerem memórias.

- **Memórias da org:** regras da empresa, válidas para todos os utilizadores da org. Só um admin da Step as cria. Em conflito com uma memória de utilizador, ganha a da org.
- **Memórias de utilizador:** nascem quando o utilizador pede à IRIS para se lembrar de algo. O admin só as vê e apaga.
- Limites: 50 memórias por org, 20 por utilizador, 500 caracteres cada (garantidos pela base de dados).
- Uma memória pode valer para todas as ferramentas ou só para algumas.

### Interface interativa

```bash
docker compose run --rm admin tui      # com Docker
npm run tui                            # sem Docker (precisa de DATABASE_URL)
```

Dois separadores (`1`–`2`, ou `←` `→`): **Memórias da org** e **Memórias de utilizadores**. `n` cria uma memória da org, `d` apaga a selecionada (pede confirmação), `R` recarrega, `?` mostra os atalhos, `q` sai. Funciona a partir de 80×24.

### Comandos soltos

```bash
A="docker compose run --rm admin"

$A list-memories [--org-id 00D…] [--user-id 005…]
$A add-org-memory --org-id 00DgL00000O7vLVUAZ --text "Tratar sempre o cliente por você." [--tool reply]
$A delete-memory --id <uuid>
$A delete-memories --org-id 00D… [--user-id 005…]   # quando a org ou o utilizador sai do StepAccess
```

Sem Docker, `npm run admin -- <comando> …` (precisa de `DATABASE_URL`). Em `NODE_ENV=production` o `DATABASE_URL` é obrigatório.

## Base de dados

PostgreSQL 16, 3.ª forma normal. As migrações são ficheiros SQL em `migrations/`, aplicados por ordem e uma só vez (`npm run migrate`). Um ficheiro já aplicado não pode ser alterado: cria-se outro.

| Ficheiro                            | Conteúdo                                                                |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `0001`–`0007`                       | Modelo inicial (catálogos, identidade, memórias, pedidos, resultados)   |
| `0008_motor_de_ferramentas.sql`     | Sem pedidos nem resultados; "ação" passa a "ferramenta"                 |
| `0009_identidade_no_stepaccess.sql` | Sem clientes, orgs, utilizadores nem chaves; memórias por id Salesforce |

Ficam 12 tabelas: catálogos (`tool`, `ai_provider`, `memory_scope`, `memory_source`), memórias (`memory`, `org_memory`, `user_memory`, `memory_tool`) e configuração (`llm_model`, `tool_config`, `prompt`, `prompt_version`).

Regras garantidas pela própria base de dados: uma memória tem exatamente um dono (uma org ou um utilizador); as memórias da org têm sempre origem admin; os limites por dono não se furam nem com inserções simultâneas; uma versão de prompt publicada não muda.

Testes de base de dados, com um Postgres local:

```bash
docker run -d --name iris-pg -e POSTGRES_USER=iris -e POSTGRES_PASSWORD=iris -e POSTGRES_DB=iris -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://iris:iris@localhost:55432/iris npm test
```

Cada teste cria um schema próprio e apaga-o no fim.

## Estrutura

```text
src/
  server.ts               arranque e encerramento ordenado
  app.ts                  construção da app Fastify (usada também nos testes)
  config.ts               leitura e validação do ambiente (único sítio com process.env)
  http/
    errors.ts             AppError: código estável + estado HTTP; tradução dos erros do motor
    error-handler.ts      conversão de todos os erros para o formato comum
    routes/health.ts      /healthz e /readyz
    routes/tools.ts       /v1/tools e /v1/tools/<nome>, com a credencial
    routes/memories.ts    /v1/memories: o utilizador vê, cria e apaga as suas memórias
    routes/admin.ts       /v1/admin/* (docs/ADMIN_API.md)
  engine/                 o motor: não importa do servidor, dos adaptadores nem da configuração (regra de lint)
    engine.ts             a porta de entrada: createEngine({ settings, tools, access, store, memories, llm })
                          → run, preview, trial, tools, memories; valida a entrada; emite eventos
    tool.ts               o contrato de uma ferramenta
    run.ts                os passos de um pedido (configuração, acesso, memórias, cadeia de modelos, validação)
    breaker.ts            disjuntor por modelo, em memória (estado completo, reconfigurável, fecho à mão)
    pipeline.ts           os passos de um pedido, a marca do passo em cada erro e os tempos por passo
    rate-limit.ts         limite de pedidos por chave e minuto, com o limite de cada pedido
    live.ts               Live<T>: um valor fixo ou lido de novo em cada uso
    errors.ts             EngineError: código estável, sem estado HTTP
    access.ts             interface de quem decide o acesso
    llm.ts                interface do fornecedor de modelos
    store.ts              interface da configuração das ferramentas que o motor lê
    memory.ts             memórias de orgs e utilizadores: guardar, ver, alterar, apagar, juntar ao prompt; limites
    usage.ts              interface de quem recebe o custo de cada pedido
    prompt.ts             junta o prompt da ferramenta com as memórias
    stream.ts             extrai, do JSON que chega aos bocados, o campo de texto a enviar em streaming
    metrics.ts            contadores agregados em memória (sem conteúdo)
  adapters/               as implementações das interfaces do motor, montadas em server.ts
    stepaccess-access.ts  cliente do GET /v1/access do StepAccess
    stepaccess-usage.ts   envio do custo ao StepAccess
    open-access.ts        acesso sem StepAccess (ACCESS_MODE=open e STEPACCESS_BYPASS)
    openrouter.ts         cliente do OpenRouter
    openrouter-models.ts  catálogo de modelos do OpenRouter
    postgres-store.ts     configuração das ferramentas; registo do catálogo de ferramentas
    postgres-memory-store.ts  as memórias no Postgres
    postgres-settings-store.ts  as definições na tabela engine_setting
    health.ts             verificações do StepAccess e do OpenRouter
    fetch.ts              o tipo do fetch que os adaptadores recebem
  settings/
    settings.ts           as definições alteráveis sem reiniciar: valores, limites, validação, leitura periódica
  tools/
    index.ts              as ferramentas ativas
    diagnostic.ts         ferramenta de teste de ligação
  admin/
    commands.ts           criar, alterar e apagar memórias (valida os ids do Salesforce e passa ao motor)
    tools.ts              configuração das ferramentas e versões dos prompts
    queries.ts            listar memórias e ferramentas
    topology.ts           os módulos, ligações e estado (função pura)
    modules.ts            os cinco adaptadores descritos: função, definições e o que falta controlar
    pipeline.ts           o caminho de um pedido a uma ferramenta, para o diagrama da consola (função pura)
    topology-source.ts    junta o que está a correr numa topologia
    status.ts             o que o /v1/admin/status mostra
    validation.ts         validações dos dados que o administrador escreve
    api.ts                o que a interface pode fazer (e a versão sobre a base de dados)
    cli.ts                `npm run admin`
    tui/                  interface de terminal (Ink): ecrã, tabela, formulário, avisos
  db/
    pool.ts               ligação ao Postgres
    migrate.ts            runner de migrações (transação por ficheiro, checksum, bloqueio)
    migrate-cli.ts        `npm run migrate`
migrations/               SQL versionado
test/                     testes Vitest (app.inject; test/db/ contra Postgres real)
```

## Convenções

- TypeScript estrito. Sem `any`.
- `process.env` só em `src/config.ts` (garantido por lint).
- Erros de domínio são `AppError` com `code` e `httpStatus`; nunca strings.
- Nunca registar o corpo dos pedidos, o texto das memórias nem credenciais.
