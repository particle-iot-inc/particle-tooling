import { defineConfig } from 'oxlint';

import base from './oxlint.js';

/**
 * Typed rules that the enabled categories include. They only run in type-aware mode, so turning that mode on
 * would start enforcing all of them at once. They stay off until one is chosen deliberately.
 */
const UNADOPTED_TYPED_RULES = {
	'typescript/consistent-return': 'off',
	'typescript/no-array-delete': 'off',
	'typescript/no-duplicate-type-constituents': 'off',
	'typescript/no-for-in-array': 'off',
	'typescript/no-generated-empty-object-type': 'off',
	'typescript/no-implied-eval': 'off',
	'typescript/no-meaningless-void-operator': 'off',
	'typescript/no-misused-spread': 'off',
	'typescript/no-redundant-type-constituents': 'off',
	'typescript/no-unnecessary-boolean-literal-compare': 'off',
	'typescript/no-unnecessary-template-expression': 'off',
	'typescript/no-unnecessary-type-arguments': 'off',
	'typescript/no-unnecessary-type-conversion': 'off',
	'typescript/no-unnecessary-type-parameters': 'off',
	'typescript/no-unsafe-enum-assignment': 'off',
	'typescript/no-unsafe-enum-comparison': 'off',
	'typescript/no-unsafe-type-assertion': 'off',
	'typescript/no-unsafe-unary-minus': 'off',
	'typescript/no-useless-default-assignment': 'off',
	'typescript/require-array-sort-compare': 'off',
	'typescript/restrict-template-expressions': 'off',
	'typescript/unbound-method': 'off'
};

export default defineConfig({
	...base,
	// Type-aware rules need the oxlint-tsgolint package.
	options: { typeAware: true },
	rules: {
		...base.rules,
		...UNADOPTED_TYPED_RULES,
		'typescript/await-thenable': 'error',
		'typescript/ban-ts-comment': 'error',
		'typescript/no-array-constructor': 'error',
		'typescript/no-base-to-string': 'error',
		'typescript/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
		'typescript/no-floating-promises': ['error', { ignoreVoid: true }],
		'typescript/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, inheritedMethods: false } }],
		'typescript/no-namespace': 'error',
		'typescript/no-require-imports': 'error',
		'typescript/no-unnecessary-type-assertion': 'warn',
		'typescript/no-unsafe-function-type': 'error'
	}
});
