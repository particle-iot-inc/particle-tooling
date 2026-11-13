import { defineConfig } from 'oxlint';

const TEST_FILES = ['**/*.{spec,test,e2e,unit,integration}.{mjs,cjs,js,ts}', '**/test/**/*.{mjs,cjs,js,ts}'];

export default defineConfig({
	plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'promise', 'node', 'vitest'],
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		perf: 'warn'
	},
	rules: {
		curly: 'error',
		eqeqeq: ['error', 'smart'],
		'func-names': ['error', 'as-needed'],
		'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
		'no-console': 'error',
		'no-nested-ternary': 'error',
		'no-undef': 'error',
		'no-underscore-dangle': 'off',
		'no-unused-vars': [
			'error',
			{
				vars: 'all',
				varsIgnorePattern: '^_',
				args: 'after-used',
				argsIgnorePattern: '^_',
				caughtErrors: 'all',
				caughtErrorsIgnorePattern: '^_'
			}
		],
		'no-var': 'error',
		'node/handle-callback-err': 'error',
		'prefer-const': ['error', { destructuring: 'all' }],
		'typescript/no-explicit-any': 'off',
		'typescript/no-non-null-asserted-optional-chain': 'error',
		'vitest/require-mock-type-parameters': 'off'
	},
	overrides: [
		{
			// A top-level `env` is dropped when a project extends this config. Overrides are kept.
			files: ['**/*'],
			env: { node: true }
		},
		{
			files: ['**/scripts/**', '**/examples/**'],
			rules: {
				'no-console': 'off'
			}
		},
		{
			files: TEST_FILES,
			env: { vitest: true },
			rules: {
				'func-names': 'off'
			}
		}
	]
});
