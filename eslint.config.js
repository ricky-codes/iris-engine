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
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
