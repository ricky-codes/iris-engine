import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AdminApi } from '../api.js';
import type { AdminData, MemoryRow } from '../queries.js';
import { validateMemoryContent, validateOrgRef } from '../validation.js';
import { Form, type FieldDef, type FormValues } from './Form.js';
import { colorProps, fit, fmtDate } from './format.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Help } from './Overlays.js';
import { Table, type Column } from './Table.js';

const TABS = [
  { id: 'org', label: 'Memórias da org' },
  { id: 'user', label: 'Memórias de utilizadores' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const ALL_TOOLS = '*';

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
      onConfirm: () => Promise<void>;
    }
  | { kind: 'help' };

interface Notice {
  text: string;
  error: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);
const toolsLabel = (m: MemoryRow): string => (m.tools.length === 0 ? 'todas' : m.tools.join(', '));
const sourceLabel = (m: MemoryRow): string => (m.source === 'admin' ? 'admin' : 'utilizador');

const HINTS: Record<TabId, string> = {
  org: 'n nova memória da org · d apagar',
  user: 'n nova memória da org · d apagar',
};

export function App({ api }: { api: AdminApi }) {
  const { exit } = useApp();
  const { cols, rows: termRows } = useTerminalSize();

  const [data, setData] = useState<AdminData | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [tab, setTab] = useState(0);
  const [selection, setSelection] = useState<number[]>([0, 0]);
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

  const tabId: TabId = TABS[tab]?.id ?? 'org';
  const rowsOf = (id: TabId): MemoryRow[] => (data?.memories ?? []).filter((m) => m.scope === id);
  const rows = rowsOf(tabId);
  const selected = clamp(selection[tab] ?? 0, 0, Math.max(0, rows.length - 1));
  const current = rows[selected];

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

  const newOrgMemory = (orgRef?: string): void => {
    const toolOptions = [
      { value: ALL_TOOLS, label: 'todas' },
      ...(data?.tools ?? []).map((t) => ({ value: t.code, label: t.code })),
    ];
    setFormCounter((n) => n + 1);
    setMode({
      kind: 'form',
      id: formCounter + 1,
      title: 'Nova memória da org (regra da empresa)',
      fields: [
        {
          kind: 'text',
          name: 'org',
          label: 'Id da org',
          validate: validateOrgRef,
          hint: '18 caracteres, começa por 00D (o mesmo do StepAccess)',
          ...(orgRef !== undefined && { initial: orgRef }),
        },
        {
          kind: 'text',
          name: 'content',
          label: 'Texto',
          validate: validateMemoryContent,
          hint: 'ex.: tratar sempre o cliente por "você"',
        },
        { kind: 'select', name: 'tool', label: 'Ferramenta', options: toolOptions },
      ],
      submitLabel: 'criar',
      onSubmit: async (v) => {
        const tool = v['tool'] ?? ALL_TOOLS;
        await api.createOrgMemory({
          sfOrgRef: v['org'] ?? '',
          content: v['content'] ?? '',
          tools: tool === ALL_TOOLS ? [] : [tool],
        });
        await refresh();
        close();
        notify(`Memória da org ${v['org'] ?? ''} criada.`);
      },
    });
  };

  const deleteMemory = (m: MemoryRow): void => {
    const owner =
      m.scope === 'org'
        ? `Org ${m.sfOrgRef}.`
        : `Utilizador ${m.sfUserRef ?? ''} da org ${m.sfOrgRef}.`;
    setMode({
      kind: 'confirm',
      title: 'Apagar esta memória?',
      lines: [owner, `"${m.content}"`, 'Não se desfaz.'],
      confirmLabel: 'apaga',
      onConfirm: () => act(() => api.deleteMemory(m.memoryId), 'Memória apagada.'),
    });
  };

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
    if (/^[1-2]$/.test(input)) return setTab(Number(input) - 1);

    const move = (delta: number): void => {
      setSelection((s) =>
        s.map((v, i) => (i === tab ? clamp(selected + delta, 0, Math.max(0, rows.length - 1)) : v)),
      );
    };
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.pageUp) return move(-tableHeight);
    if (key.pageDown) return move(tableHeight);

    if (data === undefined) return;
    if (input === 'n') newOrgMemory(current?.sfOrgRef);
    else if (input === 'd' && current) deleteMemory(current);
  });

  const orgCols: Column<MemoryRow>[] = [
    { header: 'Org', width: 20, render: (m) => m.sfOrgRef },
    { header: 'Ferramentas', width: 14, render: toolsLabel },
    { header: 'Criada', width: 11, render: (m) => fmtDate(m.createdAt) },
    { header: 'Texto', render: (m) => m.content },
  ];
  const userCols: Column<MemoryRow>[] = [
    { header: 'Org', width: 20, render: (m) => m.sfOrgRef },
    { header: 'Utilizador', width: 20, render: (m) => m.sfUserRef ?? '' },
    { header: 'Ferramentas', width: 14, render: toolsLabel },
    { header: 'Origem', width: 10, render: sourceLabel },
    { header: 'Texto', render: (m) => m.content },
  ];

  const body = (): React.ReactNode => {
    if (loadError !== undefined && data === undefined) {
      return <Text color="red">Não foi possível carregar os dados: {loadError}</Text>;
    }
    if (data === undefined) return <Text dimColor>A carregar…</Text>;

    const common = {
      selected,
      height: tableHeight,
      width: cols,
      rowKey: (m: MemoryRow) => m.memoryId,
    };
    return tabId === 'org' ? (
      <Table
        {...common}
        columns={orgCols}
        rows={rows}
        empty="Sem memórias da org. Prima n para criar a primeira regra de uma org."
      />
    ) : (
      <Table
        {...common}
        columns={userCols}
        rows={rows}
        empty="Sem memórias de utilizadores. Nascem quando alguém pede à IRIS para se lembrar."
      />
    );
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
            danger
            onConfirm={() => void mode.onConfirm()}
            onCancel={close}
          />
        );
      case 'help':
        return <Help onClose={close} />;
      case 'browse':
        return body();
    }
  })();

  const detail =
    current === undefined
      ? ''
      : fit(
          `${toolsLabel(current)} · ${sourceLabel(current)} · ${fmtDate(current.updatedAt)} · ${current.content}`,
          cols,
        );

  return (
    <Box flexDirection="column" width={cols}>
      <Text>
        <Text bold>IRIS · memórias</Text>
        <Text dimColor>
          {data === undefined ? '  a carregar…' : loadError !== undefined ? `  ✗ ${loadError}` : ''}
        </Text>
      </Text>
      <Text>
        {TABS.map((t, i) => (
          <Text key={t.id} inverse={i === tab} bold={i === tab}>
            {` ${String(i + 1)} ${t.label} (${String(rowsOf(t.id).length)}) `}
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
