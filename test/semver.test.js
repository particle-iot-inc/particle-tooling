import { describe, expect, it } from 'vitest';

import { satisfies } from '../lib/semver.js';

describe('satisfies', () => {
	it.each([
		['7.0.2', '*', true],
		['7.0.2', '', true],
		['7.0.2', '>=4.8.4', true],
		['7.0.2', '>=4.8.4 <6.1.0', false],
		['6.0.3', '>=4.8.4 <6.1.0', true],
		['7.0.2', '5.0.x || 5.1.x || 5.9.x', false],
		['5.9.3', '5.0.x || 5.1.x || 5.9.x', true],
		['7.0.2', '^7.0.0', true],
		['7.0.2', '^7', true],
		['7.0.2', '^6.0.0', false],
		['7.0.2', '^7.1.0', false],
		['0.78.4', '~0.78.0', true],
		['0.79.0', '~0.78.0', false],
		['0.2.5', '^0.2.3', true],
		['0.3.0', '^0.2.3', false],
		['7.0.2', '>= 5', true],
		['7.0.2', '>7', false],
		['8.0.0', '>7', true],
		['7.0.2', '<=7', true],
		['7.0.2', '<7', false],
		['7.0.2', '7.0.2', true],
		['7.0.2', '=7.0.1', false],
		['7.0.2', '5.0.0 - 7.0.2', true],
		['7.0.2', '5.0.0 - 6.9.9', false],
		['7.0.2', '^6.0.0 || ^7.0.0', true]
	])('%s against "%s" is %s', (version, range, expected) => {
		expect(satisfies(version, range)).toBe(expected);
	});

	it('returns null for a range it does not understand', () => {
		expect(satisfies('7.0.2', 'workspace:*')).toBeNull();
		expect(satisfies('7.0.2', 'npm:other@^1.0.0')).toBeNull();
	});

	it('still matches when another alternative is not understood', () => {
		expect(satisfies('7.0.2', 'latest || ^7.0.0')).toBe(true);
	});
});
