import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/admin/tui/App.js';
import { createFakeApi, orgMemory, userMemory } from './fake-api.js';

const ENTER = '\r';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';
const ESC = '\u001B';

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = ReturnType<typeof render>;
let harness: Harness | undefined;
afterEach(() => {
  harness?.unmount();
  harness = undefined;
});

async function open(seed: Parameters<typeof createFakeApi>[0] = {}) {
  const fake = createFakeApi(seed);
  harness = render(<App api={fake.api} />);
  await tick(80);
  const h = harness;
  return {
    ...fake,
    frame: (): string => h.lastFrame() ?? '',
    /** Escreve cada pedaço como uma tecla e espera que a interface o processe. */
    press: async (...chunks: string[]): Promise<void> => {
      for (const chunk of chunks) {
        h.stdin.write(chunk);
        await tick();
      }
    },
  };
}

const ORG_A = '00DAAAAAAAAAAAAAAA';
const ORG_B = '00DBBBBBBBBBBBBBBB';
const USER_A = '005AAAAAAAAAAAAAAA';

const seeded = {
  memories: [
    orgMemory('m-1', ORG_A, 'Tratar sempre o cliente por você.'),
    orgMemory('m-2', ORG_B, 'Nunca prometer prazos.', { tools: ['reply'] }),
    userMemory('m-3', ORG_A, USER_A, 'Assinar com o meu nome.'),
  ],
};

describe('interface de terminal', () => {
  describe('ver', () => {
    it('sem dados, explica de onde vêm as memórias', async () => {
      const ui = await open();
      expect(ui.frame()).toContain('IRIS · memórias');
      expect(ui.frame()).toContain('Sem memórias da org');
      await ui.press('2');
      expect(ui.frame()).toContain('Nascem quando');
    });

    it('separa as memórias da org das dos utilizadores', async () => {
      const ui = await open(seeded);
      expect(ui.frame()).toContain('Memórias da org (2)');
      expect(ui.frame()).toContain('Memórias de utilizadores (1)');
      expect(ui.frame()).toContain('Tratar sempre o cliente por você.');
      expect(ui.frame()).toContain('Nunca prometer prazos.');
      expect(ui.frame()).not.toContain('Assinar com o meu nome.');

      await ui.press(RIGHT);
      expect(ui.frame()).toMatch(/Org\s+Utilizador\s+Ferramentas\s+Origem\s+Texto/);
      expect(ui.frame()).toContain(USER_A);
      expect(ui.frame()).toContain('Assinar com o meu nome.');
    });

    it('mostra a que ferramentas se aplica cada memória', async () => {
      const ui = await open(seeded);
      expect(ui.frame()).toContain('todas');
      await ui.press(DOWN);
      expect(ui.frame()).toMatch(/reply · admin/);
    });

    it('? mostra os atalhos e qualquer tecla fecha', async () => {
      const ui = await open();
      await ui.press('?');
      expect(ui.frame()).toContain('Atalhos');
      await ui.press('x');
      expect(ui.frame()).not.toContain('Atalhos');
    });
  });

  describe('criar', () => {
    it('cria uma memória da org, por omissão para todas as ferramentas', async () => {
      const ui = await open();
      await ui.press('n');
      expect(ui.frame()).toContain('Nova memória da org');
      await ui.press(ORG_A, ENTER, 'Tratar por você.', ENTER, ENTER);
      expect(ui.calls).toEqual([
        `createOrgMemory {"sfOrgRef":"${ORG_A}","content":"Tratar por você.","tools":[]}`,
      ]);
      expect(ui.frame()).toContain(`Memória da org ${ORG_A} criada.`);
      expect(ui.frame()).toContain('Memórias da org (1)');
    });

    it('pode limitar a memória a uma ferramenta', async () => {
      const ui = await open();
      await ui.press('n', ORG_A, ENTER, 'Curto.', ENTER, RIGHT, ENTER);
      expect(ui.calls).toEqual([
        `createOrgMemory {"sfOrgRef":"${ORG_A}","content":"Curto.","tools":["reply"]}`,
      ]);
    });

    it('a org da memória selecionada vem preenchida', async () => {
      const ui = await open(seeded);
      await ui.press(DOWN, 'n');
      expect(ui.frame()).toContain(ORG_B);
    });

    it('não grava com um id de org inválido', async () => {
      const ui = await open();
      await ui.press('n', '00Dxxx', ENTER, 'Texto', ENTER, ENTER);
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).toContain('18 caracteres');
    });

    it('um erro da API aparece no formulário, que fica aberto', async () => {
      const ui = await open();
      ui.control.failNext = `A org ${ORG_A} já tem 50 memórias. Apague uma antes de criar outra.`;
      await ui.press('n', ORG_A, ENTER, 'Mais uma.', ENTER, ENTER);
      expect(ui.frame()).toContain('já tem 50 memórias');
      expect(ui.frame()).toContain('Nova memória da org');
    });

    it('Esc cancela sem gravar', async () => {
      const ui = await open();
      await ui.press('n', ORG_A, ESC);
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).not.toContain('Nova memória da org');
    });
  });

  describe('apagar', () => {
    it('pede confirmação e apaga a memória de um utilizador', async () => {
      const ui = await open(seeded);
      await ui.press('2', 'd');
      expect(ui.frame()).toContain('Apagar esta memória?');
      expect(ui.frame()).toContain(`Utilizador ${USER_A}`);
      expect(ui.calls).toEqual([]);

      await ui.press('s');
      expect(ui.calls).toEqual(['deleteMemory m-3']);
      expect(ui.frame()).toContain('Memória apagada.');
      expect(ui.frame()).toContain('Memórias de utilizadores (0)');
    });

    it('n cancela', async () => {
      const ui = await open(seeded);
      await ui.press('d', 'n');
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).toContain('Memórias da org (2)');
    });
  });

  it('R recarrega os dados vindos de fora', async () => {
    const ui = await open();
    ui.state.memories.push(orgMemory('m-9', ORG_A, 'Criada noutro terminal.'));
    await ui.press('R');
    expect(ui.frame()).toContain('Criada noutro terminal.');
  });
});
