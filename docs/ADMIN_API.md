# IRIS Engine — API de administração

> **Para quem:** quem vai construir a secção "IRIS" na UI de administração do **StepAccess** (React + Vite + Tailwind, backend Express).
> **Fonte de verdade:** `src/http/routes/admin.ts`, `src/admin/*.ts`, `src/engine/*.ts`, `src/adapters/*.ts` no repositório `ricky-codes/iris-engine`. Se este documento e o código discordarem, ganha o código.
> **Versão da API:** v1. Todas as rotas estão em `/v1/admin`.

---

## 1. O que é a IRIS e o que esta API controla

A **IRIS** é um motor de IA para o Salesforce. Recebe pedidos de componentes do Salesforce (`POST /v1/tools/<ferramenta>`), confirma no **StepAccess** que o utilizador tem acesso (e o StepAccess conta a utilização), junta as **memórias** da org e do utilizador, chama um modelo de IA através do **OpenRouter** e devolve JSON validado. **A IRIS não guarda pedidos nem respostas.** Para o diagrama do dashboard, guarda só em memória os metadados dos últimos pedidos de cada ferramenta (6.7), sem texto nem utilizador.

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
8. **Diagrama por ferramenta** — o caminho de um pedido, passo a passo, com o estado e o que controla cada passo (6.6), e o estado dos disjuntores (5.7).
9. **Definições** — modelos por omissão, tempos, tentativas, disjuntor, streaming, limite de pedidos, tempos do StepAccess e limites das memórias, sem reiniciar; fechar o disjuntor à mão.

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
    "details": [{ "path": "body.orgId", "issue": "must match pattern \"^00D[A-Za-z0-9]{15}$\"" }],
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
| 409  | `memory_limit_reached`   | A org já tem o máximo de memórias (50 por omissão; o utilizador, 20).                                            |
| 413  | `payload_too_large`      | Corpo acima do limite (1 MB por omissão).                                                                        |
| 415  | `unsupported_media_type` | `Content-Type` não é JSON.                                                                                       |
| 422  | `invalid_request`        | Validação falhou (campo em falta, formato errado, `X-Admin-Actor` em falta, ferramenta desconhecida numa lista). |
| 429  | `quota_exceeded`         | Playground com `countUsage: true` e o limite do plano foi atingido.                                              |
| 429  | `rate_limited`           | (Só em `/v1/tools/*`.) Acima do limite de pedidos por minuto. Traz `Retry-After`.                                |
| 500  | `internal_error`         | Erro inesperado. Mostrar o `requestId`.                                                                          |
| 502  | `provider_unavailable`   | O OpenRouter falhou (rede, chave, créditos, modelo sem suporte).                                                 |
| 503  | `service_unavailable`    | Dependência indisponível (StepAccess, base de dados) ou playground sem OpenRouter configurado.                   |
| 503  | `tool_disabled`          | (Só em `/v1/tools/*`.) A ferramenta está desligada (`enabled: false`).                                           |
| 504  | `timeout`                | O modelo demorou mais do que o `timeoutMs` da ferramenta.                                                        |

---

## 4. Conceitos

### 4.1 Ferramentas

Uma **ferramenta** é uma capacidade da IRIS (ex.: `sentiment`, `reply`). Existe:

- no **catálogo** (tabela `tool`), que é o que esta API lista;
- e, se estiver **implementada** neste servidor (`implemented: true`), também no código, com contrato de entrada/saída, prompt de origem e valores por omissão.

Hoje o catálogo tem `diagnostic` (implementada, só existe com `ENABLE_DIAGNOSTIC_TOOL=true`), `sentiment`, `tipification` e `reply` (ainda por implementar). Ferramentas não implementadas podem ter configuração e prompts preparados, mas não correm nem entram no playground.

**Configuração efetiva** de uma ferramenta (o motor lê-a **em cada pedido**, por isso uma alteração vale a partir do pedido seguinte, sem reiniciar):

| Campo                                                                  | Origem                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`, `temperature`, `maxOutputTokens`, `timeoutMs`, `enabled`      | Base de dados se houver (`config.source = "database"`); senão os valores do código (`"default"`), com o modelo da definição `defaultModel`.                  |
| `maxAttempts`, `totalTimeoutMs`, `rateLimitPerMinute`, `streamEnabled` | Valor próprio da ferramenta se houver (`config.overrides.*.source = "tool"`); senão a definição global (`"engine"`, ver 5.6).                                |
| Prompt de sistema                                                      | Versão ativa na base de dados (`prompt.source = "database"`); senão o prompt do código (`"code"`); ferramenta não implementada e sem versão ativa: `"none"`. |

`enabled: false` faz a ferramenta responder **503 `tool_disabled`** aos pedidos do Salesforce (antes de contar utilização). O playground continua a funcionar com ferramentas desligadas.

### 4.2 Prompts

- Cada ferramenta tem uma lista de **versões** numeradas (1, 2, 3…). Uma versão **nunca muda** depois de criada (a base de dados garante-o).
- No máximo **uma versão ativa**. Sem versão ativa, usa-se o prompt do código.
- "Editar o prompt" na UI = criar uma versão nova (opcionalmente já ativa). "Voltar atrás" = ativar uma versão anterior. "Usar o prompt de origem" = ativar `null`.
- As memórias são acrescentadas pelo motor **depois** do prompt, numa secção própria. O prompt não precisa de as mencionar.

### 4.3 Memórias

Instruções curtas que mudam a forma como a IRIS responde.

|              | Memória da org (`scope: "org"`) | Memória de utilizador (`scope: "user"`)                            |
| ------------ | ------------------------------- | ------------------------------------------------------------------ |
| O que é      | Regra da empresa                | Preferência pessoal                                                |
| Quem cria    | Admin da Step (esta API)        | O próprio utilizador, a partir do Salesforce (`POST /v1/memories`) |
| `source`     | sempre `"admin"`                | `"user"`                                                           |
| O admin pode | criar, editar, apagar           | **só apagar**                                                      |
| Vale para    | todos os utilizadores da org    | só esse utilizador                                                 |
| Limite       | **50** por org (por omissão)    | **20** por utilizador (por omissão)                                |

- Texto: 1 a **500** caracteres por omissão (espaços nas pontas são removidos).
- Os três limites são definições (`memoryMaxChars`, `memoryPerOrg`, `memoryPerUser`, ver 5.6) e a base de dados também os aplica. Baixar um limite não apaga nada: só impede criar mais (ou gravar textos maiores).
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

Contadores **em memória**, por instância, desde o último arranque do serviço (recomeçam do zero ao reiniciar). Só pedidos de ferramentas do Salesforce (`/v1/tools/*`); o playground não conta. Não têm ids, orgs, utilizadores nem conteúdo. Para utilização por org/utilizador, usar os dados do StepAccess.

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

| Campo                       | Significado                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ready`              | `true` = o Salesforce consegue usar a IRIS. `false` = falta configuração (ver `missing`).                                                                                                                        |
| `engine.missing`            | O que falta configurar (texto), ex.: `"OPENROUTER_API_KEY"`.                                                                                                                                                     |
| `engine.tools`              | Ferramentas implementadas e ativas neste servidor.                                                                                                                                                               |
| `config.stepAccess`         | `live` (verifica cada pedido), `open` (`ACCESS_MODE=open`: acesso só pelo `API_SECRET`, sem licenças — escolha deliberada), `bypass` (**não verifica — só desenvolvimento**, mostrar aviso vermelho), `missing`. |
| `config.openRouter`         | `configured` ou `missing`.                                                                                                                                                                                       |
| `checks.*.status`           | `ok`, `failed` (ver `detail`, ex.: `"HTTP 401"`, `"TimeoutError"`), `not_configured` (ver `detail`).                                                                                                             |
| `checks.openRouter.credits` | `usage` = USD gastos com a chave; `limit` = limite da chave em USD (`null` = sem limite). Pode faltar.                                                                                                           |

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
    "outputTokens": 20110,
    "fallbacks": 4
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
      "outputTokens": 12000,
      "fallbacks": 3,
      "byModel": [
        {
          "model": "google/gemini-2.5-flash",
          "calls": 82,
          "failed": 4,
          "failedByReason": {
            "provider_unavailable": 2,
            "timeout": 1,
            "invalid_output": 1,
            "skipped_breaker": 0
          },
          "avgDurationMs": 1600,
          "servedAsFallback": 0
        }
      ]
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
      "outputTokens": 20110,
      "fallbacks": 4
    }
  ],
  "byModel": [
    {
      "model": "google/gemini-2.5-flash",
      "calls": 131,
      "failed": 9,
      "failedByReason": {
        "provider_unavailable": 5,
        "timeout": 2,
        "invalid_output": 2,
        "skipped_breaker": 3
      },
      "avgDurationMs": 1710
    }
  ]
}
```

- `avgDurationMs`: média só dos pedidos bem-sucedidos; `null` se não houve nenhum.
- `fallbacks`: pedidos bem-sucedidos que só tiveram resposta com um modelo de recurso.
- `errorsByCode`: pedidos parados por código. Os que param antes do modelo têm código próprio: `tool_disabled` (ferramenta desligada), `rate_limited` (limite de pedidos), `access_denied` e `quota_exceeded` (StepAccess); os de validação do pedido contam como `invalid_request` e os sem credencial como `unauthorized`.
- `byModel`: chamadas a cada modelo (tentativas, não pedidos), por ordem alfabética. `failed` = sem resposta válida; `failedByReason` diz porquê: `provider_unavailable`, `timeout`, `invalid_output` e `skipped_breaker` (vezes que o modelo foi **saltado** pelo disjuntor — não são chamadas, por isso não contam em `calls` nem em `failed`). `avgDurationMs` só das que responderam bem. O playground não conta.
- `byTool[].byModel`: o mesmo, só nos pedidos dessa ferramenta, mais `servedAsFallback` (respostas válidas dadas como modelo de recurso).

**Fluxo por ferramenta** (para animar o diagrama; acrescentado a cada `byTool[]`):

```jsonc
{
  "stages": {
    // um por passo (6.6): request, gate, rate, access, memories, prompt, models, validate, response
    "access": {
      "entered": 120,
      "passed": 117,
      "stopped": 3,
      "byCode": { "access_denied": 2, "stepaccess_unavailable": 1 },
      "avgMs": 42,
    },
  },
  "models": [
    {
      "model": "google/gemini-2.5-flash",
      "calls": 118,
      "failed": 4,
      "byCode": {
        "provider_error": 2,
        "model_timeout": 1,
        "invalid_output": 1,
        "skipped_breaker": 0,
      },
      "avgMs": 1500,
      "p95Ms": 3100,
      "fallbackFrom": 0,
    },
  ],
  "retries": 3,
  "fallbackPairs": [{ "from": "google/gemini-2.5-flash", "to": "openai/gpt-4.1-mini", "count": 2 }],
  "p50Ms": 1400,
  "p95Ms": 3300,
  "recent": [{ "minute": "2026-11-07T10:02:00.000Z", "requests": 4, "failed": 0 }],
}
```

- `stages.<id>`: `entered` = os que chegaram ao passo; `passed` = `entered − stopped`; `byCode` usa os códigos do catálogo (5.8) quando o passo os tem, senão o código da resposta. `avgMs` = tempo médio no passo (`null` em `request` e `response`, que não se medem, e sem pedidos). Em `access`, só os pedidos que de facto perguntaram ao StepAccess.
- `models`: as chamadas desta ferramenta a cada modelo. `p95Ms` sobre as últimas 500 chamadas; `fallbackFrom` = vezes que o modelo foi chamado como recurso.
- `retries`: novas tentativas no mesmo modelo depois de uma resposta inválida. `fallbackPairs`: passagens de um modelo para o seguinte, por par.
- `p50Ms`/`p95Ms`: duração dos pedidos, sobre os últimos 1000. `recent`: os últimos 60 minutos, por minuto (UTC), só os minutos com pedidos.
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

### 5.4 `GET /v1/admin/topology`

A IRIS descrita a si própria: os módulos, como estão ligados e o estado de cada um. Serve para a consola **desenhar o diagrama do motor** (vista geral) e abrir a configuração certa ao clicar num módulo. Tudo sai do que está a correr (configuração, verificações do `/status`, catálogo de ferramentas, contagem de memórias e métricas): **não desenhar a estrutura à mão na UI**, porque muda com a configuração (modo de acesso, ferramentas, rotas ligadas).

Faz as mesmas verificações do `/status` (base de dados, StepAccess, OpenRouter): chamar com o mesmo ritmo (ex.: a cada 30 s com a página aberta).

Resposta `200` (excerto):

```json
{
  "generatedAt": "2026-11-02T12:00:00.000Z",
  "service": {
    "name": "iris-engine",
    "version": "0.1.0",
    "environment": "production",
    "startedAt": "…",
    "uptimeSeconds": 3600
  },
  "overall": "ok",
  "layers": ["client", "http", "core", "port", "adapter", "external", "tool"],
  "nodes": [
    {
      "id": "adapter.access",
      "layer": "adapter",
      "label": "StepAccessClient",
      "status": "ok",
      "summary": "Confirma a licença e conta cada pedido",
      "details": { "mode": "live" },
      "configure": { "where": "env", "keys": ["ACCESS_MODE", "STEPACCESS_URL", "…"] }
    },
    {
      "id": "tool.sentiment",
      "layer": "tool",
      "label": "sentiment v1",
      "status": "ok",
      "summary": "Ligada · google/gemini-2.5-flash",
      "details": {
        "implemented": true,
        "enabled": true,
        "model": "google/gemini-2.5-flash",
        "modelSource": "default",
        "prompt": "código",
        "requests": 42,
        "failed": 1
      },
      "configure": { "where": "admin_api", "path": "/v1/admin/tools/sentiment" }
    }
  ],
  "edges": [
    { "from": "port.access", "to": "adapter.access" },
    { "from": "adapter.access", "to": "external.stepaccess", "label": "GET /v1/access" }
  ]
}
```

| Campo               | Significado                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layers`            | As camadas, de cima para baixo: quem chama (`client`), rotas (`http`), núcleo (`core`), interfaces do núcleo (`port`), implementações (`adapter`), serviços externos (`external`) e ferramentas (`tool`).                                                                                                 |
| `nodes[].id`        | Estável entre chamadas (ex.: `core.engine`, `external.postgres`, `tool.<nome>`). Usar como chave na UI.                                                                                                                                                                                                   |
| `nodes[].status`    | `ok` · `warning` (funciona com reservas: `bypass`, créditos perto do limite, ≥ 20% de falhas numa ferramenta) · `error` (não funciona) · `off` (desligado ou não configurado — **não é um erro**).                                                                                                        |
| `nodes[].summary`   | Uma frase pronta a mostrar junto ao módulo.                                                                                                                                                                                                                                                               |
| `nodes[].details`   | Valores para o painel lateral (modelo, tentativas, contagens, latência…). Só números, texto, booleanos ou `null`.                                                                                                                                                                                         |
| `nodes[].configure` | Onde se muda: `{ "where": "admin_api", "path": "…" }` → abrir o ecrã dessa rota (com `path: "/v1/admin/settings"` vem também `keys`: as definições desse módulo); `{ "where": "env", "keys": [...] }` → só no `.env` do servidor (mostrar as variáveis, sem botão de editar); `null` → nada a configurar. |
| `overall`           | O pior estado dos módulos ligados (os `off` não contam).                                                                                                                                                                                                                                                  |
| `edges`             | Ligações `from → to`, com `label` opcional (ex.: o pedido HTTP ao StepAccess).                                                                                                                                                                                                                            |

Modelos (`adapter.llm`): `details.chain` é a cadeia de modelos (sem o fornecedor, ex.: `"gemini-2.5-flash → gpt-4.1-mini"`) quando é igual em todas as ferramentas implementadas, ou `"várias"`; `details.fallbacks` é o total de pedidos servidos por um modelo de recurso desde o arranque; `details.openBreakers` é **quantos** modelos têm o disjuntor aberto (`0` se nenhum; o estado de cada um está em `GET /v1/admin/breakers`, 5.7). Fica `warning` com ≥ 20% dos pedidos (mínimo 5) servidos por recurso, ou com algum disjuntor aberto. Cada `tool.<nome>` tem `details.fallbacks` e `details.chain`.

Os módulos e as ligações mudam com a configuração: em `ACCESS_MODE=open` o adaptador de acesso é `OpenAccessChecker`, o StepAccess fica `off` e não há ligações para ele; ferramentas do catálogo sem implementação aparecem `off` e sem ligação ao núcleo.

### 5.5 `GET /v1/admin/modules`

Os cinco adaptadores que ligam o motor ao mundo, para a consola mostrar o que cada um faz e o que se pode configurar. Os mesmos que aparecem como nós `adapter.*` na topologia. Descrição completa em [`MODULES.md`](MODULES.md).

```jsonc
{
  "generatedAt": "2026-11-03T09:00:00.000Z",
  "modules": [
    {
      "id": "adapter.llm", // o nó da topologia
      "className": "OpenRouterProvider",
      "file": "src/adapters/openrouter.ts",
      "port": "LlmProvider", // a interface do motor que implementa
      "status": "ok", // ok | warning | error | off
      "active": true, // em uso neste servidor
      "summary": "…",
      "description": "…",
      "onFailure": "O que acontece ao pedido se este módulo falhar.",
      "settings": [
        // o que existe hoje
        {
          "key": "totalTimeoutMs",
          "label": "…",
          "description": "…",
          "value": 30000,
          "source": "env", // database | env | code
          "adminPath": null,
        }, // a rota que o altera hoje (null = só .env ou código)
      ],
      "proposed": [
        // o que falta para a API o controlar por inteiro
        { "key": "breaker", "label": "…", "description": "…", "suggested": "3 falhas · 60 s" },
      ],
    },
  ],
}
```

Nunca inclui segredos: o StepAccess aparece só com a origem do URL, e a chave do OpenRouter não aparece.

### 5.6 Definições

As definições que se mudam **sem reiniciar**. Cada uma nasce no `.env` (ou numa constante do código, nas memórias) e pode ser substituída na base de dados (tabela `engine_setting`). O valor gravado prevalece; `null` apaga-o e volta ao inicial. A instância que recebe a alteração aplica-a logo; as outras voltam a ler a tabela a cada `refreshSeconds` (30 s). Os segredos, as ligações (URLs, utilizadores, componente), o `ACCESS_MODE`, o `STEPACCESS_BYPASS` e a ferramenta de diagnóstico **continuam só no `.env`**, de propósito.

| `key`                      | Grupo        | Valor inicial                 | Limites                                     |
| -------------------------- | ------------ | ----------------------------- | ------------------------------------------- |
| `defaultModel`             | `models`     | `LLM_DEFAULT_MODEL`           | código OpenRouter com suporte a JSON Schema |
| `fallbackModels`           | `models`     | `LLM_FALLBACK_MODELS`         | até 3, sem repetidos nem o `defaultModel`   |
| `totalTimeoutMs`           | `models`     | `LLM_TOTAL_TIMEOUT_MS`        | 2000–115000                                 |
| `maxAttempts`              | `models`     | `LLM_MAX_ATTEMPTS`            | 1–5                                         |
| `breakerThreshold`         | `models`     | `LLM_BREAKER_THRESHOLD`       | 1–20                                        |
| `breakerOpenMs`            | `models`     | `LLM_BREAKER_OPEN_MS`         | 1000–3600000                                |
| `streamEnabled`            | `requests`   | `STREAM_ENABLED`              | booleano                                    |
| `rateLimitPerMinute`       | `requests`   | `RATE_LIMIT_PER_MINUTE`       | 0–100000 (0 = sem limite)                   |
| `stepAccessTimeoutMs`      | `stepAccess` | `STEPACCESS_TIMEOUT_MS`       | 100–30000                                   |
| `stepAccessUsageTimeoutMs` | `stepAccess` | `STEPACCESS_USAGE_TIMEOUT_MS` | 100–60000                                   |
| `memoryMaxChars`           | `memories`   | 500 (código)                  | 50–2000                                     |
| `memoryPerOrg`             | `memories`   | 50 (código)                   | 1–200                                       |
| `memoryPerUser`            | `memories`   | 20 (código)                   | 1–100                                       |
| `tracesEnabled`            | `traces`     | `true` (código)               | booleano                                    |
| `tracesPerTool`            | `traces`     | 100 (código)                  | 10–500                                      |

#### `GET /v1/admin/settings`

```jsonc
{
  "refreshSeconds": 30,
  "settings": [
    {
      "key": "maxAttempts",
      "group": "models", // models | requests | stepAccess | memories
      "label": "Tentativas por modelo",
      "description": "…",
      "value": 3, // em vigor
      "default": 2, // sem nada gravado
      "source": "database", // database | env | code
      "env": "LLM_MAX_ATTEMPTS", // null nas que vêm do código
      "stage": "validate", // o passo do pipeline (6.6) que governa
      "overridablePerTool": true, // cada ferramenta pode ter um valor próprio (6.3)
      "updatedAt": "2026-11-06T10:00:00.000Z", // null sem nada gravado
      "updatedBy": "ricardo@stepahead.pt",
      "constraints": { "type": "integer", "minimum": 1, "maximum": 5 }, // para o formulário
    },
  ],
}
```

Para a UI: agrupar por `group`, gerar cada campo a partir de `constraints`, mostrar "valor de origem: `default`" e um botão "Repor" quando `source = "database"`.

#### `PATCH /v1/admin/settings`

Altera só as definições enviadas. Exige `X-Admin-Actor`, que fica em `updatedBy`. Tudo ou nada: com um problema, nada é gravado.

```json
{ "maxAttempts": 3, "fallbackModels": ["openai/gpt-4.1-mini"], "rateLimitPerMinute": null }
```

Resposta `200`: o mesmo que o `GET`, já com os valores novos. Erros `422`, com um detalhe por definição (`body.maxAttempts`, `body.fallbackModels.0`…): valor fora dos limites, definição desconhecida, modelos repetidos ou iguais ao `defaultModel`, e modelos que não existem no catálogo do OpenRouter ou não suportam JSON Schema (um `defaultModel` errado partiria todas as ferramentas sem configuração).

### 5.7 Disjuntores

O disjuntor é **por modelo e por instância**: depois de `breakerThreshold` falhas seguidas do fornecedor (`provider_unavailable`, `timeout`), o modelo é saltado durante `breakerOpenMs`; a primeira chamada depois disso é um teste (meio aberto). Uma resposta, válida ou não, fecha-o. O último modelo da cadeia nunca é saltado.

#### `GET /v1/admin/breakers`

Os modelos chamados desde o arranque, nesta instância.

```json
{
  "instanceId": "iris-7f9c2b:3e1a90cd",
  "breakers": [
    {
      "model": "google/gemini-2.5-flash",
      "state": "open",
      "consecutiveFailures": 3,
      "openedAt": "2026-11-06T10:00:00.000Z",
      "openUntil": "2026-11-06T10:01:00.000Z",
      "lastError": { "reason": "timeout", "at": "2026-11-06T10:00:00.000Z" }
    }
  ]
}
```

| Campo                 | Significado                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `instanceId`          | Esta instância (`<hostname>:<id do arranque>`). Com várias instâncias, cada uma tem o seu disjuntor.                                          |
| `state`               | `closed` (usado) · `open` (saltado até `openUntil`) · `half_open` (o tempo aberto acabou: a próxima chamada testa).                           |
| `consecutiveFailures` | Falhas seguidas do fornecedor; volta a 0 com uma resposta.                                                                                    |
| `openedAt`            | Quando abriu nesta série de falhas; `null` se não abriu.                                                                                      |
| `openUntil`           | Até quando é (ou foi) saltado; `null` se não abriu.                                                                                           |
| `lastError`           | A última falha do fornecedor neste modelo desde o arranque (`reason`: `provider_unavailable` ou `timeout`), ou `null`. Fica depois de fechar. |

Cada entrada traz também `failures` (= `consecutiveFailures`), `threshold` (falhas que o abrem, `breakerThreshold`) e `reopensAt` (quando volta a ser experimentado; só com `state: "open"`, senão `null`).

Sem motor ligado: `{ "instanceId": "…", "breakers": [] }`.

#### `POST /v1/admin/breakers/reset`

Fecha o disjuntor sem esperar que o tempo aberto acabe: de um modelo com `?model=google%2Fgemini-2.5-flash`, ou de todos sem parâmetro. Sem corpo. Exige `X-Admin-Actor`. Resposta `200`: `{ "closed": ["google/gemini-2.5-flash"] }` (os que estavam abertos; `[]` se nenhum). `503` se o motor não estiver ligado. Fecha só nesta instância.

### 5.8 `GET /v1/admin/errors`

O catálogo das saídas do caminho de um pedido: um código estável por razão, com o passo e o estado HTTP. São os códigos de `stages.*.byCode` (5.2), de `exits` (6.6) e de `reason` nos traces (6.7). **Não mudam o que o Salesforce recebe:** `publicCode` é o código da resposta de `/v1/tools/*`.

```json
{
  "errors": [
    {
      "code": "stepaccess_unavailable",
      "stage": "access",
      "httpStatus": 503,
      "publicCode": "service_unavailable",
      "label": "StepAccess indisponível ou resposta inesperada"
    }
  ]
}
```

| `code`                   | Passo      | HTTP | `publicCode`           |
| ------------------------ | ---------- | ---- | ---------------------- |
| `unauthorized`           | `request`  | 401  | `unauthorized`         |
| `invalid_request`        | `request`  | 422  | `invalid_request`      |
| `payload_too_large`      | `request`  | 413  | `payload_too_large`    |
| `tool_disabled`          | `gate`     | 503  | `tool_disabled`        |
| `rate_limited`           | `rate`     | 429  | `rate_limited`         |
| `access_denied`          | `access`   | 403  | `access_denied`        |
| `quota_exceeded`         | `access`   | 429  | `quota_exceeded`       |
| `stepaccess_unavailable` | `access`   | 503  | `service_unavailable`  |
| `model_timeout`          | `models`   | 504  | `timeout`              |
| `provider_error`         | `models`   | 502  | `provider_unavailable` |
| `all_models_failed`      | `models`   | 502  | `provider_unavailable` |
| `invalid_output`         | `validate` | 502  | `invalid_model_output` |
| `internal_error`         | `response` | 500  | `internal_error`       |

`model_timeout` e `provider_error` quando só se chamou um modelo; `all_models_failed` quando a cadeia tinha mais de um e falharam todos.

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
        "fallbackModels": ["openai/gpt-4.1-mini"],
        "overrides": {
          "maxAttempts": { "value": 3, "source": "tool" },
          "totalTimeoutMs": { "value": 30000, "source": "engine" },
          "rateLimitPerMinute": { "value": 0, "source": "engine" },
          "streamEnabled": { "value": true, "source": "engine" }
        },
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

| Campo                   | Significado                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implemented`           | Existe no código deste servidor (pode correr).                                                                                                                                                     |
| `version`               | Versão do contrato de entrada/saída (só implementadas).                                                                                                                                            |
| `enabled`               | `false` = o Salesforce recebe `503 tool_disabled` nesta ferramenta.                                                                                                                                |
| `config`                | Configuração efetiva; `null` = não implementada e sem configuração gravada.                                                                                                                        |
| `config.source`         | `database` (gravada pelo admin) ou `default` (valores do código).                                                                                                                                  |
| `config.fallbackModels` | Modelos de recurso, por ordem. Com `source: "database"`, os gravados (pode ser `[]`); com `default`, os da definição `fallbackModels`.                                                             |
| `config.overrides`      | Para `maxAttempts`, `totalTimeoutMs`, `rateLimitPerMinute` e `streamEnabled`: o valor em vigor nesta ferramenta e de onde vem — `tool` (valor próprio, 6.3) ou `engine` (a definição global, 5.6). |
| `prompt.source`         | `database` (versão ativa), `code` (prompt de origem) ou `none`.                                                                                                                                    |

### 6.2 `GET /v1/admin/tools/:name`

Tudo de 6.1, mais:

```json
{
  "defaults": {
    "model": "google/gemini-2.5-flash",
    "fallbackModels": ["openai/gpt-4.1-mini"],
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

Grava a configuração (substitui toda). Corpo (obrigatórios os cinco primeiros; campos a mais dão `422`):

| Campo                | Tipo            | Regras                                                                                 |
| -------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `model`              | string          | 1–200; id do OpenRouter (usar `/models`)                                               |
| `temperature`        | number          | 0–2                                                                                    |
| `maxOutputTokens`    | integer         | 1–32000                                                                                |
| `timeoutMs`          | integer         | 1000–120000                                                                            |
| `enabled`            | boolean         |                                                                                        |
| `fallbackModels`     | string[]        | opcional, omissão `[]`; até 3, cada um 1–200; por ordem de tentativa                   |
| `maxAttempts`        | integer \| null | opcional; 1–5. Tentativas por modelo nesta ferramenta                                  |
| `totalTimeoutMs`     | integer \| null | opcional; 2000–115000. Teto de tempo de um pedido nesta ferramenta                     |
| `rateLimitPerMinute` | integer \| null | opcional; 0–100000 (0 = sem limite). Com valor próprio, conta por org **e** ferramenta |
| `streamEnabled`      | boolean \| null | opcional. `false` recusa `"stream": true` só nesta ferramenta                          |

Os quatro últimos substituem a definição global com o mesmo nome (5.6) **só nesta ferramenta**. `null` ou ausente = segue a global (e passa a acompanhá-la quando ela mudar). Os limites e as mensagens de erro são os de `PATCH /v1/admin/settings`: `422` com "As definições não são válidas." e um `details[]` por campo (`path` = `body.maxAttempts`…).

```json
{
  "model": "anthropic/claude-sonnet-4.5",
  "temperature": 0.3,
  "maxOutputTokens": 800,
  "timeoutMs": 20000,
  "enabled": true,
  "fallbackModels": ["google/gemini-2.5-flash", "openai/gpt-4.1-mini"],
  "maxAttempts": 3,
  "rateLimitPerMinute": null
}
```

Resposta `200`: o detalhe da ferramenta (como 6.2), já com `config.source = "database"`. Erros: `404 unknown_tool`, `422`.

**Modelos de recurso.** Quando o modelo principal (ou o OpenRouter) falha, o motor experimenta estes por ordem:

- fornecedor em baixo (`provider_unavailable`) ou tempo esgotado (`timeout`) → passa logo ao seguinte;
- resposta que não cumpre o esquema → nova tentativa no mesmo modelo até `maxAttempts` (2 por omissão) e depois passa ao seguinte;
- cada chamada usa o `timeoutMs` da ferramenta, dentro de um teto por pedido (`totalTimeoutMs`, 30 s por omissão); não se começa uma tentativa com menos de 1 s;
- **disjuntor**: depois de `breakerThreshold` falhas de fornecedor seguidas (3), o modelo é saltado durante `breakerOpenMs` (60 s), exceto se for o último da cadeia (ver 5.7).

Omitir `fallbackModels` grava `[]` (apaga os que existiam). Cada modelo de recurso é validado contra o catálogo do OpenRouter (o mesmo de `/models`, com cache de 15 min): erros `422 invalid_request` com a mensagem "Os modelos de recurso não são válidos." e um `details[]` por modelo, com `path` = `body.fallbackModels.<i>` e `issue` = `repetido`, `é o modelo principal`, `não existe no catálogo de modelos do OpenRouter` ou `não suporta respostas com JSON Schema`. Mais de 3: `422` com `path` = `body.fallbackModels`. Se o OpenRouter não responder ao pedir o catálogo: `502 provider_unavailable` (nada é gravado).

> A IRIS não verifica se o modelo **principal** existe no OpenRouter. Um modelo errado ou sem suporte para JSON Schema faz os pedidos falharem com `502 provider_unavailable`. **Na UI, escolher o modelo a partir de `/models` e testar no playground antes de gravar.**

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

### 6.6 `GET /v1/admin/tools/:name/pipeline`

O caminho de um pedido a esta ferramenta, **pela ordem do código** (`src/engine/pipeline.ts`), com o estado de cada passo, o que o controla e as contagens desde o arranque (por instância). Para o diagrama da consola: cada passo abre o que o controla. Funciona também com ferramentas não implementadas (todos os passos `off`, `models: []`). Erro: `404 unknown_tool`.

```jsonc
{
  "tool": "sentiment",
  "generatedAt": "2026-11-06T10:00:00.000Z",
  "since": "2026-11-06T08:00:00.000Z", // arranque: as contagens são desde aqui
  "stages": [
    {
      "id": "rate",
      "label": "Limite de pedidos",
      "status": "ok", // ok | warning | error | off (como na topologia)
      "summary": "60 pedidos por minuto por org nesta ferramenta",
      "counts": { "passed": 118, "stopped": 2 },
      "stoppedByCode": { "rate_limited": 2 },
      "toolConfig": [], // campos de PUT /tools/:name/config que o controlam
      "settings": ["rateLimitPerMinute"], // chaves de /settings (globais)
      "overrides": ["rateLimitPerMinute"], // as que esta ferramenta pode substituir
      "env": [], // variáveis só do .env (nomes, nunca valores)
      "details": { "limitPerMinute": 60, "source": "tool" },
    },
  ],
  "models": [
    {
      "model": "google/gemini-2.5-flash",
      "role": "primary", // primary | fallback
      "breaker": { "state": "closed", "openUntil": null, "consecutiveFailures": 0 },
      "calls": 40,
      "succeeded": 37,
      "avgDurationMs": 1500,
      "failedByReason": {
        "provider_unavailable": 2,
        "timeout": 1,
        "invalid_output": 0,
        "skipped_breaker": 5,
      },
      "servedAsFallback": 0,
    },
  ],
}
```

**Os passos** (sempre os nove, por esta ordem):

| `id`       | O que faz                                                  | Pára com                                                 | Controlado por                                                                                                                                                                                         | `details`                                                                      |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `request`  | Credencial, corpo e entrada da ferramenta                  | `unauthorized`, `invalid_request`, `payload_too_large`   | env `API_SECRET`, `MAX_BODY_BYTES`                                                                                                                                                                     | —                                                                              |
| `gate`     | Lê a configuração: ligada? streaming permitido?            | `tool_disabled`, `invalid_request` (`body.stream`)       | `enabled`                                                                                                                                                                                              | `enabled`, `streamSupported`                                                   |
| `rate`     | Limite de pedidos por minuto                               | `rate_limited`                                           | `rateLimitPerMinute` (global e por ferramenta)                                                                                                                                                         | `limitPerMinute`, `source` (`tool`/`engine`)                                   |
| `access`   | StepAccess (conta utilização)                              | `access_denied`, `quota_exceeded`, `service_unavailable` | `stepAccessTimeoutMs`; env `ACCESS_MODE`, `STEPACCESS_*`                                                                                                                                               | `mode`, `latencyMs` (da última verificação de um pedido com resposta)          |
| `memories` | Memórias da org e do utilizador                            | `internal_error`                                         | `memoryMaxChars`, `memoryPerOrg`, `memoryPerUser`                                                                                                                                                      | `orgAvg`, `userAvg` (por pedido com resposta), `runs`                          |
| `prompt`   | Prompt de sistema com as memórias e mensagem do utilizador | `internal_error`                                         | versões do prompt (6.5)                                                                                                                                                                                | `source`, `activeVersion`                                                      |
| `models`   | Cadeia de modelos, tentativas, disjuntor, teto de tempo    | `provider_unavailable`, `timeout`                        | `model`, `fallbackModels`, `temperature`, `maxOutputTokens`, `timeoutMs`; `defaultModel`, `fallbackModels`, `totalTimeoutMs` (por ferramenta), `breakerThreshold`, `breakerOpenMs`; env `OPENROUTER_*` | `primary`, `fallbacks`, `openBreakers`, `totalTimeoutMs`, `totalTimeoutSource` |
| `validate` | A resposta cumpre o esquema                                | `invalid_model_output`                                   | `maxAttempts` (global e por ferramenta)                                                                                                                                                                | `invalidOutputs`, `retries`, `maxAttempts`, `maxAttemptsSource`                |
| `response` | JSON ou SSE; custo para o StepAccess em segundo plano      | `internal_error`                                         | `streamEnabled` (global e por ferramenta), `stepAccessUsageTimeoutMs`                                                                                                                                  | `succeeded`, `avgDurationMs`, `stream`, `streamSource`                         |

- `counts.passed` de um passo = os que lá chegaram menos os que lá pararam; o primeiro recebe todos os pedidos à ferramenta. `response.passed` = respostas com sucesso.
- `status`: `gate` fica `off` com a ferramenta desligada; `access` e `memories` seguem o nó correspondente da topologia (`adapter.access`, `adapter.pgMemoryStore`); `models` fica `warning` com um disjuntor aberto na cadeia e `error` com todos; `rate`, `validate` e `response` ficam `warning` com ≥ 20% (mínimo 5) parados, inválidos ou falhados.
- `models`: a cadeia em vigor, por ordem, com o disjuntor de cada modelo (5.7) e as chamadas feitas **por esta ferramenta**. `failedByReason.skipped_breaker` conta os saltos (não são chamadas).
- Cada passo traz também `kind` (o tipo de desenho: `request`, `gate`, `rate`, `access`, `memories`, `prompt`, `model`, `validate`, `response`) e `exits`: as saídas possíveis nesse passo, `[{ code, httpStatus, label }]`, do catálogo (5.8).
- `modelChain`: a cadeia no formato curto, `[{ model, role, order, breaker: "closed" | "open" | "half_open", openedAt?, reopensAt? }]`.
- Nunca inclui segredos, valores do `.env`, ids de org ou de utilizador, nem conteúdo de pedidos.

### 6.7 `GET /v1/admin/tools/:name/traces?limit=20`

Os últimos pedidos a esta ferramenta, do mais recente para o mais antigo, para o dashboard reproduzir um pedido real no diagrama. `limit`: 1–500 (omissão 20). Erro: `404 unknown_tool`.

```json
{
  "tool": "reply",
  "instanceId": "iris-7f9c2b:3e1a90cd",
  "enabled": true,
  "traces": [
    {
      "id": "2c002e0d-2208-4fc6-beed-868c43cdf734",
      "at": "2026-11-07T10:02:13.120Z",
      "orgRef": "9f2c41aa0be7d3c5",
      "durationMs": 950,
      "outcome": "success",
      "path": [
        { "stage": "request", "ms": 0 },
        { "stage": "gate", "ms": 1 },
        { "stage": "rate", "ms": 0 },
        { "stage": "access", "ms": 30 },
        { "stage": "memories", "ms": 2 },
        { "stage": "prompt", "ms": 1 },
        {
          "stage": "models",
          "ms": 500,
          "model": "google/gemini-2.5-flash",
          "attempt": 1,
          "result": "timeout"
        },
        {
          "stage": "models",
          "ms": 400,
          "model": "openai/gpt-4.1-mini",
          "attempt": 1,
          "result": "ok"
        },
        { "stage": "validate", "ms": 1 },
        { "stage": "response", "ms": 0 }
      ]
    }
  ]
}
```

- **Só metadados, em memória, por instância.** Perdem-se ao reiniciar; nada vai para a base de dados. Nunca têm o texto do pedido, da resposta ou do prompt, nem o utilizador.
- `orgRef`: um id **opaco** da org (HMAC com uma chave derivada do `ADMIN_API_SECRET`, 16 hex). É sempre o mesmo para a mesma org e em todas as instâncias, mas não revela qual é; se for preciso o nome, a tradução fica no StepHub. Mudar o `ADMIN_API_SECRET` muda os ids.
- `id`: o `X-Request-Id` do pedido (o mesmo dos logs). Nos que falharam, `code` (o que o cliente recebeu) e `reason` (5.8); o último passo de `path` tem `stopped: true`.
- Os pedidos recusados antes do motor (credencial, corpo inválido) não entram.
- Ligam-se e desligam-se com as definições `tracesEnabled` e `tracesPerTool` (5.6).

### 6.8 `POST /v1/admin/tools/:name/dry-run`

Corre os passos de entrada e de contexto **sem StepAccess nem modelo** (sem custo, sem contar utilização nem limite de pedidos). Corpo: `{ "orgId": "00D…", "userId": "005…", "input": { … } }`. Exige `X-Admin-Actor`.

```json
{
  "tool": "reply",
  "path": [
    { "stage": "request", "ms": 0 },
    { "stage": "gate", "ms": 2 },
    { "stage": "rate", "ms": 0, "skipped": true },
    { "stage": "access", "ms": 0, "skipped": true },
    { "stage": "memories", "ms": 3 },
    { "stage": "prompt", "ms": 0 }
  ],
  "prompt": { "systemChars": 1820, "userChars": 240, "estimatedTokens": 515 },
  "memories": { "org": 2, "user": 1 },
  "model": "google/gemini-2.5-flash",
  "fallbackModels": ["openai/gpt-4.1-mini"],
  "enabled": true
}
```

`estimatedTokens` é uma estimativa grosseira (~4 caracteres por token). Não devolve o texto do prompt (para isso, `playground/:name/preview`). Funciona com a ferramenta desligada. Erros como no playground: `404 unknown_tool` (sem implementação), `503` sem OpenRouter, `422` com `body.input.<campo>`.

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
| `content` | string   | 1 até `memoryMaxChars` (500 por omissão), obrigatório                        |
| `tools`   | string[] | opcional; nomes do catálogo, sem repetidos, máx. 20; omitido ou `[]` = todas |

Resposta `201`: a memória criada. Erros: `409 memory_limit_reached` (`memoryPerOrg`, 50 por omissão), `422` (inclui ferramenta desconhecida: `"Ferramenta desconhecida: x."`).

Só se criam memórias da **org** por esta API. As de utilizador nascem na IRIS a pedido do próprio utilizador.

### 7.5 `PATCH /v1/admin/memories/:id` — editar memória da org

Corpo com pelo menos um campo:

| Campo     | Tipo     | Regras                                  |
| --------- | -------- | --------------------------------------- |
| `content` | string   | 1 até `memoryMaxChars`                  |
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

| Campo                    | Tipo     | Regras                                                                           |
| ------------------------ | -------- | -------------------------------------------------------------------------------- |
| `orgId`                  | string   | `00D…` 18 car. — memórias desta org                                              |
| `userId`                 | string   | `005…` 18 car. — memórias deste utilizador                                       |
| `input`                  | object   | campos da ferramenta (ver `inputSchema` em 6.2), validados como no pedido real   |
| `systemPrompt`           | string   | opcional, 1–20000 — substitui o prompt só neste teste                            |
| `model`                  | string   | opcional, 1–200 — substitui o modelo só neste teste                              |
| `fallbackModelsOverride` | string[] | opcional, até 3 — substitui os modelos de recurso só neste teste (`[]` = nenhum) |

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
    "fallbackModels": ["openai/gpt-4.1-mini"],
    "enabled": true,
    "maxAttempts": 2,
    "totalTimeoutMs": 30000,
    "rateLimitPerMinute": 0,
    "streamEnabled": true,
    "overrides": {
      "maxAttempts": null,
      "totalTimeoutMs": null,
      "rateLimitPerMinute": null,
      "streamEnabled": null
    }
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

`settings.systemPrompt` aparece só quando há versão ativa na base de dados. `maxAttempts`, `totalTimeoutMs`, `rateLimitPerMinute` e `streamEnabled` são os valores **em vigor** nesta ferramenta; `overrides` mostra os valores próprios gravados (`null` = segue a definição global).

### 8.2 `POST /v1/admin/playground/:name/run`

Corpo comum mais:

| Campo        | Tipo    | Regras                                                                                                                                                                                                                                                       |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `countUsage` | boolean | opcional, omissão `false`. `true` = pergunta ao StepAccess e conta utilização como um pedido real (pode dar `403 access_denied` / `429 quota_exceeded`). Só com `config.stepAccess = "live"`; em `open`, `bypass` ou `missing` dá `503 service_unavailable`. |

Resposta `200` (mesmo quando o modelo responde mal — ver `ok`):

```json
{
  "tool": "diagnostic",
  "ok": true,
  "result": { "reply": "Olá! Estou a funcionar." },
  "error": null,
  "countedUsage": false,
  "durationMs": 1432,
  "timings": { "access": 0, "memories": 3, "prompt": 0, "models": 1420, "validate": 1 },
  "settings": {
    "model": "google/gemini-2.5-flash",
    "temperature": 0.2,
    "maxOutputTokens": 300,
    "timeoutMs": 20000,
    "fallbackModels": ["openai/gpt-4.1-mini"],
    "enabled": true,
    "maxAttempts": 2,
    "totalTimeoutMs": 30000,
    "rateLimitPerMinute": 0,
    "streamEnabled": true,
    "overrides": {
      "maxAttempts": null,
      "totalTimeoutMs": null,
      "rateLimitPerMinute": null,
      "streamEnabled": null
    }
  },
  "memories": { "org": ["Tratar sempre o cliente por você."], "user": [] },
  "prompt": { "system": "…", "user": "Olá" },
  "attempts": [
    {
      "text": null,
      "valid": false,
      "reason": "provider_unavailable",
      "fallback": false,
      "requestedModel": "google/gemini-2.5-flash",
      "model": "google/gemini-2.5-flash",
      "durationMs": 412
    },
    {
      "text": "{\"reply\":\"Olá! Estou a funcionar.\"}",
      "valid": true,
      "reason": "ok",
      "fallback": true,
      "requestedModel": "openai/gpt-4.1-mini",
      "model": "openai/gpt-4.1-mini",
      "durationMs": 1020,
      "inputTokens": 180,
      "outputTokens": 14,
      "costUsd": 0.0000963
    }
  ]
}
```

| Campo                       | Significado                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                        | `true` = resposta válida em `result`. `false` = toda a cadeia de modelos falhou (`result: null`; ver `error` e `attempts`).                                                                          |
| `error`                     | `null` com `ok: true`. Com `ok: false`: `{ code, message }` da última tentativa (`invalid_model_output`, `provider_unavailable` ou `timeout`).                                                       |
| `attempts`                  | Uma entrada por tentativa, pela ordem da cadeia (modelo principal e depois os de recurso), incluindo os modelos saltados.                                                                            |
| `attempts[].reason`         | `ok` · `invalid_output` (não cumpriu o esquema) · `provider_unavailable` · `timeout` · `skipped_breaker` (saltado pelo disjuntor, sem chamada).                                                      |
| `attempts[].fallback`       | `true` quando o modelo não é o principal.                                                                                                                                                            |
| `attempts[].requestedModel` | Modelo pedido.                                                                                                                                                                                       |
| `attempts[].model`          | Modelo que de facto respondeu (o OpenRouter pode indicar uma variante); igual a `requestedModel` quando não houve resposta.                                                                          |
| `attempts[].text`           | Texto bruto devolvido pelo modelo; `null` quando não houve resposta.                                                                                                                                 |
| `attempts[].costUsd`        | Custo da tentativa em dólares, indicado pelo OpenRouter (ausente se não vier).                                                                                                                       |
| `timings`                   | Tempo real de cada passo, em ms: `access` (0 sem `countUsage`), `memories`, `prompt`, `models` (soma das chamadas ao modelo) e `validate` (soma das validações). Para animar a simulação na consola. |

Falhas do modelo (rede, chave, créditos, tempo esgotado) **já não** dão 502/504 no playground: a resposta é `200` com `ok: false`, o `error` e as tentativas, para se ver em que modelo e porquê falhou. O playground usa o mesmo disjuntor, as mesmas tentativas e o mesmo teto de tempo da ferramenta que os pedidos reais, mas não conta para o limite de pedidos nem entra nas métricas.

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

| Ação                                                                        | Perfil                                       |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| Ver estado, métricas, modelos, ferramentas, prompts, memórias               | qualquer utilizador com acesso ao StepAccess |
| Playground (`preview`, `run` sem contar)                                    | qualquer                                     |
| Criar, editar, apagar memórias da org; apagar memórias de utilizador        | qualquer                                     |
| Configuração de ferramentas, versões e ativação de prompts                  | **admin**                                    |
| Definições (`PATCH /settings`), valores por ferramenta e fechar o disjuntor | **admin**                                    |
| `memories/purge`, playground com `countUsage: true`                         | **admin**                                    |

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
2. **Definições** — `/settings`: um formulário por `group`, campos gerados de `constraints`, origem de cada valor e "Repor" para voltar ao valor inicial. Na secção dos modelos, o seletor alimentado por `/models` e, com disjuntores abertos (`/breakers`), o botão "Fechar disjuntor". `stage` liga cada definição a um passo do diagrama; `overridablePerTool` diz se a ferramenta a pode substituir.
3. **Atividade** — `/metrics`: totais, gráfico por dia (pedidos ok vs falhados), tabela por ferramenta, erros por código. Mostrar "desde <since>" e explicar que recomeça ao reiniciar.
4. **Ferramentas** — o diagrama de `/tools/:name/pipeline`: um bloco por passo, com `status`, `summary` e `counts`; ao abrir um passo, os campos de `toolConfig` (formulário da ferramenta), `overrides` (valor próprio ou "segue a global"), `settings` (link para Definições) e `env` (só leitura). Tabela (`name`, implementada, ligada, modelo, origem da config e do prompt).
   - Detalhe: formulário da configuração (seletor de modelo alimentado por `/models`, temperatura 0–2, tokens, tempo limite, ligada); "Repor valores de origem".
   - Separador **Prompt**: versão ativa; histórico; **comparação lado a lado (diff)** entre versões e com o prompt do código; "Nova versão" (editor de texto grande + nota de alteração + "ativar já"); "Ativar esta versão"; "Usar o prompt de origem".
   - Botão "Testar no playground" com o prompt/modelo em edição antes de gravar.
5. **Memórias**
   - Filtros: org, utilizador, âmbito, ferramenta, pesquisa; paginação.
   - Na **página da org** que já existe no StepAccess: painel "Memórias da IRIS" com o resumo (`/summary`), a lista da org, criar/editar/apagar, e as memórias de cada utilizador (só apagar).
   - Contador de caracteres (500) e de limite (50/20). Chips de ferramentas ("todas" quando vazio).
   - "Apagar todas as memórias" (purge) com confirmação forte.
   - Ao apagar uma org ou um utilizador no StepAccess, chamar o purge correspondente.
6. **Playground**
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
