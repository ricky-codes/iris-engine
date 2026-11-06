# Os cinco adaptadores da IRIS

O motor (`src/engine/`) não sabe de Postgres, StepAccess nem OpenRouter: fala com interfaces. Cada uma tem um **adaptador** em `src/adapters/`, montado em `src/server.ts`. A API de administração descreve-os em `GET /v1/admin/modules` (ver `src/admin/modules.ts`); os valores em vigor vêm de lá.

| Adaptador                 | Interface do motor | Ficheiro                                | Usado em modo `open`?     |
| ------------------------- | ------------------ | --------------------------------------- | ------------------------- |
| `PgEngineStore`           | `EngineStore`      | `src/adapters/postgres-store.ts`        | sim                       |
| `PgMemoryStore`           | `MemoryStore`      | `src/adapters/postgres-memory-store.ts` | sim                       |
| `StepAccessClient`        | `AccessChecker`    | `src/adapters/stepaccess-access.ts`     | não (`OpenAccessChecker`) |
| `StepAccessUsageReporter` | `UsageReporter`    | `src/adapters/stepaccess-usage.ts`      | não                       |
| `OpenRouterProvider`      | `LlmProvider`      | `src/adapters/openrouter.ts`            | sim                       |

Legenda das definições: **API** = muda-se pela API de administração sem reiniciar · **env** = `.env`, exige reiniciar · **código** = constante.

## PgEngineStore

**O que é.** Lê, em cada pedido, a configuração da ferramenta: modelo, modelos de recurso, temperatura, limites, ligada/desligada e prompt ativo. Uma só consulta junta `tool`, `tool_config`, `tool_config_fallback`, `llm_model`, `prompt` e `prompt_version`. Só lê; quem escreve é `src/admin/tools.ts`. Sem linha em `tool_config`, valem os valores da ferramenta e do motor.

**Se falhar:** o pedido dá 500.

| Definição                                                      | Hoje                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Modelo, modelos de recurso, temperatura, tokens, tempo, ligada | **API** `PUT /v1/admin/tools/:name/config`                                         |
| Versões do prompt e versão ativa                               | **API** `POST …/prompt-versions`, `PUT …/active-prompt`                            |
| Tentativas, teto de tempo, limite de pedidos e streaming       | **API** `PUT /v1/admin/tools/:name/config` (por ferramenta; `null` segue a global) |
| Modelo e modelos de recurso por omissão                        | **API** `PATCH /v1/admin/settings`                                                 |

**Falta controlar pela API:** cache da configuração (hoje há uma consulta ao Postgres por pedido).

## PgMemoryStore

**O que é.** Guarda e lê as memórias das orgs e dos utilizadores e devolve as que valem para um pedido. Os limites são garantidos pela base de dados, mesmo com inserções simultâneas. É o único dado de clientes que a IRIS guarda.

**Se falhar:** o pedido dá 500, tal como `/v1/memories` e `/v1/admin/memories`.

| Definição                                              | Hoje                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Criar, editar, apagar e purgar memórias da org         | **API** `/v1/admin/memories`                                             |
| Limites: 500 caracteres, 50 por org, 20 por utilizador | **API** `PATCH /v1/admin/settings` (aplicados também pela base de dados) |

**Falta controlar pela API:** limites próprios por org, desligar memórias pessoais por org, validade das memórias de utilizador.

## StepAccessClient

**O que é.** `GET /v1/access` ao StepAccess (Basic) com org, utilizador e componente IRIS. Cada resposta positiva **conta utilização**. Falha fechada: qualquer resposta inesperada recusa o pedido.

**Se falhar:** 503 `service_unavailable` (sem resposta ou resposta inesperada), 403 `access_denied`, 429 `quota_exceeded`.

| Definição                                  | Hoje                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| Modo de acesso                             | env `ACCESS_MODE`                                          |
| URL, utilizador, palavra-passe, componente | env `STEPACCESS_*` (segredos nunca na API)                 |
| Tempo máximo                               | **API** `PATCH /v1/admin/settings` (`stepAccessTimeoutMs`) |

**Falta controlar pela API:** ação de **testar a ligação** (sem contar utilização); cache curta de decisões positivas (só com acordo do StepAccess, porque ele conta cada chamada).

## StepAccessUsageReporter

**O que é.** `POST /v1/usage/cost` depois de responder: custo em dólares, tokens e resultado, nunca conteúdo. Em segundo plano, sem atrasar o pedido. Duas tentativas; um 409 conta como entregue (`requestId` é a chave de idempotência). Se falhar, o evento completo fica no log.

**Se falhar:** o pedido não é afetado, mas **o custo perde-se do StepAccess**: não há fila para reenviar.

| Definição                         | Hoje                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| Ligado                            | só existe com `ACCESS_MODE=stepaccess`                          |
| Tentativas (2) e espera (1000 ms) | **código**                                                      |
| Tempo máximo                      | **API** `PATCH /v1/admin/settings` (`stepAccessUsageTimeoutMs`) |

**Falta controlar pela API:** uma fila persistente (`cost_outbox`, só metadados) com reenvio automático, o número de pendentes no `/status` e um aviso na topologia quando cresce. É a lacuna mais séria dos cinco módulos.

## OpenRouterProvider

**O que é.** `POST /chat/completions` com o JSON Schema da ferramenta, só a fornecedores que não guardam nem treinam com os dados (`data_collection: deny`) e que suportam todos os parâmetros. Devolve texto, modelo que respondeu, tokens e custo. Com `stream: true` no pedido lê SSE e entrega cada pedaço ao motor. A cadeia de recurso, as novas tentativas e o disjuntor vivem no motor (`src/engine/run.ts`, `breaker.ts`), não aqui.

**Se falhar:** 502 `provider_unavailable` (depois de tentar os modelos de recurso) ou 504 `timeout`.

| Definição                                              | Hoje                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Modelo e modelos de recurso **por ferramenta**         | **API** `PUT /v1/admin/tools/:name/config`                                                |
| Catálogo de modelos para escolher                      | **API** `GET /v1/admin/models`                                                            |
| Chave e URL base                                       | env `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`                                           |
| Modelo e recursos por omissão, teto de tempo do pedido | **API** `PATCH /v1/admin/settings`                                                        |
| Tentativas por modelo (2)                              | **API** `PATCH /v1/admin/settings`                                                        |
| Disjuntor (3 falhas, 60 s)                             | **API** `PATCH /v1/admin/settings`; fechar à mão: **API** `POST /v1/admin/breakers/reset` |
| Política de dados (`deny`)                             | **código**                                                                                |

**Falta controlar pela API:** política de dados por ferramenta, com auditoria; ordem e lista de fornecedores; limiar do aviso de créditos na topologia (hoje 90%); estado da rotação da chave (só leitura, últimos 4 caracteres).
