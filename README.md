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

| Variável              | Omissão       |
| --------------------- | ------------- |
| `NODE_ENV`            | `development` |
| `HOST`                | `0.0.0.0`     |
| `PORT`                | `8080`        |
| `LOG_LEVEL`           | `info`        |
| `MAX_BODY_BYTES`      | `1048576`     |
| `SHUTDOWN_TIMEOUT_MS` | `10000`       |
| `DATABASE_URL`        | _(vazio)_     |
| `MIGRATIONS_DIR`      | `migrations`  |

## Endpoints

| Método e caminho | Função                                                     |
| ---------------- | ---------------------------------------------------------- |
| `GET /healthz`   | Processo vivo                                              |
| `GET /readyz`    | Dependências acessíveis (200 ou 503, com estado por check) |

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
  memory/
    limits.ts             limites das memórias (os mesmos da base de dados)
  admin/
    commands.ts           criar memórias da org; apagar memórias
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
