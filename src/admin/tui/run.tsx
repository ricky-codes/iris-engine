import { render } from 'ink';
import type { AdminApi } from '../api.js';
import { App } from './App.js';

/** Abre a interface e só devolve quando o utilizador sai. Precisa de um terminal interativo. */
export async function runTui(api: AdminApi): Promise<void> {
  const app = render(<App api={api} />, { alternateScreen: true });
  await app.waitUntilExit();
}
