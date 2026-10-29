import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Só config.ts lê variáveis de ambiente.
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Usar loadConfig() em src/config.ts.' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Plugins e handlers do Fastify são async por convenção, mesmo sem await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // O motor não conhece o servidor, os adaptadores, as ferramentas nem a configuração:
    // tudo isso lhe chega por interfaces, montado em src/server.ts.
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^\\.\\./(http|adapters|tools|admin|db|memory)/|^\\.\\./(config|app|server)\\.js$',
              message: 'O motor só importa de src/engine/. Passe a dependência por uma interface.',
            },
            {
              regex: '^(fastify|@fastify/|pg$)',
              message: 'O motor não depende do servidor HTTP nem do Postgres.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Nos testes, `rows[0]!` depois de um INSERT ... RETURNING é seguro, e o URL da
    // base de dados de teste vem do ambiente.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // Nos manipuladores de teclado, `return acao()` é o idioma para sair cedo.
    files: ['src/admin/tui/**/*.tsx'],
    rules: { '@typescript-eslint/no-confusing-void-expression': 'off' },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
