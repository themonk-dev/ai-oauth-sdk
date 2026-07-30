import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Deliberately narrow. TypeScript already catches what a type checker catches,
 * so this only enforces the things it cannot see — chiefly that every control
 * statement has a block, which is what keeps a later edit from silently landing
 * outside the branch it was meant for.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'examples/**/dist/**'] },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-else-return': ['error', { allowElseIf: true }],
    },
  },
  {
    files: ['packages/react/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
)
