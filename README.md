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
| `npm run tui`     | Interface interativa de administração                          |
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

| Método e caminho | Função                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| `GET /healthz`   | Processo vivo                                                                   |
| `GET /readyz`    | Dependências acessíveis (200 ou 503, com estado por check)                      |
| `GET /v1/whoami` | Com chave válida, diz a que cliente e org pertence. Serve para testar a ligação |

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

## Autenticação

Cada org Salesforce tem chaves de API. O Salesforce envia a chave em cada pedido:

```text
Authorization: Bearer iris_<8 hexadecimais>_<43 caracteres>
```

O serviço procura a chave pelo prefixo, compara o hash do segredo em tempo constante e fica a saber a org e o cliente. O `orgId` que vem no corpo do pedido tem de coincidir com o da chave (`assertOrgMatches`, 403 se não); o `userId` identifica quem, dentro dessa org, fez o pedido, e o utilizador é criado no primeiro pedido (`ensureOrgUser`).

- Sem chave, chave errada, revogada, expirada, ou org/cliente desativados: **401**, sempre com a mesma resposta (o motivo só vai para os logs).
- Base de dados indisponível durante a verificação: **503**, nunca 401.
- A chave é mostrada uma única vez, ao criá-la. A base de dados só guarda o hash.
- Até **2 chaves ativas por org**, para rodar sem paragem: criar a nova, atualizar o Salesforce, revogar a antiga.
- Em `NODE_ENV=production` o `DATABASE_URL` é obrigatório.

### Administração

Não há API de administração; faz-se pelo terminal, com uma **interface interativa** ou com comandos soltos.

#### Interface interativa

```bash
docker compose run --rm admin tui      # com Docker
npm run tui                            # sem Docker (precisa de DATABASE_URL)
```

Cinco separadores (`1`–`5`, ou `←` `→`): **Relações** (a árvore cliente → org → utilizadores e chaves), **Clientes**, **Orgs**, **Utilizadores** e **Chaves**. `?` mostra todos os atalhos.

| Tecla           | O que faz                                                                             |
| --------------- | ------------------------------------------------------------------------------------- |
| `n`             | Novo (cliente, org, utilizador ou chave, conforme o separador)                        |
| `o` · `u` · `k` | Clientes: nova org neste cliente · Orgs: novo utilizador · nova chave nesta org       |
| `a`             | Ativar / desativar um cliente ou uma org (desativar recusa as chaves)                 |
| `r`             | Revogar uma chave (pede confirmação)                                                  |
| `d`             | Apagar um utilizador e tudo o que é dele (mostra o que desaparece antes de confirmar) |
| `R` · `q`       | Recarregar · sair                                                                     |

A chave de API é mostrada **uma única vez**, ao criá-la. Funciona a partir de 80×24. Um utilizador pertence sempre a uma só org: "associar um utilizador a uma org" é criá-lo nessa org.

#### Comandos soltos

Para scripts e automação. Com Docker:

```bash
A="docker compose run --rm admin"

$A create-tenant --slug iris-dev --name "IRIS Dev"
$A create-org --tenant iris-dev --org-id 00DgL00000O7vLVUAZ \
  --instance-url https://orgfarm-9637ae9ebe-dev-ed.develop.my.salesforce.com --sandbox
$A create-key --org-id 00DgL00000O7vLVUAZ          # mostra a chave uma única vez
$A list-keys                                        # sem segredos
$A revoke-key --prefix <8 hexadecimais>

curl -H "Authorization: Bearer <chave>" localhost:8080/v1/whoami
```

Sem Docker, `npm run admin -- <comando> …` (precisa de `DATABASE_URL`). Opções: `--expires-in-days <n>` em `create-key`, `--retention-days <n>` em `create-tenant`.

## Base de dados

PostgreSQL 16, 3.ª forma normal. As migrações são ficheiros SQL em `migrations/`, aplicados por ordem e uma só vez (`npm run migrate`). Um ficheiro já aplicado não pode ser alterado: cria-se outro.

| Ficheiro                             | Conteúdo                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `0001_catalogs.sql`                  | Listas fechadas: ações, estados, erros, sentimentos, urgências, âmbitos    |
| `0002_identity.sql`                  | `tenant` → `sf_org` → `org_user`, e `api_credential`                       |
| `0003_memory.sql`                    | Memórias do cliente, da org ou do utilizador (exatamente um dono)          |
| `0004_configuration.sql`             | Modelos, configuração por ação, prompts versionados, níveis de tipificação |
| `0005_requests.sql`                  | `inference_request` e `llm_call`: só metadados, nunca o conteúdo dos Cases |
| `0006_results.sql`                   | Resultados de sentimento, tipificação e resposta                           |
| `0007_error_service_unavailable.sql` | Código de erro `service_unavailable` no catálogo                           |

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
    routes/whoami.ts      /v1/whoami
  auth/
    api-key.ts            gerar, ler e comparar chaves
    credential-store.ts   procura da chave na base de dados
    authenticate.ts       hook de autenticação e verificação do orgId
    org-user.ts           cria o utilizador no primeiro pedido
  admin/
    commands.ts           criar cliente, org, utilizador e chaves; revogar; ativar; apagar
    queries.ts            listas e árvore de relações
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
- Nunca registar o corpo dos pedidos nem credenciais.
