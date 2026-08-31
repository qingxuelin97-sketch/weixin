/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist', 'android', 'ios', 'node_modules', '*.config.ts', 'scripts/*.mjs'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // Design tokens are enforced separately by scripts/check-no-hardcoded-colors.mjs.
  },

  // 宪法 §1 依赖方向，机器强制（M-J0）。之前只是文档句子："禁止反向依赖（如 lib 不得
  // import features）"——文档挡不住一次顺手的 import。这里把四条已知会被顺手写出来的
  // 反向锁死；tests/unit/dep-direction.test.ts 守着这份配置本身不被删。
  //
  // `allowTypeImports: true`：依赖方向守的是**运行时**耦合（打包体积、层次可复用性、
  // 环引用）。type-only import 编译即擦除，不产生任何运行时边——lib/nsfw-tier.ts 从
  // llm/router 借 `NsfwTier` 类型即属此类，合法。
  overrides: [
    {
      files: ['src/lib/**/*'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/features/**', '**/store/**', '**/ai/**', '**/llm/**'],
            allowTypeImports: true,
            message: '宪法 §1：lib 是最底层纯函数，不得 import features/store/ai/llm（type-only 除外）。',
          }],
        }],
      },
    },
    {
      files: ['src/ai/**/*'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/features/**', '**/store/**'],
            allowTypeImports: true,
            message: '宪法 §1：ai 只依赖 llm/lib，不得 import features/store（type-only 除外）。',
          }],
        }],
      },
    },
    {
      files: ['src/llm/**/*'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/ai/**', '**/features/**'],
            allowTypeImports: true,
            message: '宪法 §1：llm 只依赖 lib，不得 import ai/features（type-only 除外）。',
          }],
        }],
      },
    },
    {
      files: ['src/components/**/*'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          patterns: [{
            group: ['**/features/**'],
            allowTypeImports: true,
            message: '宪法 §1：components 是通用件，不得 import features（type-only 除外）。',
          }],
        }],
      },
    },
  ],
};
