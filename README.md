# IRIS Engine

Motor do IRIS Hub: sugestões de IA (sentimento, tipificação, resposta) para Cases do Salesforce Service Cloud.

Stack: TypeScript, Node.js 22, Fastify 5, TypeBox (validação por JSON Schema), Vitest. Corre em Docker.

## Arranque rápido

```bash
# Docker
docker compose up --build
curl localhost:8080/healthz

# Local
npm ci
cp .env.example .env   # opcional
npm run dev
```

## Scripts

| Comando         | O que faz                                         |
| --------------- | ------------------------------------------------- |
| `npm run dev`   | Servidor com recarga automática                   |
| `npm run build` | Compila para `dist/`                              |
| `npm start`     | Corre a versão compilada                          |
| `npm test`      | Testes                                            |
| `npm run check` | Typecheck, lint, formatação e testes (usar no CI) |

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
test/                     testes Vitest com app.inject (sem rede)
```

## Convenções

- TypeScript estrito. Sem `any`.
- `process.env` só em `src/config.ts` (garantido por lint).
- Erros de domínio são `AppError` com `code` e `httpStatus`; nunca strings.
- Nunca registar o corpo dos pedidos nem credenciais.
