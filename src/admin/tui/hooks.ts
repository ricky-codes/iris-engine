import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  cols: number;
  rows: number;
}

function readSize(stdout: NodeJS.WriteStream): TerminalSize {
  return { cols: stdout.columns || 80, rows: stdout.rows || 24 };
}

/** Tamanho do terminal, atualizado quando a janela muda. */
export function useTerminalSize(): TerminalSize {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    const onResize = (): void => {
      setSize(readSize(stdout));
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
