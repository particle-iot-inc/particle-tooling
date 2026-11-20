import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = promisify(execFileCallback);
const shared = path.resolve(import.meta.dirname, '../vitest.js');
const vitest = path.resolve(import.meta.dirname, '../node_modules/vitest/vitest.mjs');

/**
 * @param {string | undefined} circleci the value of CIRCLECI, or undefined to leave it unset
 * @returns {Promise<any>} the shared config as loaded in that environment
 */
async function load(circleci) {
	vi.stubEnv('CIRCLECI', circleci);
	vi.resetModules();
	return (await import('../vitest.js')).default;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('the shared Vitest config', () => {
	it('adds the JUnit reporter next to the default one in CircleCI', async () => {
		expect(await load('true')).toEqual({
			test: {
				reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml', addFileAttribute: true }]]
			}
		});
	});

	it('sets nothing outside CircleCI', async () => {
		expect(await load(undefined)).toEqual({});
	});

	describe('merged into a project config and run', () => {
		/** @type {string} */
		let dir;

		afterEach(async () => {
			await rm(dir, { recursive: true });
		});

		it('writes test-results/junit.xml with file attributes and test output in CircleCI only', async () => {
			dir = await mkdtemp(path.join(tmpdir(), 'particle-tooling-vitest-'));
			await writeFile(
				path.join(dir, 'vitest.config.mjs'),
				`export { default } from ${JSON.stringify(pathToFileURL(shared).href)};\n`
			);
			await writeFile(
				path.join(dir, 'example.test.js'),
				"it('logs', () => { console.log('hello from the test'); expect(1).toBe(1); });\n"
			);
			const { CIRCLECI: _, ...env } = process.env;
			/** @param {Record<string, string>} extra */
			const run = (extra) =>
				execFile(process.execPath, [vitest, 'run', '--root', dir, '--globals'], {
					cwd: dir,
					env: { ...env, ...extra }
				});

			await run({});
			expect(existsSync(path.join(dir, 'test-results'))).toBe(false);

			const { stdout } = await run({ CIRCLECI: 'true' });
			expect(stdout).toContain('1 passed');
			const xml = await readFile(path.join(dir, 'test-results/junit.xml'), 'utf8');
			expect(xml).toMatch(/<testcase classname="example\.test\.js" file="example\.test\.js" name="logs"/);
			expect(xml).toContain('<system-out>');
			expect(xml).toContain('hello from the test');
		});
	});
});
