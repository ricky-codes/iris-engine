# IRIS Engine → StepHub / StepAccess: o que mudou na API de administração

> **Para:** o agente que mantém o backend do StepAccess (Express) e a UI do StepHub (React + Vite + Tailwind).
> **Origem:** repositório `ricky-codes/iris-engine`, branch `main`, commit `7374cb6`.
> **Fonte de verdade:** `docs/ADMIN_API.md` e `docs/MODULES.md` nesse repositório. Se este ficheiro e o código discordarem, ganha o código.
> **Contexto:** a IRIS é o motor de IA. A API de administração está em `/v1/admin/*`, autenticada com `Authorization: Bearer <ADMIN_API_SECRET>`, e o backend do StepAccess faz de proxy para a UI.

O trabalho do teu lado é pequeno: **uma rota nova de leitura**, **uma remoção na topologia** e **um código de erro novo para traduzir**. Nada do resto da API de administração mudou de forma.

---

## 1. Acrescentar: `GET /v1/admin/modules` (só leitura)

Descreve os cinco adaptadores que ligam o motor ao mundo: `PgEngineStore`, `PgMemoryStore`, `StepAccessClient`, `StepAccessUsageReporter` e `OpenRouterProvider`. Serve para uma página "Módulos" na consola.

### Backend do StepAccess

- Proxy `GET /v1/admin/modules` para a IRIS, com o mesmo `ADMIN_API_SECRET` e o mesmo tratamento de erros das outras rotas de leitura (por exemplo `GET /v1/admin/topology`).
- Permissão: a mesma de ler a topologia ou o estado. Não é preciso permissão nova.
- **Sem auditoria** (`access_audit_log`): não escreve nada.
- Resposta nunca inclui segredos. Pode ser reenviada à UI tal como vem.

### Contrato (TypeScript)

```ts
export type NodeStatus = 'ok' | 'warning' | 'error' | 'off';
export type SettingValue = string | number | boolean | string[] | null;

export interface ModuleSetting {
  key: string;
  label: string;
  description: string;
  /** O valor em vigor; null quando não está definido. */
  value: SettingValue;
  /** database = muda-se pela API sem reiniciar · env = .env, exige reiniciar o serviço · code = constante. */
  source: 'database' | 'env' | 'code';
  /** A rota que o altera hoje, p.ex. "PUT /v1/admin/tools/:name/config". null = só .env ou código. */
  adminPath: string | null;
}

export interface ProposedSetting {
  key: string;
  label: string;
  description: string;
  suggested: string;
}

export interface ModuleInfo {
  /** O nó da topologia a que corresponde (GET /v1/admin/topology). */
  id: 'adapter.pgEngineStore' | 'adapter.pgMemoryStore' | 'adapter.access' | 'adapter.usage' | 'adapter.llm';
  className: string;
  file: string;
  /** A interface do motor que implementa. */
  port: string;
  status: NodeStatus;
  /** Em uso neste servidor. false p.ex. para o StepAccess quando ACCESS_MODE=open. */
  active: boolean;
  summary: string;
  description: string;
  /** O que acontece ao pedido se este módulo falhar. */
  onFailure: string;
  settings: ModuleSetting[];
  proposed: ProposedSetting[];
}

export interface ModulesReport {
  generatedAt: string; // ISO 8601
  modules: ModuleInfo[]; // sempre 5, por esta ordem
}
```

### Exemplo (abreviado)

```json
{
  "generatedAt": "2026-11-03T09:00:00.000Z",
  "modules": [
    {
      "id": "adapter.llm",
      "className": "OpenRouterProvider",
      "file": "src/adapters/openrouter.ts",
      "port": "LlmProvider",
      "status": "ok",
      "active": true,
      "summary": "Chama os modelos de IA através do OpenRouter.",
      "description": "…",
      "onFailure": "Fornecedor em baixo: 502 provider_unavailable, depois de tentar os modelos de recurso. Tempo esgotado: 504 timeout.",
      "settings": [
        {
          "key": "maxAttempts",
          "label": "Tentativas por modelo",
          "description": "…",
          "value": 2,
          "source": "env",
          "adminPath": null
        }
      ],
      "proposed": [
        {
          "key": "breaker",
          "label": "Tentativas e disjuntor editáveis sem reiniciar",
          "description": "…",
          "suggested": "2 tentativas · 3 falhas · 60 s"
        }
      ]
    }
  ]
}
```

### UI sugerida: página "Módulos"

- Cinco cartões, um por módulo, com `className`, `port`, um selo de `status` (ok verde, warning amarelo, error vermelho, off cinzento) e o `summary`.
- Módulo com `active: false`: cartão a cinzento com a indicação "não usado neste servidor".
- Dentro do cartão: `description`, `onFailure` e a lista `settings`. Em cada definição:
  - mostra `label` e `value` (listas como etiquetas, `null` como "—");
  - mostra a origem (`source`): "base de dados", ".env" ou "código";
  - se `adminPath !== null`, liga ao ecrã que já faz essa operação (por exemplo, configuração da ferramenta). Se `null`, mostra "só no servidor".
- `proposed[]`: secção recolhida "Evolução prevista", **só informativa**. Nenhum destes itens existe na API. **Não criar botões nem formulários para eles.**
- Recarregar ao abrir a página; não é preciso polling.

### O que **não** existe (não implementar)

Não há rotas de escrita para estes módulos. As definições com `source: "env"` ou `"code"` só se mudam no servidor (`.env` e reinício). A única configuração editável pela API continua a ser a das ferramentas (modelo, modelos de recurso, temperatura, limites, ligada/desligada, prompts) e as memórias, que já têm ecrãs.

---

## 2. Remover ou tolerar: topologia (`GET /v1/admin/topology`)

Foram retirados:

- os nós `client.n8n` e `http.compat`;
- as ligações `client.n8n → http.compat` e `http.compat → core.engine`.

O que fazer:

- Se a UI desenha a topologia só a partir da resposta, **não há nada a fazer**.
- Se algum ecrã, layout fixo, filtro, teste ou fixture referir esses ids, **retirar essas referências**.
- A UI não deve falhar se um id que esperava não existir.

A rota `POST /v1/compat/n8n` também foi removida da IRIS (dá 404). Isto só interessa se algum fluxo do StepHub ou do n8n ainda a chamar: confirmar que nada a usa.

---

## 3. Tolerar: código de erro novo nas métricas

- `GET /v1/admin/metrics` pode passar a mostrar o código **`rate_limited`** nos contadores de erros por código.
- Origem: as rotas de ferramentas (`/v1/tools/*`, chamadas pelo Salesforce) passaram a ter um limite opcional de pedidos por minuto e por org, que responde **429 `rate_limited`** com `Retry-After`. Só se ativa com a variável de ambiente `RATE_LIMIT_PER_MINUTE` (omissão: desligado).
- Se a UI traduz códigos para texto, acrescentar: `rate_limited` → "Limite de pedidos por org atingido".
- Se a UI mostra um código desconhecido tal como vem, não precisa de mudar.
- A API de administração em si **não** devolve `rate_limited`.
- O código `not_implemented` deixou de existir.

---

## 4. Contratos do StepAccess que a IRIS chama (sem mudança de forma)

| Chamada | Quando | Mudança |
| --- | --- | --- |
| `GET /v1/access?orgId&userId&componentUuid` | Em cada pedido de ferramenta | Nenhuma |
| `POST /v1/usage/cost` | Depois de cada pedido que chegou ao modelo | Nenhuma no corpo nem na idempotência (`requestId`; `409` conta como entregue) |

Uma única atenção: o tempo máximo do envio do custo passou de 3 s para **10 s** por omissão (`STEPACCESS_USAGE_TIMEOUT_MS`). O endpoint `POST /v1/usage/cost` deve responder dentro desse tempo. Se não responder, a IRIS repete uma vez e depois só regista no log: **o custo perde-se**, porque ainda não há fila de reenvio.

---

## 5. Streaming: não toca na API de administração

- O **playground** (`/v1/admin/playground/*`) **não** faz streaming. Nada a mudar aí.
- O streaming é nas rotas `/v1/tools/<nome>` (usadas pelo Salesforce), com `"stream": true` no corpo. Hoje só a ferramenta `diagnostic` o suporta. `GET /v1/tools` (não é admin) indica `streaming: true|false` por ferramenta.
- Resposta SSE, com os eventos `start`, `delta`, `reset`, `result` e `error`. Detalhe no `README.md` do repositório da IRIS, secção "Streaming".
- **Limitação a ter em conta:** um callout Apex só devolve o corpo quando a resposta termina, por isso `"stream": true` só traz benefício a quem lê SSE aos bocados (um componente LWC através de um proxy, ou um serviço Node). Se o único consumidor é Apex, não vale a pena usar.
- Se o backend do StepAccess ou outro proxy ficar entre o cliente e a IRIS nestas rotas, tem de **desligar o buffering** da resposta (`X-Accel-Buffering: no` já vem da IRIS; confirmar que o proxy o respeita) e não impor um timeout de inatividade curto.

---

## 6. Lista de verificação

- [ ] Proxy `GET /v1/admin/modules` no backend do StepAccess (permissão de leitura, sem auditoria).
- [ ] Tipos `ModulesReport` no frontend.
- [ ] Página "Módulos" com cinco cartões; módulos `active: false` a cinzento; `proposed[]` só informativo.
- [ ] Retiradas as referências a `client.n8n` e `http.compat` (topologia).
- [ ] Texto para `rate_limited` nas métricas.
- [ ] Confirmado que nenhum fluxo chama `POST /v1/compat/n8n`.
- [ ] Confirmado que `POST /v1/usage/cost` responde em menos de 10 s.
- [ ] (Só se houver streaming a atravessar proxies) buffering desligado e sem timeout de inatividade curto.
