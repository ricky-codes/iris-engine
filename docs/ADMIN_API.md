# IRIS Engine — API de administração

> **Para quem:** quem vai construir a secção "IRIS" na UI de administração do **StepAccess** (React + Vite + Tailwind, backend Express).
> **Fonte de verdade:** `src/http/routes/admin.ts`, `src/admin/*.ts`, `src/engine/*.ts`, `src/adapters/*.ts` no repositório `ricky-codes/iris-engine`. Se este documento e o código discordarem, ganha o código.
> **Versão da API:** v1. Todas as rotas estão em `/v1/admin`.

---

## 1. O que é a IRIS e o que esta API controla

A **IRIS** é um motor de IA para o Salesforce. Recebe pedidos de componentes do Salesforce (`POST /v1/tools/<ferramenta>`), confirma no **StepAccess** que o utilizador tem acesso (e o StepAccess conta a utilização), junta as **memórias** da org e do utilizador, chama um modelo de IA através do **OpenRouter** e devolve JSON validado. **A IRIS não guarda pedidos nem respostas.**

Divisão de responsabilidades (não misturar):

|                                                                   | StepAccess | IRIS       |
| ----------------------------------------------------------------- | ---------- | ---------- |
| Orgs, utilizadores, planos, subscrições, limites, contagem de uso | **dono**   | não guarda |
| Memórias (regras da org, preferências dos utilizadores)           | não guarda | **dono**   |
| Ferramentas, prompts, modelos de IA                               | não guarda | **dono**   |

Esta API permite à UI do StepAccess:

1. **Estado** — ver se o motor está pronto e se a base de dados, o StepAccess e o OpenRouter respondem.
2. **Atividade** — contadores agregados dos pedidos (sem conteúdo, sem ids).
3. **Ferramentas** — ver o catálogo, ligar/desligar, escolher modelo, temperatura, limites.
4. **Prompts** — criar versões, ativar, comparar, voltar ao prompt de origem.
5. **Memórias** — listar, criar regras da org, editar, apagar, apagar tudo de quem sai.
6. **Playground** — testar uma ferramenta e ver o prompt final (com memórias) e a resposta.
7. **Modelos** — lista de modelos do OpenRouter que servem para as ferramentas.

O que **não** está nesta API (de propósito): segredos (chave do OpenRouter, credenciais), criar ferramentas novas (são código), reiniciar/deploy, logs em bruto.

---

## 2. Arquitetura da integração

```
Browser (UI StepAccess)
   │  cookie de sessão Google (já existe)
   ▼
Backend StepAccess (Express)          ← verifica sessão e perfil, escreve auditoria
   │  Authorization: Bearer <IRIS_ADMIN_SECRET>
   │  X-Admin-Actor: <email do utilizador do dashboard>
   ▼
IRIS Engine  /v1/admin/*
```

**Regras obrigatórias:**

- O **browser nunca chama a IRIS diretamente.** O segredo de admin só existe no backend do StepAccess. O frontend chama rotas do próprio StepAccess (ex.: `/v1/admin/iris/...`), que fazem proxy para a IRIS.
- O backend do StepAccess envia sempre `X-Admin-Actor` com o email do utilizador do dashboard que fez a ação (a IRIS regista-o nos logs).
- Cada **alteração** feita na IRIS deve ser registada no `access_audit_log` do StepAccess (ver secção 9).
- Não copiar dados da IRIS para a base de dados do StepAccess. Ler sempre da API.

### 2.1 Configuração

**No servidor da IRIS** (`.env`):

```bash
ADMIN_API_SECRET=<segredo com ≥ 32 caracteres, diferente do API_SECRET>
```

Gerar no Linux: `openssl rand -base64 48`. Sem esta variável (ou sem base de dados) a API de admin **não existe** (todas as rotas `/v1/admin/*` dão 404). O log de arranque diz `API de administração ligada em /v1/admin`.

**No backend do StepAccess** (`.env`, nomes sugeridos):

```bash
IRIS_ADMIN_URL=http://127.0.0.1:8080      # ou o endereço interno da IRIS
IRIS_ADMIN_SECRET=<o mesmo valor do ADMIN_API_SECRET>
```

### 2.2 Rede

- Se a IRIS e o StepAccess estão no **mesmo servidor**, o StepAccess deve chamar a IRIS por endereço interno (`http://127.0.0.1:8080` ou pela rede Docker), **não** pelo domínio público.
- Se a IRIS estiver publicada na internet (para o Salesforce chamar `/v1/tools/*`), **bloquear `/v1/admin/*` no proxy público** (Caddy). Exemplo:

```caddy
iris.exemplo.pt {
  @admin path /v1/admin/*
  respond @admin 404
  reverse_proxy 127.0.0.1:8080
}
```

---

## 3. Convenções

| Tema                              | Regra                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Base                              | `${IRIS_ADMIN_URL}/v1/admin`                                                                      |
| Autenticação                      | `Authorization: Bearer <ADMIN_API_SECRET>` em **todos** os pedidos                                |
| Autoria                           | `X-Admin-Actor: <email>` **obrigatório** em `POST`, `PUT`, `PATCH`, `DELETE` (1 a 200 caracteres) |
| Formato                           | JSON (`Content-Type: application/json`), UTF-8                                                    |
| Nomes de campos                   | camelCase                                                                                         |
| Datas                             | ISO 8601 em UTC (`2026-10-13T21:02:28.429Z`)                                                      |
| Ids Salesforce                    | sempre **18 caracteres**: org `00D…`, utilizador `005…` (comparados letra a letra)                |
| Ids de memória                    | UUID                                                                                              |
| Nomes de ferramentas              | `^[a-z_]+$` (ex.: `diagnostic`, `sentiment`, `reply`, `tipification`)                             |
| Query string                      | os números vão como texto (`limit=50`), os booleanos como `true`/`false`                          |
| Campos extra no corpo             | recusados (422)                                                                                   |
| Rastreio                          | todas as respostas trazem `X-Request-Id`; mostrar na UI quando há erro                            |
| Tempo limite recomendado no proxy | 10 s; **60 s** para `/playground/*/run` (chama o modelo)                                          |

### 3.1 Formato de erro (igual em todas as rotas)

```json
{
  "error": {
    "code": "invalid_request",
    "message": "O pedido não é válido.",
    "details": [{ "path": "body.content", "issue": "must NOT have more than 500 characters" }],
    "requestId": "2c002e0d-2208-4fc6-beed-868c43cdf734"
  }
}
```

`message` está em português e pode ser mostrada ao utilizador. `details[].path` indica o campo (`body.x`, `querystring.x`, `params.x`, `headers.x`, `body.input.x`).

### 3.2 Códigos de erro

| HTTP | `code`                   | Quando                                                                                                           |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 401  | `unauthorized`           | Sem `Authorization` ou segredo errado. Traz `WWW-Authenticate: Bearer`.                                          |
| 403  | `forbidden`              | Operação não permitida (ex.: editar memória de utilizador).                                                      |
| 403  | `access_denied`          | Playground com `countUsage: true` e o StepAccess recusou. `details[0].issue` = razão (`NOT_MEMBER`, …).          |
| 404  | `not_found`              | Memória ou versão de prompt que não existe; rota inexistente.                                                    |
| 404  | `unknown_tool`           | Ferramenta que não existe no catálogo (ou, no playground, sem implementação).                                    |
| 409  | `memory_limit_reached`   | A org já tem 50 memórias.                                                                                        |
| 413  | `payload_too_large`      | Corpo acima do limite (1 MB por omissão).                                                                        |
| 415  | `unsupported_media_type` | `Content-Type` não é JSON.                                                                                       |
| 422  | `invalid_request`        | Validação falhou (campo em falta, formato errado, `X-Admin-Actor` em falta, ferramenta desconhecida numa lista). |
| 429  | `quota_exceeded`         | Playground com `countUsage: true` e o limite do plano foi atingido.                                              |
| 500  | `internal_error`         | Erro inesperado. Mostrar o `requestId`.                                                                          |
| 502  | `provider_unavailable`   | O OpenRouter falhou (rede, chave, créditos, modelo sem suporte).                                                 |
| 503  | `service_unavailable`    | Dependência indisponível (StepAccess, base de dados) ou playground sem OpenRouter configurado.                   |
| 504  | `timeout`                | O modelo demorou mais do que o `timeoutMs` da ferramenta.                                                        |

---

## 4. Conceitos

### 4.1 Ferramentas

Uma **ferramenta** é uma capacidade da IRIS (ex.: `sentiment`, `reply`). Existe:

- no **catálogo** (tabela `tool`), que é o que esta API lista;
- e, se estiver **implementada** neste servidor (`implemented: true`), também no código, com contrato de entrada/saída, prompt de origem e valores por omissão.

Hoje o catálogo tem `diagnostic` (implementada, só existe com `ENABLE_DIAGNOSTIC_TOOL=true`), `sentiment`, `tipification` e `reply` (ainda por implementar). Ferramentas não implementadas podem ter configuração e prompts preparados, mas não correm nem entram no playground.

**Configuração efetiva** de uma ferramenta (o motor lê-a **em cada pedido**, por isso uma alteração vale a partir do pedido seguinte, sem reiniciar):

| Campo                                                             | Origem                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`, `temperature`, `maxOutputTokens`, `timeoutMs`, `enabled` | Base de dados se houver (`config.source = "database"`); senão os valores do código (`"default"`), com o modelo de `LLM_DEFAULT_MODEL`.                       |
| Prompt de sistema                                                 | Versão ativa na base de dados (`prompt.source = "database"`); senão o prompt do código (`"code"`); ferramenta não implementada e sem versão ativa: `"none"`. |

`enabled: false` faz a ferramenta responder **503** aos pedidos do Salesforce (antes de contar utilização). O playground continua a funcionar com ferramentas desligadas.

### 4.2 Prompts

- Cada ferramenta tem uma lista de **versões** numeradas (1, 2, 3…). Uma versão **nunca muda** depois de criada (a base de dados garante-o).
- No máximo **uma versão ativa**. Sem versão ativa, usa-se o prompt do código.
- "Editar o prompt" na UI = criar uma versão nova (opcionalmente já ativa). "Voltar atrás" = ativar uma versão anterior. "Usar o prompt de origem" = ativar `null`.
- As memórias são acrescentadas pelo motor **depois** do prompt, numa secção própria. O prompt não precisa de as mencionar.

### 4.3 Memórias

Instruções curtas que mudam a forma como a IRIS responde.

|              | Memória da org (`scope: "org"`) | Memória de utilizador (`scope: "user"`)                             |
| ------------ | ------------------------------- | ------------------------------------------------------------------- |
| O que é      | Regra da empresa                | Preferência pessoal                                                 |
| Quem cria    | Admin da Step (esta API)        | O próprio utilizador, pedindo à IRIS (ferramenta "lembrar", futura) |
| `source`     | sempre `"admin"`                | `"user"`                                                            |
| O admin pode | criar, editar, apagar           | **só apagar**                                                       |
| Vale para    | todos os utilizadores da org    | só esse utilizador                                                  |
| Limite       | **50** por org                  | **20** por utilizador                                               |

- Texto: 1 a **500** caracteres (espaços nas pontas são removidos).
- `tools`: lista de ferramentas a que se aplica. **Lista vazia = todas as ferramentas.**
- Em conflito, **a memória da org prevalece** sobre a do utilizador.
- Orgs e utilizadores **não** têm de existir na IRIS: são só ids. Quem decide se existem é o StepAccess.
- Quando uma org ou um utilizador sai do StepAccess, as memórias dele devem ser apagadas com `POST /memories/purge` (ver 6.6). Integração recomendada: chamar o purge a partir do código que apaga a org/utilizador no StepAccess.

### 4.4 Playground

Corre uma ferramenta **como se fosse um pedido real** (mesmas memórias, mesma configuração, mesmo modelo), mas:

- **não conta utilização no StepAccess** por omissão (`countUsage: false`); o custo do modelo no OpenRouter existe sempre;
- funciona mesmo com a ferramenta desligada;
- permite experimentar outro `model` e outro `systemPrompt` sem gravar nada;
- devolve o prompt final montado e o texto bruto de cada tentativa.

O texto do pedido e da resposta é devolvido à UI mas **não é registado** em lado nenhum.

### 4.5 Métricas

Contadores **em memória**, desde o último arranque do serviço (recomeçam do zero ao reiniciar). Só pedidos de ferramentas do Salesforce (`/v1/tools/*`); o playground não conta. Não têm ids, orgs, utilizadores nem conteúdo. Para utilização por org/utilizador, usar os dados do StepAccess.

---

## 5. Estado, métricas e modelos

### 5.1 `GET /v1/admin/status`

Estado do serviço e das dependências. Faz verificações reais (pode demorar até ~3 s se uma dependência não responder). **Não conta utilização** no StepAccess (usa `/v1/health`) e **não chama nenhum modelo** (lê a chave do OpenRouter em `/key`).

Resposta `200`:

```json
{
  "service": {
    "name": "iris-engine",
    "version": "0.1.0",
    "environment": "production",
    "startedAt": "2026-10-13T21:02:28.429Z",
    "uptimeSeconds": 3600
  },
  "engine": {
    "ready": true,
    "missing": [],
    "tools": ["diagnostic"]
  },
  "config": {
    "stepAccess": "live",
    "openRouter": "configured",
    "defaultModel": "google/gemini-2.5-flash",
    "diagnosticTool": true
  },
  "checks": {
    "database": { "status": "ok", "latencyMs": 4 },
    "stepAccess": { "status": "ok", "latencyMs": 31 },
    "openRouter": { "status": "ok", "latencyMs": 120, "credits": { "usage": 0.42, "limit": null } }
  }
}
```

| Campo                       | Significado                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `engine.ready`              | `true` = o Salesforce consegue usar a IRIS. `false` = falta configuração (ver `missing`).                           |
| `engine.missing`            | O que falta configurar (texto), ex.: `"OPENROUTER_API_KEY"`.                                                        |
| `engine.tools`              | Ferramentas implementadas e ativas neste servidor.                                                                  |
| `config.stepAccess`         | `live` (verifica cada pedido), `bypass` (**não verifica — só desenvolvimento**, mostrar aviso vermelho), `missing`. |
| `config.openRouter`         | `configured` ou `missing`.                                                                                          |
| `checks.*.status`           | `ok`, `failed` (ver `detail`, ex.: `"HTTP 401"`, `"TimeoutError"`), `not_configured` (ver `detail`).                |
| `checks.openRouter.credits` | `usage` = USD gastos com a chave; `limit` = limite da chave em USD (`null` = sem limite). Pode faltar.              |

### 5.2 `GET /v1/admin/metrics`

Resposta `200`:

```json
{
  "since": "2026-10-13T21:02:28.429Z",
  "totals": {
    "requests": 120,
    "succeeded": 110,
    "failed": 10,
    "errorsByCode": { "access_denied": 6, "quota_exceeded": 3, "provider_unavailable": 1 },
    "avgDurationMs": 1840,
    "inputTokens": 152300,
    "outputTokens": 20110
  },
  "byTool": [
    {
      "tool": "sentiment",
      "requests": 80,
      "succeeded": 75,
      "failed": 5,
      "errorsByCode": { "access_denied": 5 },
      "avgDurationMs": 1650,
      "inputTokens": 98000,
      "outputTokens": 12000
    }
  ],
  "byDay": [
    {
      "day": "2026-10-13",
      "requests": 120,
      "succeeded": 110,
      "failed": 10,
      "errorsByCode": {},
      "avgDurationMs": 1840,
      "inputTokens": 152300,
      "outputTokens": 20110
    }
  ]
}
```

- `avgDurationMs`: média só dos pedidos bem-sucedidos; `null` se não houve nenhum.
- `byDay`: dias UTC, do mais antigo para o mais recente, no máximo 30.
- Mostrar sempre `since` ("desde o arranque às …").

### 5.3 `GET /v1/admin/models`

Modelos do OpenRouter, com cache de 15 minutos. Para o seletor de modelo na configuração das ferramentas.

Query: `structuredOnly` = `true` (omissão; só modelos que aceitam JSON Schema, que são os que funcionam com as ferramentas) ou `false` (todos).

Resposta `200`:

```json
{
  "fetchedAt": "2026-10-13T21:02:31.490Z",
  "models": [
    {
      "id": "google/gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "contextLength": 1048576,
      "promptPricePerMillion": 0.3,
      "completionPricePerMillion": 2.5,
      "supportsStructuredOutput": true
    }
  ]
}
```

Preços em USD por milhão de tokens (`null` se o OpenRouter não indicar). Erro: `502 provider_unavailable` se o OpenRouter não responder.

---

## 6. Ferramentas e prompts

### 6.1 `GET /v1/admin/tools`

Resposta `200`:

```json
{
  "tools": [
    {
      "name": "diagnostic",
      "implemented": true,
      "version": 1,
      "description": "Teste de ligação: responde em uma ou duas frases à mensagem enviada.",
      "enabled": true,
      "config": {
        "model": "google/gemini-2.5-flash",
        "temperature": 0.2,
        "maxOutputTokens": 300,
        "timeoutMs": 20000,
        "source": "default"
      },
      "prompt": { "source": "code", "activeVersion": null, "versionCount": 0 }
    },
    {
      "name": "reply",
      "implemented": false,
      "version": null,
      "description": null,
      "enabled": true,
      "config": null,
      "prompt": { "source": "none", "activeVersion": null, "versionCount": 0 }
    }
  ]
}
```

| Campo           | Significado                                                                 |
| --------------- | --------------------------------------------------------------------------- |
| `implemented`   | Existe no código deste servidor (pode correr).                              |
| `version`       | Versão do contrato de entrada/saída (só implementadas).                     |
| `enabled`       | `false` = o Salesforce recebe 503 nesta ferramenta.                         |
| `config`        | Configuração efetiva; `null` = não implementada e sem configuração gravada. |
| `config.source` | `database` (gravada pelo admin) ou `default` (valores do código).           |
| `prompt.source` | `database` (versão ativa), `code` (prompt de origem) ou `none`.             |

### 6.2 `GET /v1/admin/tools/:name`

Tudo de 6.1, mais:

```json
{
  "defaults": {
    "model": "google/gemini-2.5-flash",
    "temperature": 0.2,
    "maxOutputTokens": 300,
    "timeoutMs": 20000
  },
  "codePrompt": "És a IRIS, a assistente de IA da Step Ahead…",
  "inputSchema": {
    "type": "object",
    "properties": { "message": { "type": "string", "minLength": 1, "maxLength": 2000 } },
    "required": ["message"]
  },
  "outputSchema": {
    "type": "object",
    "properties": { "reply": { "type": "string", "minLength": 1 } },
    "required": ["reply"],
    "additionalProperties": false
  }
}
```

`defaults`, `codePrompt`, `inputSchema` e `outputSchema` são `null` em ferramentas não implementadas. `inputSchema` é o JSON Schema dos campos da ferramenta (sem `orgId`/`userId`), útil para gerar o formulário do playground. Erro: `404 unknown_tool`.

### 6.3 `PUT /v1/admin/tools/:name/config`

Grava a configuração (substitui toda). Corpo (todos obrigatórios):

| Campo             | Tipo    | Regras                                   |
| ----------------- | ------- | ---------------------------------------- |
| `model`           | string  | 1–200; id do OpenRouter (usar `/models`) |
| `temperature`     | number  | 0–2                                      |
| `maxOutputTokens` | integer | 1–32000                                  |
| `timeoutMs`       | integer | 1000–120000                              |
| `enabled`         | boolean |                                          |

```json
{
  "model": "anthropic/claude-sonnet-4.5",
  "temperature": 0.3,
  "maxOutputTokens": 800,
  "timeoutMs": 20000,
  "enabled": true
}
```

Resposta `200`: o detalhe da ferramenta (como 6.2), já com `config.source = "database"`. Erros: `404 unknown_tool`, `422`.

> A IRIS não verifica se o modelo existe no OpenRouter. Um modelo errado ou sem suporte para JSON Schema faz os pedidos falharem com `502 provider_unavailable`. **Na UI, escolher o modelo a partir de `/models` e testar no playground antes de gravar.**

### 6.4 `DELETE /v1/admin/tools/:name/config`

Apaga a configuração gravada: a ferramenta volta aos valores do código e fica ligada. Resposta `200`: o detalhe da ferramenta.

### 6.5 Prompts

#### `GET /v1/admin/tools/:name/prompt-versions`

```json
{
  "tool": "diagnostic",
  "activeVersion": 2,
  "codePrompt": "És a IRIS…",
  "versions": [
    {
      "version": 2,
      "isActive": true,
      "systemTemplate": "…",
      "changeNote": "mais curto",
      "createdAt": "2026-10-13T10:00:00.000Z"
    },
    {
      "version": 1,
      "isActive": false,
      "systemTemplate": "…",
      "changeNote": null,
      "createdAt": "2026-10-12T09:00:00.000Z"
    }
  ]
}
```

Versões da mais recente para a mais antiga. `codePrompt` é `null` em ferramentas não implementadas.

#### `POST /v1/admin/tools/:name/prompt-versions`

| Campo            | Tipo    | Regras                                 |
| ---------------- | ------- | -------------------------------------- |
| `systemTemplate` | string  | 1–20000, obrigatório                   |
| `changeNote`     | string  | 0–500, opcional (o que mudou e porquê) |
| `activate`       | boolean | opcional, omissão `false`              |

Resposta `201`: a versão criada (`{ version, isActive, systemTemplate, changeNote, createdAt }`). O número é atribuído pela IRIS (seguinte ao maior).

#### `PUT /v1/admin/tools/:name/active-prompt`

```json
{ "version": 3 }      // ativa a versão 3
{ "version": null }   // nenhuma versão ativa: usa o prompt do código
```

Resposta `200`: `{ "tool": "diagnostic", "activeVersion": 3 }`. Erros: `404 not_found` (versão não existe), `404 unknown_tool`.

---

## 7. Memórias

Formato de uma memória:

```json
{
  "id": "6a07ac09-bf24-4ec6-912b-e481775fc8cb",
  "scope": "org",
  "source": "admin",
  "orgId": "00DgL00000O7vLVUAZ",
  "userId": null,
  "content": "Tratar sempre o cliente por você.",
  "tools": ["reply"],
  "createdAt": "2026-10-12T09:00:00.000Z",
  "updatedAt": "2026-10-12T09:00:00.000Z"
}
```

`userId` só existe em `scope: "user"`. `tools: []` = vale para todas as ferramentas.

### 7.1 `GET /v1/admin/memories`

Query (todos opcionais):

| Parâmetro | Regras            | Efeito                                                         |
| --------- | ----------------- | -------------------------------------------------------------- |
| `orgId`   | `00D…` 18 car.    | Memórias desta org (da org e dos utilizadores dela)            |
| `userId`  | `005…` 18 car.    | Só memórias deste utilizador                                   |
| `scope`   | `org` \| `user`   | Só um âmbito                                                   |
| `tool`    | nome              | Memórias que valem para esta ferramenta (inclui as de "todas") |
| `search`  | 1–200 car.        | Procura no texto, sem distinguir maiúsculas                    |
| `limit`   | 1–200, omissão 50 | Tamanho da página                                              |
| `offset`  | ≥ 0, omissão 0    | Início da página                                               |

Ordem: memórias da org primeiro, depois por utilizador; dentro de cada dono, as mais recentes primeiro.

Resposta `200`:

```json
{ "items": [{ "...": "memória" }], "total": 2, "limit": 50, "offset": 0 }
```

### 7.2 `GET /v1/admin/memories/summary?orgId=00D…`

Contagens face aos limites (para barras "12 / 50"):

```json
{
  "orgId": "00DgL00000O7vLVUAZ",
  "org": { "count": 12, "limit": 50 },
  "users": [{ "userId": "005gL00000GpOQTQA3", "count": 3, "limit": 20 }]
}
```

Só aparecem utilizadores com pelo menos uma memória.

### 7.3 `GET /v1/admin/memories/:id`

Resposta `200`: a memória. `404 not_found` se não existir; `422` se o id não for UUID.

### 7.4 `POST /v1/admin/memories` — criar memória da org

| Campo     | Tipo     | Regras                                                                       |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `orgId`   | string   | `00D…` 18 car., obrigatório                                                  |
| `content` | string   | 1–500, obrigatório                                                           |
| `tools`   | string[] | opcional; nomes do catálogo, sem repetidos, máx. 20; omitido ou `[]` = todas |

Resposta `201`: a memória criada. Erros: `409 memory_limit_reached` (50 na org), `422` (inclui ferramenta desconhecida: `"Ferramenta desconhecida: x."`).

Só se criam memórias da **org** por esta API. As de utilizador nascem na IRIS a pedido do próprio utilizador.

### 7.5 `PATCH /v1/admin/memories/:id` — editar memória da org

Corpo com pelo menos um campo:

| Campo     | Tipo     | Regras                                  |
| --------- | -------- | --------------------------------------- |
| `content` | string   | 1–500                                   |
| `tools`   | string[] | substitui a lista inteira; `[]` = todas |

Resposta `200`: a memória atualizada (`updatedAt` muda). Erros: `403 forbidden` (é memória de utilizador), `404 not_found`, `422`.

### 7.6 `DELETE /v1/admin/memories/:id`

Apaga qualquer memória (da org ou de utilizador). Resposta `204` sem corpo. `404 not_found` se já não existir.

### 7.7 `POST /v1/admin/memories/purge` — apagar tudo de quem sai

| Corpo                                   | Apaga                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| `{ "orgId": "00D…", "userId": "005…" }` | Todas as memórias desse utilizador nessa org                 |
| `{ "orgId": "00D…" }`                   | Todas as memórias da org **e de todos os utilizadores dela** |

Resposta `200`: `{ "deleted": 7 }`. Não falha se não houver nada (`deleted: 0`). **Irreversível**: na UI, pedir confirmação escrevendo o id da org.

---

## 8. Playground

Corpo comum (`preview` e `run`):

| Campo          | Tipo   | Regras                                                                         |
| -------------- | ------ | ------------------------------------------------------------------------------ |
| `orgId`        | string | `00D…` 18 car. — memórias desta org                                            |
| `userId`       | string | `005…` 18 car. — memórias deste utilizador                                     |
| `input`        | object | campos da ferramenta (ver `inputSchema` em 6.2), validados como no pedido real |
| `systemPrompt` | string | opcional, 1–20000 — substitui o prompt só neste teste                          |
| `model`        | string | opcional, 1–200 — substitui o modelo só neste teste                            |

Ferramenta não implementada: `404 unknown_tool`. Sem OpenRouter configurado: `503`. Entrada inválida: `422` com `details[].path` = `body.input.<campo>`.

### 8.1 `POST /v1/admin/playground/:name/preview`

Monta o prompt **sem chamar o modelo** (sem custo). Resposta `200`:

```json
{
  "tool": "diagnostic",
  "settings": {
    "model": "google/gemini-2.5-flash",
    "temperature": 0.2,
    "maxOutputTokens": 300,
    "timeoutMs": 20000,
    "enabled": true
  },
  "memories": { "org": ["Tratar sempre o cliente por você."], "user": [] },
  "prompt": {
    "system": "És a IRIS…\n\n---\nMemórias guardadas para este pedido…\n\nRegras da empresa (prevalecem sempre):\n- Tratar sempre o cliente por você.",
    "user": "Olá"
  },
  "outputSchema": {
    "type": "object",
    "properties": { "reply": { "type": "string" } },
    "required": ["reply"]
  }
}
```

`settings.systemPrompt` aparece só quando há versão ativa na base de dados.

### 8.2 `POST /v1/admin/playground/:name/run`

Corpo comum mais:

| Campo        | Tipo    | Regras                                                                                                                                                   |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `countUsage` | boolean | opcional, omissão `false`. `true` = pergunta ao StepAccess e conta utilização como um pedido real (pode dar `403 access_denied` / `429 quota_exceeded`). |

Resposta `200` (mesmo quando o modelo responde mal — ver `ok`):

```json
{
  "tool": "diagnostic",
  "ok": true,
  "result": { "reply": "Olá! Estou a funcionar." },
  "countedUsage": false,
  "durationMs": 1432,
  "settings": {
    "model": "google/gemini-2.5-flash",
    "temperature": 0.2,
    "maxOutputTokens": 300,
    "timeoutMs": 20000,
    "enabled": true
  },
  "memories": { "org": ["Tratar sempre o cliente por você."], "user": [] },
  "prompt": { "system": "…", "user": "Olá" },
  "attempts": [
    {
      "text": "{\"reply\":\"Olá! Estou a funcionar.\"}",
      "valid": true,
      "model": "google/gemini-2.5-flash",
      "inputTokens": 180,
      "outputTokens": 14,
      "costUsd": 0.0000963
    }
  ]
}
```

| Campo                | Significado                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | `true` = resposta válida em `result`. `false` = as duas tentativas não cumpriram o esquema (`result: null`; ver `attempts[].text`). |
| `attempts`           | 1 ou 2 tentativas, com o texto bruto devolvido pelo modelo.                                                                         |
| `attempts[].model`   | Modelo que de facto respondeu (o OpenRouter pode indicar uma variante).                                                             |
| `attempts[].costUsd` | Custo da tentativa em dólares, indicado pelo OpenRouter (ausente se não vier).                                                      |

Erros do modelo (rede, chave, créditos, modelo sem suporte) dão `502 provider_unavailable`; tempo esgotado `504 timeout`.

---

## 9. Implementação sugerida no backend do StepAccess

### 9.1 Proxy

```js
// server/src/irisAdmin.js (exemplo)
const IRIS = process.env.IRIS_ADMIN_URL;
const SECRET = process.env.IRIS_ADMIN_SECRET;

async function iris(req, method, path, body) {
  const res = await fetch(`${IRIS}/v1/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'X-Admin-Actor': req.dashboardUser.email,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(
      path.includes('/playground/') && path.endsWith('/run') ? 60_000 : 10_000,
    ),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
```

- Devolver ao frontend o mesmo `status` e o mesmo corpo de erro da IRIS (o `error.message` já está em português).
- Se a IRIS não responder (rede/tempo), devolver `503` com uma mensagem própria ("A IRIS não está a responder").

### 9.2 Permissões sugeridas (perfis do StepAccess)

| Ação                                                                 | Perfil                                       |
| -------------------------------------------------------------------- | -------------------------------------------- |
| Ver estado, métricas, modelos, ferramentas, prompts, memórias        | qualquer utilizador com acesso ao StepAccess |
| Playground (`preview`, `run` sem contar)                             | qualquer                                     |
| Criar, editar, apagar memórias da org; apagar memórias de utilizador | qualquer                                     |
| Configuração de ferramentas, versões e ativação de prompts           | **admin**                                    |
| `memories/purge`, playground com `countUsage: true`                  | **admin**                                    |

### 9.3 Auditoria (`access_audit_log`)

Registar cada alteração bem-sucedida, com `entity_type = 'iris'` e `org_id` quando houver. Nomes de ação sugeridos:

| Rota IRIS                                           | `action`                      | `payload` (sem texto completo de prompts)                           |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `POST /memories`                                    | `iris_memory_created`         | `{ memoryId, orgId, tools }`                                        |
| `PATCH /memories/:id`                               | `iris_memory_updated`         | `{ memoryId, changed: ["content","tools"] }`                        |
| `DELETE /memories/:id`                              | `iris_memory_deleted`         | `{ memoryId, scope, orgId, userId }`                                |
| `POST /memories/purge`                              | `iris_memories_purged`        | `{ orgId, userId, deleted }`                                        |
| `PUT /tools/:name/config`                           | `iris_tool_config_saved`      | `{ tool, model, temperature, maxOutputTokens, timeoutMs, enabled }` |
| `DELETE /tools/:name/config`                        | `iris_tool_config_reset`      | `{ tool }`                                                          |
| `POST /tools/:name/prompt-versions`                 | `iris_prompt_version_created` | `{ tool, version, activate, changeNote }`                           |
| `PUT /tools/:name/active-prompt`                    | `iris_prompt_activated`       | `{ tool, version }`                                                 |
| `POST /playground/:name/run` com `countUsage: true` | `iris_playground_counted`     | `{ tool, orgId, userId }`                                           |

A IRIS também regista no seu log `actor`, rota e estado de cada alteração (nunca conteúdo).

---

## 10. UI sugerida

Uma secção **IRIS** no menu do StepAccess, com:

1. **Estado** (página inicial da secção)
   - Cartão por dependência (`database`, `stepAccess`, `openRouter`) com `ok` / `failed` / `not_configured`, latência e `detail`.
   - **Aviso vermelho** se `config.stepAccess = "bypass"` ("A IRIS não está a verificar licenças").
   - `engine.ready = false` → listar `engine.missing`.
   - Créditos do OpenRouter (`usage` / `limit`).
   - Versão e tempo desde o arranque. Botão "Atualizar" (não fazer polling a menos de 30 s).
2. **Atividade** — `/metrics`: totais, gráfico por dia (pedidos ok vs falhados), tabela por ferramenta, erros por código. Mostrar "desde <since>" e explicar que recomeça ao reiniciar.
3. **Ferramentas** — tabela (`name`, implementada, ligada, modelo, origem da config e do prompt).
   - Detalhe: formulário da configuração (seletor de modelo alimentado por `/models`, temperatura 0–2, tokens, tempo limite, ligada); "Repor valores de origem".
   - Separador **Prompt**: versão ativa; histórico; **comparação lado a lado (diff)** entre versões e com o prompt do código; "Nova versão" (editor de texto grande + nota de alteração + "ativar já"); "Ativar esta versão"; "Usar o prompt de origem".
   - Botão "Testar no playground" com o prompt/modelo em edição antes de gravar.
4. **Memórias**
   - Filtros: org, utilizador, âmbito, ferramenta, pesquisa; paginação.
   - Na **página da org** que já existe no StepAccess: painel "Memórias da IRIS" com o resumo (`/summary`), a lista da org, criar/editar/apagar, e as memórias de cada utilizador (só apagar).
   - Contador de caracteres (500) e de limite (50/20). Chips de ferramentas ("todas" quando vazio).
   - "Apagar todas as memórias" (purge) com confirmação forte.
   - Ao apagar uma org ou um utilizador no StepAccess, chamar o purge correspondente.
5. **Playground**
   - Escolher ferramenta implementada, org e utilizador (seletores com as orgs/utilizadores do próprio StepAccess), formulário gerado do `inputSchema`.
   - Botões "Ver prompt" (`preview`, sem custo) e "Executar" (`run`).
   - Mostrar: resultado formatado, prompt de sistema final, mensagem do utilizador, memórias aplicadas, tentativas (texto bruto), tokens, duração.
   - Opções avançadas: outro modelo, outro prompt, "contar utilização" (só admin).

---

## 11. Exemplos rápidos (`curl`, no servidor)

```bash
A="Authorization: Bearer $ADMIN_API_SECRET"
W="X-Admin-Actor: ricardo@stepahead.pt"
U=http://127.0.0.1:8080/v1/admin

curl -s $U/status -H "$A"
curl -s "$U/memories?orgId=00DgL00000O7vLVUAZ" -H "$A"
curl -s -X POST $U/memories -H "$A" -H "$W" -H 'Content-Type: application/json' \
  -d '{"orgId":"00DgL00000O7vLVUAZ","content":"Tratar sempre o cliente por você.","tools":["reply"]}'
curl -s -X POST $U/playground/diagnostic/run -H "$A" -H "$W" -H 'Content-Type: application/json' \
  -d '{"orgId":"00DgL00000O7vLVUAZ","userId":"005gL00000GpOQTQA3","input":{"message":"Olá"}}'
```

---

## 12. Lista de verificação da integração

- [ ] `ADMIN_API_SECRET` no `.env` da IRIS, diferente do `API_SECRET`; serviço reiniciado; log diz "API de administração ligada".
- [ ] `IRIS_ADMIN_URL` e `IRIS_ADMIN_SECRET` no backend do StepAccess; endereço interno.
- [ ] `/v1/admin/*` bloqueado no proxy público da IRIS.
- [ ] O frontend nunca recebe o segredo nem chama a IRIS diretamente.
- [ ] `X-Admin-Actor` enviado em todas as alterações.
- [ ] Alterações registadas no `access_audit_log`.
- [ ] Permissões por perfil aplicadas no backend (não só escondidas na UI).
- [ ] Erros mostram `error.message` e `requestId`.
- [ ] Purge chamado ao apagar org/utilizador no StepAccess.
