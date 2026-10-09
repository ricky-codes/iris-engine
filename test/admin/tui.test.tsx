import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/admin/tui/App.js';
import { FAKE_KEY, createFakeApi, keyRow, orgRow, tenantRow, userRow } from './fake-api.js';

const ENTER = '\r';
const TAB = '\t';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';

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
  tenants: [tenantRow('pingo-doce', { orgCount: 2 }), tenantRow('banco-x')],
  orgs: [
    orgRow(ORG_A, 'pingo-doce', { userCount: 1 }),
    orgRow(ORG_B, 'pingo-doce', { isSandbox: true }),
  ],
  users: [userRow(USER_A, ORG_A, 'pingo-doce', { requestCount: 3, memoryCount: 1 })],
  keys: [
    keyRow('11111111', ORG_A, 'pingo-doce'),
    keyRow('22222222', ORG_A, 'pingo-doce', 'revogada'),
  ],
};

describe('interface de terminal', () => {
  describe('ver', () => {
    it('sem dados, explica como começar', async () => {
      const ui = await open();
      expect(ui.frame()).toContain('IRIS Hub · administração');
      expect(ui.frame()).toContain('Relações');
      expect(ui.frame()).toContain('Ainda não há nada');
    });

    it('a vista de relações mostra a árvore completa', async () => {
      const ui = await open(seeded);
      const f = ui.frame();
      expect(f).toContain('pingo-doce');
      expect(f).toContain(`org ${ORG_A}`);
      expect(f).toContain(`org ${ORG_B}`);
      expect(f).toContain(USER_A);
      expect(f).toContain('11111111');
      expect(f).toContain('revogada');
    });

    it('os números mudam de separador e cada um mostra os seus dados', async () => {
      const ui = await open(seeded);

      await ui.press('2');
      expect(ui.frame()).toMatch(/Cliente\s+Nome\s+Estado\s+Orgs\s+Retenção/);
      expect(ui.frame()).toContain('banco-x');
      expect(ui.frame()).toContain('30 dias');

      await ui.press('3');
      expect(ui.frame()).toMatch(/Cliente\s+Org\s+Tipo\s+Estado/);
      expect(ui.frame()).toContain('sandbox');
      expect(ui.frame()).toContain('produção');

      await ui.press('4');
      expect(ui.frame()).toMatch(/Utilizador\s+Desde\s+Pedidos/);
      expect(ui.frame()).toContain(USER_A);

      await ui.press('5');
      expect(ui.frame()).toMatch(/Prefixo\s+Estado\s+Criada/);
      expect(ui.frame()).toContain('11111111');
      expect(ui.frame()).toContain('22222222');
    });

    it('as setas e o Tab percorrem os separadores', async () => {
      const ui = await open(seeded);
      await ui.press(RIGHT);
      expect(ui.frame()).toMatch(/Nome\s+Estado/);
      await ui.press(TAB);
      expect(ui.frame()).toMatch(/Tipo\s+Estado/);
      await ui.press('\u001B[D', '\u001B[D');
      expect(ui.frame()).toContain('pingo-doce');
      expect(ui.frame()).toContain(`org ${ORG_A}`);
    });

    it('a seleção desce e a linha de detalhe acompanha', async () => {
      const ui = await open(seeded);
      await ui.press('3');
      expect(ui.frame()).toContain(`https://${ORG_A.toLowerCase()}.my.salesforce.com`);
      await ui.press(DOWN);
      const lines = ui.frame().split('\n');
      const detail = lines.find((l) => l.trim().startsWith('https://'));
      expect(detail?.trim()).toBe(`https://${ORG_B.toLowerCase()}.my.salesforce.com`);
    });

    it('a ajuda lista os atalhos e qualquer tecla a fecha', async () => {
      const ui = await open(seeded);
      await ui.press('?');
      expect(ui.frame()).toContain('Atalhos');
      expect(ui.frame()).toContain('revogar');
      await ui.press('x');
      expect(ui.frame()).not.toContain('Atalhos');
    });

    it('nunca mostra um segredo de chave', async () => {
      const ui = await open(seeded);
      await ui.press('5');
      expect(ui.frame()).not.toMatch(/iris_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/);
    });
  });

  describe('criar', () => {
    it('cria um cliente preenchendo o formulário', async () => {
      const ui = await open();
      await ui.press('2', 'n');
      expect(ui.frame()).toContain('Novo cliente');

      await ui.press('novo-cliente', ENTER, 'Novo Cliente', ENTER, '45', ENTER);

      expect(ui.calls).toEqual([
        'createTenant {"slug":"novo-cliente","name":"Novo Cliente","retentionDays":45}',
      ]);
      expect(ui.frame()).toContain('Cliente "novo-cliente" criado.');
      expect(ui.frame()).toContain('Nome');
      expect(ui.frame()).not.toContain('Novo cliente\n');
    });

    it('a retenção é opcional', async () => {
      const ui = await open();
      await ui.press('2', 'n', 'x-y', ENTER, 'Nome', ENTER, ENTER);
      expect(ui.calls).toEqual(['createTenant {"slug":"x-y","name":"Nome"}']);
    });

    it('mostra o erro e não chama a API quando o identificador é inválido', async () => {
      const ui = await open();
      await ui.press('2', 'n', 'Pingo Doce', ENTER);
      expect(ui.frame()).toContain('minúsculas');
      await ui.press(ENTER, ENTER);
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).toContain('Novo cliente');
    });

    it('campos obrigatórios em branco impedem a gravação', async () => {
      const ui = await open();
      await ui.press('2', 'n', '\u0013');
      expect(ui.frame()).toContain('Obrigatório.');
      expect(ui.calls).toEqual([]);
    });

    it('o backspace apaga e o texto pode ser corrigido', async () => {
      const ui = await open();
      await ui.press('2', 'n', 'abcx', '\u007F', 'd', ENTER, 'N', ENTER, ENTER);
      expect(ui.calls).toEqual(['createTenant {"slug":"abcd","name":"N"}']);
    });

    it('um erro da API aparece no formulário, que fica aberto para corrigir', async () => {
      const ui = await open();
      ui.control.failNext = 'Já existe o cliente "dup".';
      await ui.press('2', 'n', 'dup', ENTER, 'Dup', ENTER, ENTER);
      expect(ui.frame()).toContain('Já existe o cliente "dup".');
      expect(ui.frame()).toContain('Novo cliente');

      await ui.press('\u0013');
      expect(ui.calls).toHaveLength(2);
      expect(ui.frame()).toContain('Cliente "dup" criado.');
    });

    it('Esc cancela sem criar nada', async () => {
      const ui = await open();
      await ui.press('2', 'n', 'abc');
      await ui.press('\u001B');
      await tick(150);
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).not.toContain('Novo cliente');
    });

    it('cria uma org no cliente seleccionado (atalho o)', async () => {
      const ui = await open({ tenants: [tenantRow('a'), tenantRow('b')] });
      await ui.press('2', DOWN, 'o');
      expect(ui.frame()).toContain('Nova org');
      expect(ui.frame()).toContain('b (Cliente b)');

      await ui.press(ENTER, ORG_A, ENTER, 'https://x.my.salesforce.com', ENTER, ' ', ENTER);
      expect(ui.calls).toEqual([
        `createOrg {"tenantSlug":"b","sfOrgRef":"${ORG_A}","instanceUrl":"https://x.my.salesforce.com","isSandbox":true}`,
      ]);
    });

    it('valida o id da org e o URL', async () => {
      const ui = await open({ tenants: [tenantRow('a')] });
      await ui.press('3', 'n', ENTER, 'abc', ENTER);
      expect(ui.frame()).toContain('00D');
      await ui.press('http://x.com', ENTER);
      expect(ui.frame()).toContain('https');
      expect(ui.calls).toEqual([]);
    });

    it('cria um utilizador numa org (atalho u)', async () => {
      const ui = await open(seeded);
      await ui.press('3', DOWN, 'u');
      expect(ui.frame()).toContain('Novo utilizador');
      await ui.press(ENTER, '005BBBBBBBBBBBBBBB', ENTER);
      expect(ui.calls).toEqual([
        `createOrgUser {"sfOrgRef":"${ORG_B}","sfUserRef":"005BBBBBBBBBBBBBBB"}`,
      ]);
      await ui.press('4');
      expect(ui.frame()).toContain('005BBBBBBBBBBBBBBB');
    });

    it('sem orgs, o formulário avisa que não há opções', async () => {
      const ui = await open({ tenants: [tenantRow('a')] });
      await ui.press('4', 'n');
      expect(ui.frame()).toContain('sem opções');
      await ui.press('\u0013');
      expect(ui.frame()).toContain('Não há opções disponíveis.');
      expect(ui.calls).toEqual([]);
    });

    it('cria uma chave e mostra-a uma única vez', async () => {
      const ui = await open(seeded);
      await ui.press('3', 'k');
      expect(ui.frame()).toContain('Nova chave de API');
      await ui.press(ENTER, '30', ENTER);

      expect(ui.calls).toEqual([`createApiKey {"sfOrgRef":"${ORG_A}","expiresInDays":30}`]);
      expect(ui.frame()).toContain(FAKE_KEY);
      expect(ui.frame()).toContain('Guarde-a agora');

      await ui.press(ENTER);
      expect(ui.frame()).not.toContain(FAKE_KEY);
      expect(ui.frame()).toContain('Chave deadbeef criada.');

      await ui.press('5');
      expect(ui.frame()).not.toContain(FAKE_KEY);
      expect(ui.frame()).toContain('deadbeef');
    });
  });

  describe('alterar e apagar', () => {
    it('revoga uma chave depois de confirmar', async () => {
      const ui = await open(seeded);
      await ui.press('5', 'r');
      expect(ui.frame()).toContain('Revogar a chave 11111111?');
      await ui.press('s');
      expect(ui.calls).toEqual(['revokeApiKey 11111111']);
      expect(ui.frame()).toContain('Chave 11111111 revogada.');
    });

    it('cancelar a revogação não faz nada', async () => {
      const ui = await open(seeded);
      await ui.press('5', 'r', 'n');
      expect(ui.calls).toEqual([]);
      expect(ui.frame()).not.toContain('Revogar a chave');
    });

    it('não deixa revogar uma chave que já está revogada', async () => {
      const ui = await open(seeded);
      await ui.press('5', DOWN, 'r');
      expect(ui.frame()).toContain('já está revogada');
      expect(ui.calls).toEqual([]);
    });

    it('desativa um cliente a pedir confirmação, e reativa-o sem perguntar', async () => {
      const ui = await open({ tenants: [tenantRow('a', { orgCount: 2 })] });
      await ui.press('2', 'a');
      expect(ui.frame()).toContain('Desativar o cliente "a"?');
      expect(ui.frame()).toContain('2 orgs');
      await ui.press('s');
      expect(ui.calls).toEqual(['setTenantActive a false']);
      expect(ui.frame()).toContain('inativo');

      await ui.press('a');
      expect(ui.calls).toEqual(['setTenantActive a false', 'setTenantActive a true']);
      expect(ui.frame()).toContain('ativo');
    });

    it('desativa uma org', async () => {
      const ui = await open(seeded);
      await ui.press('3', 'a', 's');
      expect(ui.calls).toEqual([`setOrgActive ${ORG_A} false`]);
    });

    it('antes de apagar um utilizador, mostra tudo o que desaparece com ele', async () => {
      const ui = await open(seeded);
      await ui.press('4', 'd');
      expect(ui.frame()).toContain(`Apagar o utilizador ${USER_A}?`);
      expect(ui.frame()).toContain('3 pedidos');
      expect(ui.frame()).toContain('1 memória');
      expect(ui.calls).toEqual([]);

      await ui.press('s');
      expect(ui.calls).toEqual([`deleteOrgUser user-${USER_A}`]);
      expect(ui.frame()).toContain(`Utilizador ${USER_A} apagado.`);
      expect(ui.frame()).toContain('Sem utilizadores');
    });

    it('um erro ao agir aparece como aviso e a interface continua utilizável', async () => {
      const ui = await open(seeded);
      ui.control.failNext = 'A base de dados recusou.';
      await ui.press('5', 'r', 's');
      expect(ui.frame()).toContain('A base de dados recusou.');
      await ui.press('2');
      expect(ui.frame()).toContain('banco-x');
    });
  });

  it('R recarrega os dados vindos de fora', async () => {
    const ui = await open();
    ui.state.tenants.push(tenantRow('apareceu-depois'));
    await ui.press('2');
    expect(ui.frame()).not.toContain('apareceu-depois');
    await ui.press('R');
    await tick(60);
    expect(ui.frame()).toContain('apareceu-depois');
  });
});
