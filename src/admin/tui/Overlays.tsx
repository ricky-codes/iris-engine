import { Box, Text, useInput } from 'ink';

interface ConfirmProps {
  title: string;
  lines: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Pergunta de confirmação: `s` confirma, `n` ou Esc cancela. */
export function Confirm({ title, lines, confirmLabel, danger, onConfirm, onCancel }: ConfirmProps) {
  useInput((input, key) => {
    if (input === 's' || input === 'S') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box
      flexDirection="column"
      gap={1}
      borderStyle="round"
      borderColor={danger === true ? 'red' : 'yellow'}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={danger === true ? 'red' : 'yellow'}>
        {title}
      </Text>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Text>
        <Text bold>s</Text> {confirmLabel} · <Text bold>n</Text> cancela
      </Text>
    </Box>
  );
}

const SHORTCUTS: [string, string][] = [
  ['← → · Tab · 1-2', 'mudar de separador'],
  ['↑ ↓ · PgUp PgDn', 'mover a seleção'],
  ['n', 'nova memória da org (regra da empresa)'],
  ['d', 'apagar a memória selecionada'],
  ['R', 'recarregar os dados'],
  ['q · Ctrl+C', 'sair'],
];

export function Help({ onClose }: { onClose: () => void }) {
  useInput(() => {
    onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2}>
      <Text bold>Atalhos</Text>
      <Box flexDirection="column">
        {SHORTCUTS.map(([keys, what]) => (
          <Text key={keys}>
            <Text bold color="cyan">
              {keys.padEnd(18)}
            </Text>
            {what}
          </Text>
        ))}
      </Box>
      <Text dimColor>Qualquer tecla fecha.</Text>
    </Box>
  );
}
