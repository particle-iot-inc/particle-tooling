import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPlan, createPlan, detectStyle, formatPlan, hasChanges } from '../lib/migrate.js';
import toolingPackage from '../package.json' with { type: 'json' };

const execFile = promisify(execFileCallback);
/** The migration writes this package's own version into the project. */
const TOOLING_SPEC = `^${toolingPackage.version}`;
const bin = path.resolve(import.meta.dirname, '../bin/init.js');

const SERVICE_TSCONFIG = `{
  "compilerOptions": {
    "noEmit": true,
    "target": "ES2024",
    "lib": ["ES2024", "ESNext.Collection"],
    "module": "CommonJS",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    // comments and trailing commas are allowed in tsconfig files
    "sourceMap": true,
    "types": ["vitest/globals"],
  },
  "include": ["src/**/*", "test/**/*"]
}
`;

/**
 * @param {number} code ANSI color code
 * @returns {(line: string) => string} wraps a line in that color
 */
const ansi = (code) => (line) => `\u001B[${code}m${line}\u001B[39m`;
const red = ansi(31);
const green = ansi(32);
const yellow = ansi(33);

/** @type {string} */
let dir;

/**
 * @param {string} file path relative to the temp dir
 * @returns {Promise<string>}
 */
const read = (file) => readFile(path.join(dir, file), 'utf8');

/**
 * @param {string} file path relative to the temp dir
 * @returns {Promise<any>}
 */
const readJson = async (file) => JSON.parse(await read(file));

/**
 * @returns {Promise<{ args: string[], devDependencies: string[] }[]>} each npm call, with the devDependencies package.json listed at that moment
 */
async function npmCalls() {
	const log = await read('npm-calls.log');
	return log
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
}

/**
 * @param {Record<string, string | object>} files contents by path relative to the temp dir. Objects are written as JSON.
 * @returns {Promise<void>}
 */
async function writeFiles(files) {
	for (const [file, contents] of Object.entries(files)) {
		// oxlint-disable-next-line no-await-in-loop
		await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		// oxlint-disable-next-line no-await-in-loop
		await writeFile(
			path.join(dir, file),
			typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`
		);
	}
}

/**
 * @param {string} style
 * @returns {Promise<import('../lib/migrate.js').Plan>} the plan, after applying it
 */
async function migrate(style) {
	const plan = await createPlan(dir, style);
	await applyPlan(dir, plan);
	return plan;
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'particle-tooling-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true });
});

describe('a new project', () => {
	it('gets lint, format and JavaScript configs', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		const plan = await migrate('js');

		expect(plan.files).toEqual([
			'create oxlint.config.mts',
			'create oxfmt.config.mts',
			'create tsconfig.json',
			'add .claude/ and CLAUDE.md to .gitignore'
		]);
		expect(await read('.gitignore')).toBe('.claude/\nCLAUDE.md\n');
		expect(await read('oxlint.config.mts')).toBe("export { default } from '@particle/tooling/oxlint';\n");
		expect(await read('oxfmt.config.mts')).toBe("export { default } from '@particle/tooling/oxfmt';\n");
		expect(await readJson('tsconfig.json')).toEqual({ extends: '@particle/tooling/tsconfig/js.json' });
		const pkg = await readJson('package.json');
		expect(pkg.scripts).toEqual({ fmt: 'oxfmt' });
		expect(pkg.devDependencies).toEqual({ '@particle/tooling': TOOLING_SPEC });
	});

	it('gets TypeScript 7, both tsconfigs and a build script as a service', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({ extends: '@particle/tooling/tsconfig/ts.json' });
		expect(await readJson('tsconfig.build.json')).toEqual({ extends: '@particle/tooling/tsconfig/ts-build.json' });
		expect(await read('.gitignore')).toBe('build/\n.claude/\nCLAUDE.md\n');
		const pkg = await readJson('package.json');
		expect(pkg.devDependencies).toEqual({
			'@particle/tooling': TOOLING_SPEC,
			typescript: '^7.0.2'
		});
		expect(await read('oxlint.config.mts')).toBe("export { default } from '@particle/tooling/oxlint-typescript';\n");
		expect(pkg.scripts).toEqual({
			fmt: 'oxfmt',
			check: 'tsc && oxlint --deny-warnings && oxfmt --check',
			build: 'rm -rf build/ && tsc -p tsconfig.build.json'
		});
	});

	it('gets the declaration build as a library', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		await migrate('ts-library');

		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build-library.json'
		});
	});
});

describe('an ESLint project', () => {
	beforeEach(async () => {
		await writeFiles({
			'package.json': {
				name: 'consumer',
				scripts: { check: 'tsc && eslint && npm run other', lint: 'eslint --quiet -f unix .', other: 'true' },
				dependencies: { zod: '^4.0.0' },
				devDependencies: {
					eslint: '^9.39.4',
					'eslint-config-particle': '^3.0.6',
					typescript: '^6.0.2',
					vitest: '^4.1.2'
				}
			},
			'eslint.config.mjs': 'export default [];\n',
			'.oxlintrc.json': '{}\n',
			'.oxfmtrc.json': '{}\n'
		});
	});

	it('swaps ESLint for the shared package and moves TypeScript to 7', async () => {
		const plan = await migrate('ts-service');

		expect(plan.dependencies).toEqual([
			'remove eslint, eslint-config-particle',
			'typescript ^6.0.2 -> ^7.0.2',
			`add @particle/tooling ${TOOLING_SPEC} (installs oxlint, oxfmt and oxlint-tsgolint as peer dependencies)`
		]);
		const pkg = await readJson('package.json');
		expect(pkg.devDependencies).toEqual({
			'@particle/tooling': TOOLING_SPEC,
			typescript: '^7.0.2',
			vitest: '^4.1.2'
		});
		expect(pkg.dependencies).toEqual({ zod: '^4.0.0' });
		expect(plan.uninstall).toEqual(['eslint', 'eslint-config-particle']);
	});

	it('deletes the old lint and format configs and says which cannot be restored', async () => {
		const plan = await migrate('ts-service');

		expect(plan.files).toEqual(
			expect.arrayContaining([
				'delete eslint.config.mjs (not tracked by git, so it cannot be restored)',
				'delete .oxlintrc.json (not tracked by git, so it cannot be restored)',
				'delete .oxfmtrc.json (not tracked by git, so it cannot be restored)'
			])
		);
		expect(existsSync(path.join(dir, 'eslint.config.mjs'))).toBe(false);
		expect(existsSync(path.join(dir, '.oxlintrc.json'))).toBe(false);
		expect(existsSync(path.join(dir, '.oxfmtrc.json'))).toBe(false);
		expect(plan.attention).toContainEqual(
			expect.stringContaining(
				'eslint.config.mjs, .oxlintrc.json: project-specific rules and ignores are not carried over'
			)
		);
	});

	it('rewrites plain eslint steps in check and removes the lint script', async () => {
		const plan = await migrate('ts-service');

		const { scripts } = await readJson('package.json');
		expect(scripts.check).toBe('tsc && oxlint --deny-warnings && oxfmt --check && npm run other');
		expect(scripts.lint).toBeUndefined();
		expect(plan.scripts).toContain('remove lint ("eslint --quiet -f unix ."): check runs the linter');
	});

	it('flags other scripts that run eslint with options', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', scripts: { 'lint:fix': 'eslint --fix .' } } });

		const plan = await migrate('js');

		expect((await readJson('package.json')).scripts['lint:fix']).toBe('eslint --fix .');
		expect(plan.attention).toContainEqual(
			'scripts.lint:fix still runs eslint with options ("eslint --fix ."). Update it by hand.'
		);
	});

	it('points scripts that ran the lint script at check', async () => {
		await writeFiles({
			'package.json': {
				name: 'consumer',
				scripts: { lint: 'eslint', test: 'npm run lint && npm run test:unit', 'test:unit': 'true' }
			}
		});

		await migrate('js');

		expect((await readJson('package.json')).scripts).toEqual({
			test: 'npm run check && npm run test:unit',
			'test:unit': 'true',
			fmt: 'oxfmt',
			check: 'oxlint --deny-warnings && oxfmt --check'
		});
	});

	it('inlines the linter into a check script that called the lint script', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { lint: 'eslint', check: 'npm run lint && tsc' } }
		});

		await migrate('ts-service');

		const { scripts } = await readJson('package.json');
		expect(scripts.check).toBe('oxlint --deny-warnings && oxfmt --check && tsc');
		expect(scripts.lint).toBeUndefined();
	});

	it('adds the format check to an existing check script that has no lint step', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', scripts: { check: 'tsc' } } });

		await migrate('ts-service');

		expect((await readJson('package.json')).scripts.check).toBe('tsc && oxfmt --check');
	});

	it('leaves a check script that already checks formatting', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { check: 'tsc && oxlint --deny-warnings && npm run format:check' } }
		});

		const plan = await migrate('ts-service');

		expect((await readJson('package.json')).scripts.check).toBe(
			'tsc && oxlint --deny-warnings && npm run format:check'
		);
		expect(plan.scripts).toEqual(['add fmt, build']);
	});

	it('replaces the lint script of a JavaScript project with a check script', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', scripts: { lint: 'eslint' } } });

		await migrate('js');

		expect((await readJson('package.json')).scripts).toEqual({
			fmt: 'oxfmt',
			check: 'oxlint --deny-warnings && oxfmt --check'
		});
	});

	it('makes an existing plain oxlint step fail on warnings', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { check: 'tsc && oxlint && oxfmt --check', lint: 'oxlint' } }
		});

		await migrate('ts-service');

		const { scripts } = await readJson('package.json');
		expect(scripts.check).toBe('tsc && oxlint --deny-warnings && oxfmt --check');
		expect(scripts.lint).toBeUndefined();
	});

	it('removes directly listed oxlint packages, which now come in as peer dependencies', async () => {
		await writeFiles({
			'package.json': {
				name: 'consumer',
				devDependencies: { oxlint: '^1.0.0', oxfmt: '^0.70.0', 'oxlint-tsgolint': '^7.0.0' }
			}
		});

		const plan = await migrate('ts-service');

		expect(plan.dependencies).toContain('remove oxlint, oxfmt, oxlint-tsgolint');
		expect((await readJson('package.json')).devDependencies).toEqual({
			'@particle/tooling': TOOLING_SPEC,
			typescript: '^7.0.2'
		});
	});

	it('replaces an aliased older TypeScript', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', devDependencies: { typescript: 'npm:@typescript/typescript6@^6.0.2' } }
		});

		await migrate('js');

		expect((await readJson('package.json')).devDependencies.typescript).toBe('^7.0.2');
	});
});

describe('existing tsconfigs', () => {
	it('reduces a template service config to the shared one plus its own overrides', async () => {
		await writeFiles({
			'package.json': { name: 'consumer' },
			'tsconfig.json': SERVICE_TSCONFIG,
			'tsconfig.build.json': {
				extends: './tsconfig.json',
				compilerOptions: { noEmit: false, outDir: 'build/', rootDir: 'src/' },
				include: ['src/**/*'],
				exclude: ['**/*.test.ts', 'src/models/*.factory.ts']
			}
		});

		const plan = await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts.json',
			compilerOptions: { types: ['vitest/globals'] }
		});
		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build.json',
			exclude: ['**/*.test.ts', 'src/models/*.factory.ts']
		});
		expect(plan.files).toContain('    changes: module CommonJS -> NodeNext');
		expect(plan.attention).toContainEqual(
			expect.stringContaining('The shared tsconfig turns on noUncheckedIndexedAccess')
		);
		expect(plan.attention).toContainEqual(
			expect.stringContaining('module CommonJS -> NodeNext: run the type check afterwards')
		);
	});

	it('keeps an include that covers more than src and test', async () => {
		await writeFiles({
			'package.json': { name: 'consumer' },
			'tsconfig.json': {
				compilerOptions: { strict: true, noEmit: true },
				include: ['src/**/*', 'test/**/*', 'scripts/**/*']
			}
		});

		await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts.json',
			include: ['src/**/*', 'test/**/*', 'scripts/**/*']
		});
	});

	it('does not add a build config to a project that has none', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { build: 'node build.mjs' } },
			'tsconfig.json': { compilerOptions: { strict: true } }
		});

		const plan = await migrate('ts-service');

		expect(existsSync(path.join(dir, 'tsconfig.build.json'))).toBe(false);
		expect(await read('.gitignore')).toBe('.claude/\nCLAUDE.md\n');
		expect((await readJson('package.json')).scripts.build).toBe('node build.mjs');
		expect(plan.attention).toContainEqual(
			expect.stringContaining('No tsconfig.build.json was found, so none was added')
		);
	});

	it('moves the build output to build/ and lists what still names the old directory', async () => {
		await writeFiles({
			'package.json': {
				name: 'consumer',
				main: 'dist/index.js',
				types: './dist/index.d.ts',
				files: ['dist/', 'src/'],
				scripts: { build: 'rm -rf dist/ && tsc -p tsconfig.build.json' }
			},
			'tsconfig.json': { compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*', 'test/**/*'] },
			'tsconfig.build.json': {
				extends: './tsconfig.json',
				compilerOptions: { noEmit: false, outDir: 'dist', declaration: true, declarationMap: true },
				include: ['src/**/*']
			},
			'.gitignore': 'node_modules\ndist',
			Dockerfile: 'COPY dist/ ./dist/\n'
		});

		const plan = await migrate('ts-library');

		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build-library.json'
		});
		expect(await read('.gitignore')).toBe('node_modules\ndist\nbuild/\n.claude/\nCLAUDE.md\n');
		expect(plan.attention).toContainEqual(
			'Build output moves from dist/ to build/. Update these references to the old directory by hand: package.json main, package.json types, package.json files, package.json scripts.build, .gitignore, Dockerfile.'
		);
	});

	it('leaves a config with project-specific compiler options for the developer', async () => {
		const tsconfig = {
			compilerOptions: { target: 'es6', strict: true, paths: { '@/*': ['./src/*'] } },
			include: ['src']
		};
		const build = { extends: './tsconfig.json', compilerOptions: { noEmit: false, outDir: 'lib' } };
		await writeFiles({ 'package.json': { name: 'consumer' }, 'tsconfig.json': tsconfig, 'tsconfig.build.json': build });

		const plan = await migrate('ts-library');

		expect(await readJson('tsconfig.json')).toEqual(tsconfig);
		expect(await readJson('tsconfig.build.json')).toEqual(build);
		expect(await read('.gitignore')).toBe('.claude/\nCLAUDE.md\n');
		expect((await readJson('package.json')).scripts.build).toBeUndefined();
		expect(plan.attention).toContainEqual(
			expect.stringContaining(
				'tsconfig.json has project-specific compiler options (target, paths), so it was left alone'
			)
		);
		expect(plan.attention).toContainEqual(
			expect.stringContaining('tsconfig.build.json was left alone because tsconfig.json was')
		);
	});

	it('leaves a config that already extends something else', async () => {
		const tsconfig = { extends: '@tsconfig/node22/tsconfig.json' };
		await writeFiles({ 'package.json': { name: 'consumer' }, 'tsconfig.json': tsconfig });

		const plan = await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual(tsconfig);
		expect(plan.attention).toContainEqual(
			expect.stringContaining('tsconfig.json uses extends or references, so it was left alone')
		);
	});

	it('reduces the standard JavaScript config and keeps checkJs when it is on', async () => {
		await writeFiles({
			'package.json': { name: 'consumer' },
			'tsconfig.json': {
				compilerOptions: {
					allowJs: true,
					checkJs: true,
					module: 'commonjs',
					target: 'es2022',
					skipLibCheck: true,
					noEmit: true
				},
				include: ['src/**/*']
			}
		});

		await migrate('js');

		expect(await readJson('tsconfig.json')).toEqual({
			extends: '@particle/tooling/tsconfig/js.json',
			compilerOptions: { checkJs: true },
			include: ['src/**/*']
		});
	});

	it('leaves a JavaScript config with its own module settings for the developer', async () => {
		const tsconfig = {
			compilerOptions: { module: 'node16', allowJs: true, checkJs: true, strict: true, noEmit: true }
		};
		await writeFiles({ 'package.json': { name: 'consumer' }, 'tsconfig.json': tsconfig });

		const plan = await migrate('js');

		expect(await readJson('tsconfig.json')).toEqual(tsconfig);
		expect(plan.attention).toContainEqual(
			expect.stringContaining(
				'tsconfig.json has project-specific compiler options (strict, module), so it was left alone'
			)
		);
	});
});

describe('dependencies that do not accept TypeScript 7', () => {
	const lockfile = {
		lockfileVersion: 3,
		packages: {
			'node_modules/typedoc': { version: '0.28.17', peerDependencies: { typescript: '5.0.x || 5.1.x || 5.9.x' } },
			'node_modules/tsx': { version: '4.21.0' },
			'node_modules/ts-api-utils': { version: '2.5.0', peerDependencies: { typescript: '>=4.8.4' } },
			'node_modules/typescript-eslint': { version: '8.57.2', peerDependencies: { typescript: '>=4.8.4 <6.1.0' } }
		}
	};
	const devDependencies = {
		typedoc: '^0.28.17',
		tsx: '^4.21.0',
		'ts-api-utils': '^2.5.0',
		'typescript-eslint': '^8.57.2',
		typescript: '^5.9.2'
	};

	it('are listed before the migration is applied', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', devDependencies }, 'package-lock.json': lockfile });

		const plan = await createPlan(dir, 'ts-library');

		const conflicts = plan.attention.filter((note) => note.includes('only accepts typescript'));
		expect(conflicts).toEqual([
			'typedoc@0.28.17 only accepts typescript "5.0.x || 5.1.x || 5.9.x". npm install will fail with ERESOLVE until it is upgraded to a release that supports TypeScript 7, or removed.'
		]);
	});

	it('are not reported when TypeScript is already on 7', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', devDependencies: { ...devDependencies, typescript: '^7.0.2' } },
			'package-lock.json': lockfile
		});

		const plan = await createPlan(dir, 'ts-library');

		expect(plan.attention.filter((note) => note.includes('only accepts typescript'))).toEqual([]);
	});

	it('are skipped without a lockfile', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', devDependencies } });

		const plan = await createPlan(dir, 'ts-library');

		expect(plan.attention.filter((note) => note.includes('only accepts typescript'))).toEqual([]);
	});
});

describe('the lint and format config files', () => {
	const reExport = "export { default } from '@particle/tooling/oxlint';\n";

	it('are .ts in an ES module package', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', type: 'module' } });

		const plan = await migrate('js');

		expect(plan.files).toEqual(expect.arrayContaining(['create oxlint.config.ts', 'create oxfmt.config.ts']));
		expect(await read('oxlint.config.ts')).toBe(reExport);
		expect(existsSync(path.join(dir, 'oxlint.config.mts'))).toBe(false);
	});

	it('are .mts in a package with no type or with type commonjs, where Node would not load a .ts one as an ES module', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', type: 'commonjs' } });

		await migrate('js');

		expect(await read('oxlint.config.mts')).toBe(reExport);
		expect(await read('oxfmt.config.mts')).toBe("export { default } from '@particle/tooling/oxfmt';\n");
		expect(existsSync(path.join(dir, 'oxlint.config.ts'))).toBe(false);
	});

	it('are renamed from .ts to .mts in a package that is not an ES module, keeping their contents', async () => {
		const custom = "import shared from '@particle/tooling/oxlint';\nexport default { extends: [shared] };\n";
		await writeFiles({
			'package.json': { name: 'consumer' },
			'oxlint.config.ts': custom,
			'oxfmt.config.ts': '// custom\n'
		});

		const plan = await migrate('js');

		expect(plan.files).toContain(
			'rename oxlint.config.ts to oxlint.config.mts (this package is not an ES module, so Node needs the .mts extension to load it)'
		);
		expect(await read('oxlint.config.mts')).toBe(custom);
		expect(await read('oxfmt.config.mts')).toBe('// custom\n');
		expect(existsSync(path.join(dir, 'oxlint.config.ts'))).toBe(false);
		expect(existsSync(path.join(dir, 'oxfmt.config.ts'))).toBe(false);
	});

	it('are left alone when they already exist with an extension that works', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', type: 'module' },
			'oxlint.config.mts': '// custom\n',
			'oxfmt.config.ts': '// custom\n'
		});

		const plan = await migrate('js');

		expect(await read('oxlint.config.mts')).toBe('// custom\n');
		expect(await read('oxfmt.config.ts')).toBe('// custom\n');
		expect(plan.files.join('\n')).not.toMatch(/oxlint\.config|oxfmt\.config/);
	});
});

describe('.gitignore', () => {
	it('leaves entries that are already there', async () => {
		await writeFiles({
			'package.json': { name: 'consumer' },
			'.gitignore': 'node_modules\n/build\n.claude\nCLAUDE.md\n'
		});

		const plan = await migrate('ts-service');

		expect(await read('.gitignore')).toBe('node_modules\n/build\n.claude\nCLAUDE.md\n');
		expect(plan.files.join('\n')).not.toContain('.gitignore');
	});
});

describe('.gitignore additions', () => {
	it('lists build output and the agent files in one plan line', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' }, '.gitignore': 'node_modules\n.claude/\n' });

		const plan = await migrate('ts-service');

		expect(plan.files).toContain('add build/ and CLAUDE.md to .gitignore');
		expect(await read('.gitignore')).toBe('node_modules\n.claude/\nbuild/\nCLAUDE.md\n');
	});
});

describe('sourceRoot', () => {
	const tsconfig = {
		compilerOptions: { strict: true, noEmit: true, sourceRoot: '/' },
		include: ['src/**/*', 'test/**/*']
	};
	const build = {
		extends: './tsconfig.json',
		compilerOptions: { noEmit: false, outDir: 'build/' },
		include: ['src/**/*']
	};

	it('moves to the build config when the project uses Sentry', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', dependencies: { '@sentry/node': '^10.0.0' } },
			'tsconfig.json': tsconfig,
			'tsconfig.build.json': build
		});

		const plan = await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({ extends: '@particle/tooling/tsconfig/ts.json' });
		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build.json',
			compilerOptions: { sourceRoot: '/' }
		});
		expect(plan.files).toContain('    moves: sourceRoot to tsconfig.build.json');
	});

	it('is removed when the project does not use Sentry', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' }, 'tsconfig.json': tsconfig, 'tsconfig.build.json': build });

		const plan = await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({ extends: '@particle/tooling/tsconfig/ts.json' });
		expect(await readJson('tsconfig.build.json')).toEqual({ extends: '@particle/tooling/tsconfig/ts-build.json' });
		expect(plan.files).toContain(
			'    removes: sourceRoot (it only helps Sentry, which is not installed, and it breaks paths in Node stack traces)'
		);
	});

	it('is added to the build config of a Sentry project that never set it', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', devDependencies: { '@sentry/cli': '^3.0.0' } },
			'tsconfig.json': { compilerOptions: { strict: true }, include: ['src', 'test'] },
			'tsconfig.build.json': build
		});

		const plan = await migrate('ts-service');

		expect((await readJson('tsconfig.build.json')).compilerOptions).toEqual({ sourceRoot: '/' });
		expect(plan.files).toContain(
			'    adds: sourceRoot "/" (Sentry is installed: this keeps source paths stable for issue grouping)'
		);
	});

	it('is set in the build config of a new Sentry project', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', dependencies: { '@sentry/node': '^10.0.0' } } });

		await migrate('ts-service');

		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build.json',
			compilerOptions: { sourceRoot: '/' }
		});
	});

	it('stays in tsconfig.json when a Sentry project has no build config', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', dependencies: { '@sentry/node': '^10.0.0' } },
			'tsconfig.json': tsconfig
		});

		await migrate('ts-service');

		expect(await readJson('tsconfig.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts.json',
			compilerOptions: { sourceRoot: '/' }
		});
	});
});

describe('an already migrated project', () => {
	it('has nothing to change', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });
		await migrate('ts-library');

		const plan = await createPlan(dir, 'ts-library');

		expect(hasChanges(plan)).toBe(false);
		expect(formatPlan(plan)).toBe('');
	});
});

describe('createPlan', () => {
	it('changes nothing on disk', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', devDependencies: { eslint: '^9.0.0' } },
			'eslint.config.mjs': 'export default [];\n'
		});

		const plan = await createPlan(dir, 'ts-service');

		expect(hasChanges(plan)).toBe(true);
		expect(await readJson('package.json')).toEqual({ name: 'consumer', devDependencies: { eslint: '^9.0.0' } });
		expect(existsSync(path.join(dir, 'eslint.config.mjs'))).toBe(true);
		expect(existsSync(path.join(dir, 'oxlint.config.mts'))).toBe(false);
	});

	it('keeps the indentation of package.json', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		await migrate('js');

		expect(await read('package.json')).toMatch(/^ {2}"name"/m);
	});

	it('rejects an unknown style', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		await expect(createPlan(dir, 'rust')).rejects.toThrow(
			'Unknown style "rust". Expected one of: js, ts-service, ts-library'
		);
	});
});

describe('the CI reminder', () => {
	it('says which CI step now covers formatting', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { check: 'tsc && eslint' } },
			'.circleci/config.yml': 'steps:\n  - run: npm run check\n  - run: npm test\n'
		});

		const plan = await createPlan(dir, 'ts-service');

		expect(plan.attention.at(-1)).toBe(
			'Double check CI: .circleci/config.yml runs "npm run check", which now includes the format check. Confirm that step fails the build on unformatted code.'
		);
	});

	it('says when CI still runs the removed lint script and nothing that checks formatting', async () => {
		await writeFiles({
			'package.json': { name: 'consumer', scripts: { lint: 'eslint' } },
			'.circleci/config.yml': 'steps:\n  - run: npm run lint\n'
		});

		const plan = await createPlan(dir, 'js');

		expect(plan.attention.slice(-2)).toEqual([
			'.circleci/config.yml runs "npm run lint", which was removed. Change it to "npm run check".',
			'Double check CI: .circleci/config.yml does not appear to run a script that checks formatting. Add a step such as "npm run check".'
		]);
	});

	it('says when there is no CI config to look at', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		const plan = await createPlan(dir, 'js');

		expect(plan.attention.at(-1)).toMatch(/^Double check your CI: no CI config was found here/);
	});
});

describe('formatPlan', () => {
	beforeEach(async () => {
		await writeFiles({
			'package.json': {
				name: 'consumer',
				scripts: { check: 'tsc && eslint' },
				devDependencies: { eslint: '^9.0.0', typescript: '^6.0.2' }
			},
			'eslint.config.mjs': 'export default [];\n'
		});
	});

	it('colors removals red, changes yellow and additions green', async () => {
		const text = formatPlan(await createPlan(dir, 'ts-service'), { color: true });

		expect(text).toContain(red('  - remove eslint'));
		expect(text).toContain(red('  - delete eslint.config.mjs (not tracked by git, so it cannot be restored)'));
		expect(text).toContain(yellow('  - typescript ^6.0.2 -> ^7.0.2'));
		expect(text).toContain(yellow('  - check: "tsc && eslint" -> "tsc && oxlint --deny-warnings && oxfmt --check"'));
		expect(text).toContain(
			green(
				`  - add @particle/tooling ${TOOLING_SPEC} (installs oxlint, oxfmt and oxlint-tsgolint as peer dependencies)`
			)
		);
		expect(text).toContain(green('  - create oxlint.config.mts'));
	});

	it('has no color codes when color is off', async () => {
		const text = formatPlan(await createPlan(dir, 'ts-service'), { color: false });

		expect(text).not.toContain('\u001B');
		expect(text).toContain('Dependencies (package.json)\n  - remove eslint\n  - typescript ^6.0.2 -> ^7.0.2');
	});
});

describe('detectStyle', () => {
	it('detects a JavaScript project', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' }, 'src/index.js': '' });

		expect(await detectStyle(dir)).toBe('js');
	});

	it('detects a TypeScript service', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' }, 'src/nested/index.ts': '' });

		expect(await detectStyle(dir)).toBe('ts-service');
	});

	it('detects a TypeScript library from its declaration build', async () => {
		await writeFiles({
			'package.json': { name: 'consumer' },
			'tsconfig.build.json': { compilerOptions: { declaration: true } }
		});

		expect(await detectStyle(dir)).toBe('ts-library');
	});
});

describe('particle-tooling-init bin', () => {
	it('prints the plan and applies it when invoked through a symlink, as npm links it into node_modules/.bin', async () => {
		await writeFiles({ 'package.json': { name: 'consumer', devDependencies: { eslint: '^9.0.0' } } });
		const link = path.join(dir, 'particle-tooling-init');
		await symlink(bin, link);

		const { stdout } = await execFile(
			process.execPath,
			[link, '--style', 'ts-library', '--yes', '--no-install', '--tooling-spec', 'file:../tooling.tgz'],
			{
				cwd: dir
			}
		);

		expect(stdout).toMatch(/Nothing has been changed yet/);
		expect(stdout).toMatch(/- remove eslint/);
		expect(stdout).toMatch(/Changes applied/);
		expect(await readJson('tsconfig.build.json')).toEqual({
			extends: '@particle/tooling/tsconfig/ts-build-library.json'
		});
		expect((await readJson('package.json')).devDependencies).toEqual({
			'@particle/tooling': 'file:../tooling.tgz',
			typescript: '^7.0.2'
		});
	});

	it('asks for --style and --yes when stdin is not a terminal', async () => {
		await writeFiles({ 'package.json': { name: 'consumer' } });

		const run = execFile(process.execPath, [bin, '--style', 'js'], { cwd: dir });
		run.child.stdin?.end();

		await expect(run).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('Pass --style and --yes when not running interactively')
		});
		expect(existsSync(path.join(dir, 'oxlint.config.mts'))).toBe(false);
	});

	describe('running npm', () => {
		const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const call = { args, devDependencies: Object.keys(pkg.devDependencies ?? {}) };
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(call) + '\\n');
process.exit(args[0] === process.env.FAKE_NPM_FAIL ? 1 : 0);
`;

		/**
		 * Runs the bin with a stand-in npm first on the PATH.
		 * @param {{ fail?: string }} [options] fail names an npm command that exits with an error
		 * @returns {Promise<{ stdout: string, stderr: string }>}
		 */
		async function runWithFakeNpm({ fail } = {}) {
			const fakeBin = path.join(dir, 'fake-bin');
			await writeFiles({ 'fake-bin/npm': FAKE_NPM });
			await chmod(path.join(fakeBin, 'npm'), 0o755);
			return execFile(process.execPath, [bin, '--style', 'ts-service', '--yes'], {
				cwd: dir,
				env: {
					...process.env,
					PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
					FAKE_NPM_LOG: path.join(dir, 'npm-calls.log'),
					FAKE_NPM_FAIL: fail ?? ''
				}
			});
		}

		it('uninstalls the removed packages before package.json changes, then installs', async () => {
			await writeFiles({
				'package.json': {
					name: 'consumer',
					devDependencies: { eslint: '^9.0.0', 'eslint-config-particle': '^3.0.0', typescript: '^6.0.2' }
				}
			});

			const { stdout } = await runWithFakeNpm();

			expect(await npmCalls()).toEqual([
				{
					args: ['uninstall', 'eslint', 'eslint-config-particle'],
					devDependencies: ['eslint', 'eslint-config-particle', 'typescript']
				},
				{ args: ['install'], devDependencies: ['@particle/tooling', 'typescript'] }
			]);
			expect(stdout).toMatch(/First: npm uninstall eslint eslint-config-particle/);
			expect(stdout).toMatch(/Then: npm install/);
		});

		it('only installs when no packages are removed', async () => {
			await writeFiles({ 'package.json': { name: 'consumer', devDependencies: { typescript: '^6.0.2' } } });

			await runWithFakeNpm();

			expect((await npmCalls()).map(({ args }) => args)).toEqual([['install']]);
		});

		it('changes nothing when the uninstall fails', async () => {
			const pkg = { name: 'consumer', devDependencies: { eslint: '^9.0.0', typescript: '^6.0.2' } };
			await writeFiles({ 'package.json': pkg });

			await expect(runWithFakeNpm({ fail: 'uninstall' })).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining('npm uninstall failed. Nothing else was changed')
			});
			expect(await readJson('package.json')).toEqual(pkg);
			expect(existsSync(path.join(dir, 'oxlint.config.mts'))).toBe(false);
			expect((await npmCalls()).map(({ args }) => args)).toEqual([['uninstall', 'eslint']]);
		});
	});
});
