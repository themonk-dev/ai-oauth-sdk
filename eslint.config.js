import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Deliberately narrow. TypeScript already catches what a type checker catches,
 * so this only enforces the things it cannot see: that every control statement
 * has a block, that branching is legible at a glance, and that prose about the
 * code lives in JSDoc where it is published rather than trailing a line.
 */
export default tseslint.config(
  // `docs/` is the documentation site. It is a separate project with its own
  // toolchain and its own lockfile, outside the pnpm workspace on purpose, so
  // the workspace gate does not reach into it.
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'examples/**/dist/**', 'docs/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-else-return': ['error', { allowElseIf: true }],
      'no-inline-comments': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try', 'return'] },
        { blankLine: 'always', prev: ['if', 'for', 'while', 'switch', 'try'], next: '*' },
      ],
    },
  },
  {
    files: ['packages/react/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
)
