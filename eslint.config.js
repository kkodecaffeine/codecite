import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.codecite/'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // 한 줄 if 에도 중괄호를 쓴다
      curly: ['error', 'all'],
    },
  },
]);
