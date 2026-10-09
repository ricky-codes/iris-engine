import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AdminApi } from '../api.js';
import type { CreatedKey, KeySummary } from '../commands.js';
import {
  buildTree,
  type AdminData,
  type OrgRow,
  type TenantRow,
  type UserRow,
} from '../queries.js';
import {
  validateInstanceUrl,
  validateName,
  validateOptionalPositiveInt,
  validateOrgRef,
  validateSlug,
  validateUserRef,
} from '../validation.js';
import { Form, type FieldDef, type FormValues } from './Form.js';
import { colorProps, fmtDate, plural } from './format.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Help, RevealKey } from './Overlays.js';
import { relationLines, type RelationLine } from './relations.js';
import { Table, type Column } from './Table.js';

const TABS = [
  { id: 'relations', label: 'Relações' },
  { id: 'tenants', label: 'Clientes' },
  { id: 'orgs', label: 'Orgs' },
  { id: 'users', label: 'Utilizadores' },
  { id: 'keys', label: 'Chaves' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Mode =
  | { kind: 'browse' }
  | {
      kind: 'form';
      id: number;
      title: string;
      fields: FieldDef[];
      submitLabel: string;
      onSubmit: (values: FormValues) => Promise<void>;
    }
  | {
      kind: 'confirm';
      title: string;
      lines: string[];
      confirmLabel: string;
      danger: boolean;
      onConfirm: () => Promise<void>;
    }
  | { kind: 'reveal'; created: CreatedKey; org: string }
  | { kind: 'help' };

interface Notice {
  text: string;
  error: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

const activeColor = (active: boolean): string => (active ? 'green' : 'red');
const keyColor = (status: KeySummary['status']): string =>
  status === 'ativa' ? 'green' : status === 'revogada' ? 'red' : 'yellow';

const HINTS: Record<TabId, string> = {
  relations: '↑↓ percorre',
  tenants: 'n novo cliente · o nova org neste cliente · a ativar/desativar',
  orgs: 'n nova org · u novo utilizador · k nova chave · a ativar/desativar',
  users: 'n novo utilizador · d apagar',
  keys: 'n nova chave · r revogar',
};

export function App({ api }: { api: AdminApi }) {
  const { exit } = useApp();
  const { cols, rows: termRows } = useTerminalSize();

  const [data, setData] = useState<AdminData | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [tab, setTab] = useState(0);
  const [selection, setSelection] = useState<number[]>([0, 0, 0, 0, 0]);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [notice, setNotice] = useState<Notice | undefined>();
  const [formCounter, setFormCounter] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await api.load());
      setLoadError(undefined);
    } catch (err) {
      setLoadError(message(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => {
      setNotice(undefined);
    }, 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const tabId: TabId = TABS[tab]?.id ?? 'relations';
  const relLines = useMemo<RelationLine[]>(
    () => (data ? relationLines(buildTree(data)) : []),
    [data],
  );
  const counts: Record<TabId, number> = {
    relations: relLines.length,
    tenants: data?.tenants.length ?? 0,
    orgs: data?.orgs.length ?? 0,
    users: data?.users.length ?? 0,
    keys: data?.keys.length ?? 0,
  };
  const selected = clamp(selection[tab] ?? 0, 0, Math.max(0, counts[tabId] - 1));

  const tableHeight = Math.max(5, termRows - 9);

  const notify = (text: string, error = false): void => {
    setNotice({ text, error });
  };
  const close = (): void => {
    setMode({ kind: 'browse' });
  };

  /** Executa uma ação, recarrega os dados e mostra o resultado. */
  const act = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    try {
      await fn();
      await refresh();
      notify(ok);
    } catch (err) {
      notify(message(err), true);
    } finally {
      close();
    }
  };

  const openForm = (
    title: string,
    fields: FieldDef[],
    submitLabel: string,
    onSubmit: (values: FormValues) => Promise<void>,
  ): void => {
    setFormCounter((n) => n + 1);
    setMode({ kind: 'form', id: formCounter + 1, title, fields, submitLabel, onSubmit });
  };

  const tenantOptions = (data?.tenants ?? []).map((t) => ({
    value: t.slug,
    label: `${t.slug} (${t.name})`,
  }));
  const orgOptions = (data?.orgs ?? []).map((o) => ({
    value: o.sfOrgRef,
    label: `${o.tenantSlug} · ${o.sfOrgRef}${o.isSandbox ? ' · sandbox' : ''}`,
  }));

  // ---- ações que abrem formulários ----

  const newTenant = (): void => {
    openForm(
      'Novo cliente',
      [
        {
          kind: 'text',
          name: 'slug',
          label: 'Identificador',
          validate: validateSlug,
          hint: 'minúsculas e hífenes, ex.: pingo-doce',
        },
        { kind: 'text', name: 'name', label: 'Nome', validate: validateName },
        {
          kind: 'text',
          name: 'days',
          label: 'Retenção de resultados (dias)',
          optional: true,
          validate: validateOptionalPositiveInt,
          hint: 'vazio = 30 dias',
        },
      ],
      'criar',
      async (v) => {
        const days = (v['days'] ?? '').trim();
        await api.createTenant({
          slug: v['slug'] ?? '',
          name: v['name'] ?? '',
          ...(days !== '' && { retentionDays: Number(days) }),
        });
        await refresh();
        close();
        notify(`Cliente "${v['slug'] ?? ''}" criado.`);
      },
    );
  };

  const newOrg = (tenantSlug?: string): void => {
    openForm(
      'Nova org',
      [
        {
          kind: 'select',
          name: 'tenant',
          label: 'Cliente',
          options: tenantOptions,
          ...(tenantSlug !== undefined && { initial: tenantSlug }),
        },
        {
          kind: 'text',
          name: 'orgId',
          label: 'Id da org',
          validate: validateOrgRef,
          hint: '18 caracteres, começa por 00D',
        },
        {
          kind: 'text',
          name: 'url',
          label: 'URL da instância',
          validate: validateInstanceUrl,
          hint: 'https://…my.salesforce.com',
        },
        { kind: 'toggle', name: 'sandbox', label: 'Sandbox / desenvolvimento' },
      ],
      'criar',
      async (v) => {
        await api.createOrg({
          tenantSlug: v['tenant'] ?? '',
          sfOrgRef: v['orgId'] ?? '',
          instanceUrl: v['url'] ?? '',
          isSandbox: v['sandbox'] === 'true',
        });
        await refresh();
        close();
        notify(`Org ${v['orgId'] ?? ''} criada.`);
      },
    );
  };

  const newUser = (orgRef?: string): void => {
    openForm(
      'Novo utilizador',
      [
        {
          kind: 'select',
          name: 'org',
          label: 'Org',
          options: orgOptions,
          ...(orgRef !== undefined && { initial: orgRef }),
        },
        {
          kind: 'text',
          name: 'userId',
          label: 'Id do utilizador',
          validate: validateUserRef,
          hint: '18 caracteres, começa por 005',
        },
      ],
      'criar',
      async (v) => {
        await api.createOrgUser({ sfOrgRef: v['org'] ?? '', sfUserRef: v['userId'] ?? '' });
        await refresh();
        close();
        notify(`Utilizador ${v['userId'] ?? ''} criado.`);
      },
    );
  };

  const newKey = (orgRef?: string): void => {
    openForm(
      'Nova chave de API',
      [
        {
          kind: 'select',
          name: 'org',
          label: 'Org',
          options: orgOptions,
          ...(orgRef !== undefined && { initial: orgRef }),
        },
        {
          kind: 'text',
          name: 'days',
          label: 'Validade (dias)',
          optional: true,
          validate: validateOptionalPositiveInt,
          hint: 'vazio = não expira',
        },
      ],
      'criar',
      async (v) => {
        const days = (v['days'] ?? '').trim();
        const org = v['org'] ?? '';
        const created = await api.createApiKey({
          sfOrgRef: org,
          ...(days !== '' && { expiresInDays: Number(days) }),
        });
        await refresh();
        setMode({ kind: 'reveal', created, org });
      },
    );
  };

  // ---- ações com confirmação ----

  const toggleTenant = (tenant: TenantRow): void => {
    if (!tenant.isActive) {
      void act(() => api.setTenantActive(tenant.slug, true), `Cliente "${tenant.slug}" ativado.`);
      return;
    }
    setMode({
      kind: 'confirm',
      title: `Desativar o cliente "${tenant.slug}"?`,
      lines: [
        `Todas as chaves das ${plural(tenant.orgCount, 'org', 'orgs')} deste cliente passam a ser recusadas.`,
        'Os dados ficam guardados e pode voltar a ativá-lo.',
      ],
      confirmLabel: 'desativa',
      danger: false,
      onConfirm: () =>
        act(() => api.setTenantActive(tenant.slug, false), `Cliente "${tenant.slug}" desativado.`),
    });
  };

  const toggleOrg = (org: OrgRow): void => {
    if (!org.isActive) {
      void act(() => api.setOrgActive(org.sfOrgRef, true), `Org ${org.sfOrgRef} ativada.`);
      return;
    }
    setMode({
      kind: 'confirm',
      title: `Desativar a org ${org.sfOrgRef}?`,
      lines: [
        'As chaves desta org passam a ser recusadas.',
        'Os dados ficam guardados e pode voltar a ativá-la.',
      ],
      confirmLabel: 'desativa',
      danger: false,
      onConfirm: () =>
        act(() => api.setOrgActive(org.sfOrgRef, false), `Org ${org.sfOrgRef} desativada.`),
    });
  };

  const revokeKey = (key: KeySummary): void => {
    if (key.status !== 'ativa') {
      notify(`A chave ${key.keyPrefix} já está ${key.status}.`, true);
      return;
    }
    setMode({
      kind: 'confirm',
      title: `Revogar a chave ${key.keyPrefix}?`,
      lines: [
        `Org ${key.org} (${key.tenant}).`,
        'O Salesforce deixa de conseguir usar esta chave de imediato. Não se desfaz.',
      ],
      confirmLabel: 'revoga',
      danger: true,
      onConfirm: () =>
        act(() => api.revokeApiKey(key.keyPrefix), `Chave ${key.keyPrefix} revogada.`),
    });
  };

  const deleteUser = async (user: UserRow): Promise<void> => {
    try {
      const preview = await api.previewUserDeletion(user.orgUserId);
      setMode({
        kind: 'confirm',
        title: `Apagar o utilizador ${user.sfUserRef}?`,
        lines: [
          `Org ${user.sfOrgRef} (${user.tenantSlug}).`,
          `Apaga também ${plural(preview.requests, 'pedido', 'pedidos')} (com os resultados) e ${plural(preview.memories, 'memória', 'memórias')} deste utilizador.`,
          'Não se desfaz. Se ele voltar a fazer um pedido, será criado de novo, sem histórico.',
        ],
        confirmLabel: 'apaga',
        danger: true,
        onConfirm: () =>
          act(() => api.deleteOrgUser(user.orgUserId), `Utilizador ${user.sfUserRef} apagado.`),
      });
    } catch (err) {
      notify(message(err), true);
    }
  };

  // ---- teclado no modo normal ----

  // Este manipulador nunca se desativa: se a captura de teclas chegasse a zero, a primeira
  // tecla a seguir perder-se-ia. Fora do modo normal, quem trata as teclas é o ecrã aberto.
  useInput((input, key) => {
    if (mode.kind !== 'browse') return;
    if (input === 'q') return exit();
    if (input === '?') return setMode({ kind: 'help' });
    if (input === 'R') return void refresh();

    if (key.leftArrow || (key.tab && key.shift))
      return setTab((t) => (t + TABS.length - 1) % TABS.length);
    if (key.rightArrow || key.tab) return setTab((t) => (t + 1) % TABS.length);
    if (/^[1-5]$/.test(input)) return setTab(Number(input) - 1);

    const move = (delta: number): void => {
      setSelection((s) =>
        s.map((v, i) =>
          i === tab ? clamp(selected + delta, 0, Math.max(0, counts[tabId] - 1)) : v,
        ),
      );
    };
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.pageUp) return move(-tableHeight);
    if (key.pageDown) return move(tableHeight);

    if (data === undefined) return;
    const tenant = data.tenants[selected];
    const org = data.orgs[selected];
    const user = data.users[selected];
    const apiKey = data.keys[selected];

    switch (tabId) {
      case 'tenants':
        if (input === 'n') newTenant();
        else if (input === 'o' && tenant) newOrg(tenant.slug);
        else if (input === 'a' && tenant) toggleTenant(tenant);
        break;
      case 'orgs':
        if (input === 'n') newOrg(org?.tenantSlug);
        else if (input === 'u' && org) newUser(org.sfOrgRef);
        else if (input === 'k' && org) newKey(org.sfOrgRef);
        else if (input === 'a' && org) toggleOrg(org);
        break;
      case 'users':
        if (input === 'n') newUser(user?.sfOrgRef);
        else if (input === 'd' && user) void deleteUser(user);
        break;
      case 'keys':
        if (input === 'n') newKey(apiKey?.org);
        else if (input === 'r' && apiKey) revokeKey(apiKey);
        break;
      case 'relations':
        break;
    }
  });

  // ---- o que se mostra ----

  const tenantCols: Column<TenantRow>[] = [
    { header: 'Cliente', width: 20, render: (t) => t.slug },
    { header: 'Nome', render: (t) => t.name },
    {
      header: 'Estado',
      width: 9,
      render: (t) => (t.isActive ? 'ativo' : 'inativo'),
      color: (t) => activeColor(t.isActive),
    },
    { header: 'Orgs', width: 5, render: (t) => String(t.orgCount) },
    { header: 'Retenção', width: 10, render: (t) => `${String(t.retentionDays)} dias` },
  ];
  const orgCols: Column<OrgRow>[] = [
    { header: 'Cliente', width: 18, render: (o) => o.tenantSlug },
    { header: 'Org', width: 20, render: (o) => o.sfOrgRef },
    { header: 'Tipo', width: 9, render: (o) => (o.isSandbox ? 'sandbox' : 'produção') },
    {
      header: 'Estado',
      width: 8,
      render: (o) => (o.isActive ? 'ativa' : 'inativa'),
      color: (o) => activeColor(o.isActive),
    },
    { header: 'Utiliz.', width: 7, render: (o) => String(o.userCount) },
    { header: 'URL', render: (o) => o.instanceUrl },
  ];
  const userCols: Column<UserRow>[] = [
    { header: 'Cliente', width: 18, render: (u) => u.tenantSlug },
    { header: 'Org', width: 20, render: (u) => u.sfOrgRef },
    { header: 'Utilizador', width: 20, render: (u) => u.sfUserRef },
    { header: 'Desde', width: 11, render: (u) => fmtDate(u.firstSeenAt) },
    { header: 'Pedidos', width: 8, render: (u) => String(u.requestCount) },
    { header: 'Memórias', render: (u) => String(u.memoryCount) },
  ];
  const keyCols: Column<KeySummary>[] = [
    { header: 'Cliente', width: 18, render: (k) => k.tenant },
    { header: 'Org', width: 20, render: (k) => k.org },
    { header: 'Prefixo', width: 10, render: (k) => k.keyPrefix },
    { header: 'Estado', width: 10, render: (k) => k.status, color: (k) => keyColor(k.status) },
    { header: 'Criada', width: 11, render: (k) => fmtDate(k.createdAt) },
    { header: 'Expira', render: (k) => fmtDate(k.expiresAt) },
  ];

  const detail = ((): string => {
    if (data === undefined) return '';
    switch (tabId) {
      case 'tenants': {
        const t = data.tenants[selected];
        return t ? `${t.name} · criado em ${fmtDate(t.createdAt)}` : '';
      }
      case 'orgs': {
        const o = data.orgs[selected];
        return o ? o.instanceUrl : '';
      }
      case 'users': {
        const u = data.users[selected];
        return u
          ? `${u.sfUserRef} · ${plural(u.requestCount, 'pedido', 'pedidos')} · ${plural(u.memoryCount, 'memória', 'memórias')}`
          : '';
      }
      case 'keys': {
        const k = data.keys[selected];
        return k ? `iris_${k.keyPrefix}_… · o segredo não é guardado e não pode ser mostrado` : '';
      }
      case 'relations':
        return '';
    }
  })();

  const body = (): React.ReactNode => {
    if (loadError !== undefined && data === undefined) {
      return <Text color="red">Não foi possível carregar os dados: {loadError}</Text>;
    }
    if (data === undefined) return <Text dimColor>A carregar…</Text>;

    const common = { selected, height: tableHeight, width: cols };
    switch (tabId) {
      case 'tenants':
        return (
          <Table
            {...common}
            columns={tenantCols}
            rows={data.tenants}
            empty="Sem clientes. Prima n para criar o primeiro."
            rowKey={(t) => t.tenantId}
          />
        );
      case 'orgs':
        return (
          <Table
            {...common}
            columns={orgCols}
            rows={data.orgs}
            empty="Sem orgs. Crie um cliente e prima n aqui."
            rowKey={(o) => o.sfOrgId}
          />
        );
      case 'users':
        return (
          <Table
            {...common}
            columns={userCols}
            rows={data.users}
            empty="Sem utilizadores. Aparecem sozinhos no primeiro pedido, ou prima n."
            rowKey={(u) => u.orgUserId}
          />
        );
      case 'keys':
        return (
          <Table
            {...common}
            columns={keyCols}
            rows={data.keys}
            empty="Sem chaves. Prima n para criar a primeira."
            rowKey={(k) => k.keyPrefix}
          />
        );
      case 'relations':
        return (
          <Table
            {...common}
            showHeader={false}
            columns={[
              {
                header: '',
                render: (l: RelationLine) => l.text,
                color: (l: RelationLine) => l.color,
              },
            ]}
            rows={relLines}
            empty="Ainda não há nada. Vá a Clientes e prima n."
            rowKey={(_l, i) => String(i)}
          />
        );
    }
  };

  const main = ((): React.ReactNode => {
    switch (mode.kind) {
      case 'form':
        return (
          <Form
            key={mode.id}
            title={mode.title}
            fields={mode.fields}
            submitLabel={mode.submitLabel}
            onSubmit={mode.onSubmit}
            onCancel={close}
          />
        );
      case 'confirm':
        return (
          <Confirm
            title={mode.title}
            lines={mode.lines}
            confirmLabel={mode.confirmLabel}
            danger={mode.danger}
            onConfirm={() => void mode.onConfirm()}
            onCancel={close}
          />
        );
      case 'reveal':
        return (
          <RevealKey
            keyText={mode.created.key}
            prefix={mode.created.keyPrefix}
            org={mode.org}
            expiresAt={mode.created.expiresAt}
            onClose={() => {
              close();
              notify(`Chave ${mode.created.keyPrefix} criada.`);
            }}
          />
        );
      case 'help':
        return <Help onClose={close} />;
      case 'browse':
        return body();
    }
  })();

  return (
    <Box flexDirection="column" width={cols}>
      <Text>
        <Text bold>IRIS Hub · administração</Text>
        <Text dimColor>
          {data === undefined ? '  a carregar…' : loadError !== undefined ? `  ✗ ${loadError}` : ''}
        </Text>
      </Text>
      <Text>
        {TABS.map((t, i) => (
          <Text key={t.id} inverse={i === tab} bold={i === tab}>
            {` ${String(i + 1)} ${t.label} `}
          </Text>
        ))}
      </Text>
      <Text dimColor>{'─'.repeat(Math.max(10, cols))}</Text>
      <Box flexDirection="column" height={tableHeight + 1}>
        {main}
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, cols))}</Text>
      <Text>{mode.kind === 'browse' ? detail : ''}</Text>
      <Text {...colorProps(notice === undefined ? undefined : notice.error ? 'red' : 'green')}>
        {notice === undefined ? ' ' : `${notice.error ? '✗' : '✓'} ${notice.text}`}
      </Text>
      <Text dimColor>{mode.kind === 'browse' ? `${HINTS[tabId]} · ? ajuda · q sair` : ' '}</Text>
    </Box>
  );
}
