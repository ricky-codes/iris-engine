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

interface RevealKeyProps {
  keyText: string;
  prefix: string;
  org: string;
  expiresAt: Date | null;
  onClose: () => void;
}

/** Mostra a chave criada. É a única vez que existe em claro. */
export function RevealKey({ keyText, prefix, org, expiresAt, onClose }: RevealKeyProps) {
  useInput((_input, key) => {
    if (key.return || key.escape) onClose();
  });

  return (
    <Box
      flexDirection="column"
      gap={1}
      borderStyle="double"
      borderColor="green"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="green">
        Chave criada para {org} (prefixo {prefix})
      </Text>
      <Text color="yellow">Guarde-a agora. Não volta a ser mostrada.</Text>
      <Text bold>{keyText}</Text>
      <Text dimColor>
        {expiresAt === null ? 'Não expira.' : `Expira em ${expiresAt.toISOString().slice(0, 10)}.`}{' '}
        No Salesforce: Authorization: Bearer &lt;chave&gt;
      </Text>
      <Text>
        <Text bold>Enter</Text> fecha (confirme que a guardou)
      </Text>
    </Box>
  );
}

const SHORTCUTS: [string, string][] = [
  ['← → · Tab · 1-5', 'mudar de separador'],
  ['↑ ↓ · PgUp PgDn', 'mover a seleção'],
  ['n', 'novo (cliente, org, utilizador ou chave, conforme o separador)'],
  ['o', 'Clientes: nova org neste cliente'],
  ['u · k', 'Orgs: novo utilizador · nova chave nesta org'],
  ['a', 'Clientes e Orgs: ativar / desativar'],
  ['r', 'Chaves: revogar'],
  ['d', 'Utilizadores: apagar (com todos os dados dele)'],
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
