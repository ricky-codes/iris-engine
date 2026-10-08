# IRIS Engine

Motor do IRIS Hub: sugestões de IA (sentimento, tipificação, resposta) para Cases do Salesforce Service Cloud.

Stack: TypeScript, Node.js 22, Fastify 5, TypeBox (validação por JSON Schema), Vitest. Corre em Docker.

## Arranque rápido

```bash
# Docker (Postgres + migrações + serviço)
docker compose up --build
curl localhost:8080/readyz

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

## Base de dados

PostgreSQL 16, 3.ª forma normal. As migrações são ficheiros SQL em `migrations/`, aplicados por ordem e uma só vez (`npm run migrate`). Um ficheiro já aplicado não pode ser alterado: cria-se outro.

| Ficheiro                 | Conteúdo                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `0001_catalogs.sql`      | Listas fechadas: ações, estados, erros, sentimentos, urgências, âmbitos    |
| `0002_identity.sql`      | `tenant` → `sf_org` → `org_user`, e `api_credential`                       |
| `0003_memory.sql`        | Memórias do cliente, da org ou do utilizador (exatamente um dono)          |
| `0004_configuration.sql` | Modelos, configuração por ação, prompts versionados, níveis de tipificação |
| `0005_requests.sql`      | `inference_request` e `llm_call`: só metadados, nunca o conteúdo dos Cases |
| `0006_results.sql`       | Resultados de sentimento, tipificação e resposta                           |

Regras garantidas pela própria base de dados (e não só pela aplicação): uma memória tem exatamente um dono; um resultado só existe para a ação certa; um nível de tipificação pertence ao cliente do pedido; o prompt de uma chamada é da ação do pedido; uma versão de prompt publicada não muda. Apagar um utilizador apaga os pedidos, resultados e memórias dele.

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
- Nunca registar o corpo dos pedidos nem credenciais.
