# Contrato: custo de cada pedido (IRIS → StepAccess)

Depois de cada pedido que chega ao modelo de IA, a IRIS envia o custo ao StepAccess. O StepAccess guarda cada evento e faz as somas (por org, utilizador, ferramenta e mês) no StepHub. A IRIS não guarda nada.

## Pedido

```
POST {STEPACCESS_URL}/v1/usage/cost
Authorization: Basic <as mesmas credenciais que a IRIS usa no GET /v1/access>
Content-Type: application/json
```

```json
{
  "componentUuid": "727d9c0c-c45e-4a6e-8691-3b9390251489",
  "requestId": "6f1c2a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
  "orgId": "00DQJ000003ve3p2AA",
  "userId": "0052p000009HeSzAAK",
  "tool": "sentiment",
  "outcome": "success",
  "model": "google/gemini-2.5-flash",
  "attempts": 1,
  "inputTokens": 1240,
  "outputTokens": 152,
  "costUsd": 0.00041,
  "occurredAt": "2026-10-25T10:15:32.481Z"
}
```

| Campo           | Tipo              | Significado                                                                                                                 |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `componentUuid` | string (UUID)     | O componente IRIS no StepAccess (o mesmo do `GET /v1/access`).                                                              |
| `requestId`     | string (UUID)     | Id do pedido na IRIS, igual ao cabeçalho `X-Request-Id` devolvido ao Salesforce. **Único**: serve de chave de idempotência. |
| `orgId`         | string, 18 car.   | Id Salesforce da org (`00D…`), o mesmo enviado no `GET /v1/access`.                                                         |
| `userId`        | string, 18 car.   | Id Salesforce do utilizador (`005…`).                                                                                       |
| `tool`          | string            | Ferramenta: `sentiment` (hoje), depois `tipification`, `reply`, …                                                           |
| `outcome`       | string            | `success` (resposta válida) ou `invalid_model_output` (o modelo falhou o formato nas duas tentativas, mas foi pago).        |
| `model`         | string            | Modelo que respondeu, como o OpenRouter o indica.                                                                           |
| `attempts`      | inteiro, 1 ou 2   | Chamadas ao modelo neste pedido. O custo já é a soma de todas.                                                              |
| `inputTokens`   | inteiro ou `null` | Tokens de entrada (todas as tentativas).                                                                                    |
| `outputTokens`  | inteiro ou `null` | Tokens de saída (todas as tentativas).                                                                                      |
| `costUsd`       | número ou `null`  | Custo em dólares (créditos OpenRouter). Valores muito pequenos (ex.: `0.00041`). `null` se o fornecedor não o indicou.      |
| `occurredAt`    | string (ISO 8601) | Quando a IRIS terminou o pedido, em UTC.                                                                                    |

## Respostas esperadas

| Estado           | Quando                   | O que a IRIS faz                    |
| ---------------- | ------------------------ | ----------------------------------- |
| `201` (ou `200`) | Registado                | Nada                                |
| `409`            | `requestId` já registado | Considera entregue                  |
| `400` / `422`    | Corpo inválido           | Não repete; escreve o evento no log |
| `401`            | Credenciais erradas      | Não repete; escreve o evento no log |
| `5xx` / sem rede | Erro do StepAccess       | Repete uma vez após 1 s; depois log |

O corpo da resposta é ignorado. O tempo limite é o mesmo do `GET /v1/access` (`STEPACCESS_TIMEOUT_MS`, 3 s por omissão).

## Regras

- **Idempotência.** O mesmo `requestId` pode chegar duas vezes (repetição após timeout). Guardar só uma vez e responder `409` ou `200`.
- **Não mexe no acesso.** Este endpoint só regista custo. A contagem de utilização continua a ser feita no `GET /v1/access`, como hoje.
- **Quando há evento.** Só para pedidos que chegaram ao modelo. Pedidos recusados antes (sem acesso, quota esgotada, corpo inválido) e falhas do fornecedor (502 `provider_unavailable`, 504 `timeout`) não geram evento. O playground da API de administração também não.
- **Fora do caminho do Salesforce.** A IRIS envia o custo em paralelo e não espera pela resposta do StepAccess para responder ao Salesforce. Uma falha aqui nunca afeta o utilizador.
- **Recuperação.** Se o envio falhar, a IRIS escreve no log a linha `stepaccess cost not reported` com o evento completo, para se poder reenviar à mão.
- **Sem conteúdo.** O evento nunca leva texto do Case nem da resposta.

## Sugestão de tabela no StepAccess

```sql
CREATE TABLE usage_cost (
  request_id     uuid PRIMARY KEY,
  component_id   uuid        NOT NULL REFERENCES component(id),
  sf_org_id      char(18)    NOT NULL,
  sf_user_id     char(18)    NOT NULL,
  tool           text        NOT NULL,
  outcome        text        NOT NULL CHECK (outcome IN ('success', 'invalid_model_output')),
  model          text        NOT NULL,
  attempts       smallint    NOT NULL CHECK (attempts BETWEEN 1 AND 2),
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(14, 8),
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_cost_org_month ON usage_cost (sf_org_id, occurred_at);
```

Os nomes de tabelas e colunas devem seguir o modelo de dados do StepAccess; a ligação da org e do utilizador faz-se pelos mesmos ids Salesforce usados no `GET /v1/access`.

Exemplo de soma no StepHub: custo por org no mês corrente.

```sql
SELECT sf_org_id, count(*) AS pedidos, sum(cost_usd) AS custo_usd
FROM usage_cost
WHERE occurred_at >= date_trunc('month', now())
GROUP BY sf_org_id;
```
