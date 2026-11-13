import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const tsc = path.resolve(import.meta.dirname, '../node_modules/typescript/bin/tsc');
const fixtures = path.resolve(import.meta.dirname, 'fixtures');

/**
 * @param {string} project tsconfig path relative to the fixtures dir
 * @param {string[]} args extra tsc arguments
 * @returns {Promise<string>} tsc stdout
 */
async function runTsc(project, ...args) {
	const { stdout } = await execFile(process.execPath, [tsc, '-p', path.join(fixtures, project), ...args]);
	return stdout;
}

/**
 * @param {string} project tsconfig path relative to the fixtures dir
 * @returns {Promise<any>} the resolved config
 */
const showConfig = async (project) => JSON.parse(await runTsc(project, '--showConfig'));

/**
 * @param {string} project tsconfig path relative to the fixtures dir
 * @returns {Promise<string[]>} project files relative to the fixtures dir, without library files
 */
async function listFiles(project) {
	const stdout = await runTsc(project, '--listFilesOnly');
	return stdout
		.split('\n')
		.filter((file) => file.startsWith(fixtures))
		.map((file) => path.relative(fixtures, file))
		.toSorted();
}

describe('ts.json', () => {
	it('type checks src and test in the consuming repo without emitting', async () => {
		const { compilerOptions } = await showConfig('service/tsconfig.json');

		expect(compilerOptions).toMatchObject({ noEmit: true, strict: true, module: 'nodenext', target: 'es2024' });
		expect(await listFiles('service/tsconfig.json')).toEqual([
			'service/src/index.test.ts',
			'service/src/index.ts',
			'service/test/helper.ts'
		]);
		await expect(runTsc('service/tsconfig.json')).resolves.toBe('');
	});
});

describe('ts-build.json', () => {
	it('inherits ts.json and emits src to build in the consuming repo', async () => {
		const { compilerOptions } = await showConfig('service/tsconfig.build.json');

		expect(compilerOptions).toMatchObject({
			noEmit: false,
			strict: true,
			module: 'nodenext',
			outDir: './build',
			rootDir: './src'
		});
	});

	it('leaves tests out of the build', async () => {
		expect(await listFiles('service/tsconfig.build.json')).toEqual(['service/src/index.ts']);

		const outDir = await mkdtemp(path.join(tmpdir(), 'particle-tooling-'));
		try {
			await runTsc('service/tsconfig.build.json', '--outDir', outDir);

			expect(existsSync(path.join(outDir, 'index.js'))).toBe(true);
			expect(existsSync(path.join(outDir, 'index.js.map'))).toBe(true);
			expect(existsSync(path.join(outDir, 'index.test.js'))).toBe(false);
		} finally {
			await rm(outDir, { recursive: true });
		}
	});
});

describe('ts-build-library.json', () => {
	it('adds declarations and declaration maps to the build', async () => {
		const { compilerOptions } = await showConfig('library/tsconfig.build.json');

		expect(compilerOptions).toMatchObject({
			noEmit: false,
			declaration: true,
			declarationMap: true,
			outDir: './build',
			rootDir: './src'
		});
		expect(await listFiles('library/tsconfig.build.json')).toEqual(['library/src/index.ts']);

		const outDir = await mkdtemp(path.join(tmpdir(), 'particle-tooling-'));
		try {
			await runTsc('library/tsconfig.build.json', '--outDir', outDir);

			expect(existsSync(path.join(outDir, 'index.d.ts'))).toBe(true);
			expect(existsSync(path.join(outDir, 'index.d.ts.map'))).toBe(true);
		} finally {
			await rm(outDir, { recursive: true });
		}
	});
});

describe('js.json', () => {
	it('loads JavaScript without type checking it', async () => {
		const { compilerOptions } = await showConfig('javascript/tsconfig.json');

		expect(compilerOptions).toMatchObject({ allowJs: true, checkJs: false, noEmit: true });
		expect(await listFiles('javascript/tsconfig.json')).toEqual(['javascript/src/index.js']);
		await expect(runTsc('javascript/tsconfig.json')).resolves.toBe('');
	});
});
