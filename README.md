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

| Variável                                                  | Omissão                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`                                                | `development`                                                                       |
| `HOST`                                                    | `0.0.0.0`                                                                           |
| `PORT`                                                    | `8080`                                                                              |
| `LOG_LEVEL`                                               | `info`                                                                              |
| `MAX_BODY_BYTES`                                          | `1048576`                                                                           |
| `SHUTDOWN_TIMEOUT_MS`                                     | `10000`                                                                             |
| `DATABASE_URL`                                            | _(vazio)_                                                                           |
| `MIGRATIONS_DIR`                                          | `migrations`                                                                        |
| `API_SECRET`                                              | _(vazio)_ — segredo partilhado com o Salesforce, ≥ 32 caracteres                    |
| `STEPACCESS_URL`, `_USER`, `_PASSWORD`, `_COMPONENT_UUID` | _(vazio)_ — todos ou nenhum                                                         |
| `STEPACCESS_TIMEOUT_MS`                                   | `3000`                                                                              |
| `STEPACCESS_BYPASS`                                       | `false` — proibido em produção                                                      |
| `OPENROUTER_API_KEY`                                      | _(vazio)_                                                                           |
| `OPENROUTER_BASE_URL`                                     | `https://openrouter.ai/api/v1`                                                      |
| `LLM_DEFAULT_MODEL`                                       | `google/gemini-2.5-flash`                                                           |
| `ENABLE_DIAGNOSTIC_TOOL`                                  | `false`                                                                             |
| `ADMIN_API_SECRET`                                        | _(vazio)_ — liga a API de administração; ≥ 32 caracteres, diferente do `API_SECRET` |

## Endpoints

| Método e caminho        | Função                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`          | Processo vivo                                                                                                                                      |
| `GET /readyz`           | Dependências acessíveis (200 ou 503, com estado por check)                                                                                         |
| `GET /v1/tools`         | Lista as ferramentas disponíveis (precisa de credencial)                                                                                           |
| `POST /v1/tools/<nome>` | Corre uma ferramenta (precisa de credencial)                                                                                                       |
| `POST /v1/compat/n8n`   | Aceita o pedido do IRIS Hub (n8n) com `action` e responde `{success, data}`. Hoje só `sentiment`; as outras ações dão 501 `not_implemented`        |
| `/v1/admin/*`           | API de administração para o StepAccess: estado, métricas, ferramentas, prompts, memórias, playground. Ver [`docs/ADMIN_API.md`](docs/ADMIN_API.md) |

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

Um pedido `POST /v1/tools/<nome>` passa sempre por estes passos, por esta ordem:

1. **Credencial:** `Authorization: Bearer <API_SECRET>`, comparada em tempo constante. Falha: **401**, antes de olhar para o corpo.
2. **Validação:** `orgId` (`00D…`, 18 caracteres), `userId` (`005…`, 18 caracteres), `version` opcional e os campos da ferramenta. Campos a mais são recusados. Falha: **422**, sem gastar utilização.
3. **Configuração da ferramenta:** modelo, temperatura, limites e prompt. A base de dados (`tool_config`, versão ativa em `prompt_version`) substitui os valores do código. Ferramenta desativada: **503**.
4. **StepAccess:** `GET /v1/access` com org, utilizador e o componente IRIS. Conta utilização. Sem acesso: **403** `access_denied`; limite atingido: **429** `quota_exceeded`; StepAccess indisponível ou resposta inesperada: **503** (falha fechada).
5. **Memórias:** as da org (regras da empresa, prevalecem) e as do utilizador, que valham para esta ferramenta. Entram no prompt numa secção própria, uma por linha.
6. **Modelo (OpenRouter):** resposta em JSON com o esquema da ferramenta, só em fornecedores que não guardam nem treinam com os dados (`data_collection: deny`). Indisponível: **502** `provider_unavailable`; tempo esgotado: **504** `timeout`.
7. **Validação da resposta:** se não cumprir o esquema, tenta uma segunda vez; à segunda falha: **502** `invalid_model_output`.

Resposta: `{ "tool": "<nome>", "version": <n>, "result": { … } }`. Nada é guardado: dos pedidos ficam só linhas de log com id, ferramenta, modelo, tokens, número de memórias e duração.

Uma ferramenta é um módulo em `src/tools/` (ver `src/tools/diagnostic.ts`): nome, versão, entrada, saída, prompt de origem e valores por omissão. O motor regista-a no catálogo `tool` ao arrancar.

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
    errors.ts             AppError: código estável + estado HTTP
    error-handler.ts      conversão de todos os erros para o formato comum
    routes/health.ts      /healthz e /readyz
    routes/tools.ts       /v1/tools e /v1/tools/<nome>, com a credencial
    routes/admin.ts       /v1/admin/* (docs/ADMIN_API.md)
  engine/
    tool.ts               o contrato de uma ferramenta
    run.ts                o caminho de um pedido (configuração, acesso, memórias, modelo, validação)
    access.ts             cliente do StepAccess (e o atalho para desenvolvimento)
    openrouter.ts         cliente do OpenRouter
    llm.ts                interface do fornecedor de modelos
    prompt.ts             junta o prompt da ferramenta com as memórias
    store.ts              o que o motor lê da base de dados; registo do catálogo de ferramentas
    metrics.ts            contadores agregados em memória (sem conteúdo)
    health.ts             verificações do StepAccess e do OpenRouter
    models.ts             catálogo de modelos do OpenRouter
  tools/
    index.ts              as ferramentas ativas
    diagnostic.ts         ferramenta de teste de ligação
  memory/
    limits.ts             limites das memórias (os mesmos da base de dados)
  admin/
    commands.ts           criar, alterar e apagar memórias
    tools.ts              configuração das ferramentas e versões dos prompts
    queries.ts            listar memórias e ferramentas
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
