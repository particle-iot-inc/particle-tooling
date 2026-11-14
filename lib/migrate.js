import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, styleText } from 'node:util';

import toolingPackage from '../package.json' with { type: 'json' };
import { parseJsonc } from './jsonc.js';

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(import.meta.dirname, '..');

const TOOLING = '@particle/tooling';

export const STYLES = {
	js: 'JavaScript project',
	'ts-service': 'TypeScript service',
	'ts-library': 'TypeScript library, built with declarations'
};

const LEGACY_PACKAGES =
	/^(eslint|eslint-config-.+|eslint-plugin-.+|@eslint\/.+|typescript-eslint|@typescript-eslint\/.+|oxlint|oxfmt|oxlint-tsgolint)$/;

const LEGACY_FILES = [
	'eslint.config.js',
	'eslint.config.mjs',
	'eslint.config.cjs',
	'eslint.config.ts',
	'.eslintrc',
	'.eslintrc.js',
	'.eslintrc.cjs',
	'.eslintrc.json',
	'.eslintrc.yml',
	'.eslintrc.yaml',
	'.eslintignore',
	'.oxlintrc.json',
	'.oxlintrc.jsonc',
	'.oxfmtrc.json',
	'.oxfmtrc.jsonc'
];

/**
 * @param {string} style
 * @returns {Record<string, string>} lint and format config contents by file name. TypeScript styles get the type-aware lint config.
 */
const lintFiles = (style) => ({
	'oxlint.config.ts': `export { default } from '${TOOLING}/${style === 'js' ? 'oxlint' : 'oxlint-typescript'}';\n`,
	'oxfmt.config.ts': `export { default } from '${TOOLING}/oxfmt';\n`
});

const FORMAT_CHECK = 'oxfmt --check';
/** Warnings fail the lint step, so a `warn` rule still fails CI. */
const LINT = 'oxlint --deny-warnings';

const FORMAT_SCRIPTS = {
	fmt: 'oxfmt',
	'fmt:check': FORMAT_CHECK
};

const BUILD_DIR = 'build';
const BUILD_SCRIPT = `rm -rf ${BUILD_DIR}/ && tsc -p tsconfig.build.json`;
const OUT_DIR_REFERENCE_FILES = ['.gitignore', '.dockerignore', 'Dockerfile', '.circleci/config.yml'];
const REDUNDANT_UNDER_STRICT = new Set(['noImplicitAny', 'strictNullChecks']);
const TRUE_BY_DEFAULT = new Set(['forceConsistentCasingInFileNames']);

/** Overrides a project may carry through an automatic tsconfig rewrite. Anything else is left for the developer. */
const SIMPLE_TS_OVERRIDES = new Set(['types', 'sourceRoot', 'declaration', 'declarationMap', 'outDir', 'rootDir']);
const SIMPLE_JS_OVERRIDES = new Set(['checkJs']);

/** Strips the build path from source references so Sentry groups issues consistently. It breaks paths in plain Node stack traces, so it is only set for projects that use Sentry. */
const SENTRY_SOURCE_ROOT = '/';
const SOURCE_ROOT_REMOVED =
	'    removes: sourceRoot (it only helps Sentry, which is not installed, and it breaks paths in Node stack traces)';

/**
 * @typedef {object} Plan
 * @property {string} style
 * @property {string[]} dependencies changes to package.json dependencies
 * @property {string[]} files files created, rewritten or deleted
 * @property {string[]} scripts changes to package.json scripts
 * @property {string[]} attention things the migration cannot do and the user has to check
 * @property {string | null} packageJson new package.json contents, or null when unchanged
 * @property {{ file: string, contents: string }[]} writes
 * @property {string[]} deletes
 */

/**
 * @param {string} file path relative to this package
 * @returns {Promise<any>}
 */
const readOwnJson = async (file) => parseJsonc(await readFile(path.join(packageRoot, file), 'utf8'));

/**
 * @param {string} dir
 * @param {string} file
 * @returns {Promise<string | null>} the file contents, or null when it does not exist
 */
async function readOptional(dir, file) {
	try {
		return await readFile(path.join(dir, file), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') {
			return null;
		}
		throw err;
	}
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {Promise<boolean>} false for untracked files and outside a git repository
 */
async function isTracked(dir, file) {
	try {
		await execFile('git', ['ls-files', '--error-unmatch', file], { cwd: dir });
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>} whether src contains a TypeScript source file
 */
async function hasTypeScriptSource(dir) {
	try {
		const entries = await readdir(path.join(dir, 'src'), { recursive: true });
		return entries.some((entry) => /\.(ts|mts|cts|tsx)$/.test(entry) && !entry.endsWith('.d.ts'));
	} catch {
		return false;
	}
}

/**
 * Guesses the project style to offer as the default at the prompt.
 * @param {string} dir
 * @returns {Promise<string>} a key of STYLES
 */
export async function detectStyle(dir) {
	const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
	if (!existsSync(path.join(dir, 'tsconfig.build.json')) && !(await hasTypeScriptSource(dir))) {
		return 'js';
	}
	const build = await readOptional(dir, 'tsconfig.build.json');
	const emitsDeclarations = build ? parseJsonc(build).compilerOptions?.declaration === true : false;
	return emitsDeclarations || pkg.types || pkg.typings || pkg.publishConfig ? 'ts-library' : 'ts-service';
}

/**
 * @param {unknown} value
 * @returns {string} a form that ignores letter case and array order, for comparing compiler options
 */
function canonical(value) {
	if (Array.isArray(value)) {
		return JSON.stringify(value.map(canonical).toSorted());
	}
	return JSON.stringify(typeof value === 'string' ? value.toLowerCase() : value);
}

/**
 * @param {string} pattern an include pattern or directory option
 * @returns {string} the directory it names, without ./ prefix, trailing slash or trailing glob
 */
const directoryOf = (pattern) =>
	pattern
		.replace(/^\.\//, '')
		.replace(/\/\*\*\/\*$/, '')
		.replace(/\/$/, '');

/**
 * @param {string[] | undefined} patterns
 * @param {string[]} directories
 * @returns {boolean} whether the include patterns name exactly these directories
 */
const includesOnly = (patterns, directories) =>
	patterns !== undefined && canonical(patterns.map(directoryOf)) === canonical(directories);

/**
 * Splits a project's compiler options into the ones the shared config already provides and the ones to keep.
 * @param {Record<string, unknown>} options the project's own compiler options
 * @param {Record<string, unknown>} base the shared config's compiler options
 * @returns {{ kept: Record<string, unknown>, dropped: string[], changed: string[] }}
 */
function splitOptions(options, base) {
	/** @type {Record<string, unknown>} */
	const kept = {};
	const dropped = [];
	const changed = [];
	const baseLib = Array.isArray(base.lib) ? base.lib.map((entry) => String(entry).toLowerCase()) : [];
	for (const [name, value] of Object.entries(options)) {
		if (name === 'module' || name === 'moduleResolution') {
			if (name === 'module' && canonical(value) !== canonical(base.module)) {
				changed.push(`module ${value} -> ${base.module}`);
			} else {
				dropped.push(name);
			}
		} else if (REDUNDANT_UNDER_STRICT.has(name) && value === true && base.strict === true) {
			dropped.push(name);
		} else if (TRUE_BY_DEFAULT.has(name) && value === true) {
			dropped.push(name);
		} else if (
			name === 'lib' &&
			Array.isArray(value) &&
			value.every((entry) => baseLib.includes(String(entry).toLowerCase()))
		) {
			dropped.push(name);
		} else if (name in base && canonical(value) === canonical(base[name])) {
			dropped.push(name);
		} else {
			kept[name] = value;
		}
	}
	return { kept, dropped, changed };
}

/**
 * @param {string} file
 * @param {string[]} names compiler options the automatic rewrite does not handle
 * @param {string} target the shared config to extend
 * @returns {string} an attention note
 */
const leftAlone = (file, names, target) =>
	`${file} has project-specific compiler options (${names.join(', ')}), so it was left alone. Extend ${target} by hand and keep what the project needs.`;

/**
 * @param {string} source existing file contents, used to keep its indentation
 * @param {object} config
 * @returns {string}
 */
function serialize(source, config) {
	const indent = /^[ \t]+/m.exec(source)?.[0] ?? '\t';
	return `${JSON.stringify(config, null, indent)}\n`;
}

/**
 * @param {string} file
 * @param {string} target the shared config being extended
 * @param {{ kept: Record<string, unknown>, dropped: string[], changed: string[] }} split
 * @param {Record<string, unknown>} extras top-level keys kept, such as include
 * @param {string[]} [notes] extra lines
 * @returns {string[]} plan lines describing the rewrite
 */
function describeRewrite(file, target, split, extras, notes = []) {
	const lines = [`rewrite ${file} to extend ${target}`];
	const keeps = [...Object.keys(split.kept), ...Object.keys(extras)];
	if (keeps.length > 0) {
		lines.push(`    keeps: ${keeps.join(', ')}`);
	}
	if (split.changed.length > 0) {
		lines.push(`    changes: ${split.changed.join(', ')}`);
	}
	if (split.dropped.length > 0) {
		lines.push(`    drops (provided by the shared config): ${split.dropped.join(', ')}`);
	}
	return [...lines, ...notes];
}

/**
 * Plans the tsconfig changes for a project.
 * @param {string} dir
 * @param {string} style
 * @param {Plan} plan mutated with the file changes and attention notes
 * @param {boolean} hasSentry whether the project depends on a Sentry package
 * @returns {Promise<{ hasBuildConfig: boolean, previousOutDir: string | null }>} hasBuildConfig is true when the project ends up with a build config that extends the shared one
 */
async function planTsconfigs(dir, style, plan, hasSentry) {
	const rootSource = await readOptional(dir, 'tsconfig.json');
	const buildSource = await readOptional(dir, 'tsconfig.build.json');

	if (style === 'js') {
		const target = `${TOOLING}/tsconfig/js.json`;
		if (rootSource === null) {
			plan.writes.push({ file: 'tsconfig.json', contents: serialize('', { extends: target }) });
			plan.files.push('create tsconfig.json');
			return { hasBuildConfig: false, previousOutDir: null };
		}
		const root = parseJsonc(rootSource);
		if (String(root.extends ?? '').startsWith(TOOLING)) {
			return { hasBuildConfig: false, previousOutDir: null };
		}
		if (root.extends !== undefined || root.references !== undefined) {
			plan.attention.push(
				`tsconfig.json uses extends or references, so it was left alone. Point it at ${target} by hand.`
			);
			return { hasBuildConfig: false, previousOutDir: null };
		}
		const base = (await readOwnJson('tsconfig/js.json')).compilerOptions;
		const split = splitOptions(root.compilerOptions ?? {}, base);
		const complex = [
			...Object.keys(split.kept).filter((name) => !SIMPLE_JS_OVERRIDES.has(name)),
			...(split.changed.length > 0 ? ['module'] : [])
		];
		if (complex.length > 0) {
			plan.attention.push(leftAlone('tsconfig.json', complex, target));
			return { hasBuildConfig: false, previousOutDir: null };
		}
		const extras = Object.fromEntries(
			['include', 'exclude', 'files'].filter((key) => root[key] !== undefined).map((key) => [key, root[key]])
		);
		const config = {
			extends: target,
			...(Object.keys(split.kept).length > 0 && { compilerOptions: split.kept }),
			...extras
		};
		plan.writes.push({ file: 'tsconfig.json', contents: serialize(rootSource, config) });
		plan.files.push(...describeRewrite('tsconfig.json', target, split, extras));
		return { hasBuildConfig: false, previousOutDir: null };
	}

	const rootTarget = `${TOOLING}/tsconfig/ts.json`;
	const buildTarget = `${TOOLING}/tsconfig/${style === 'ts-library' ? 'ts-build-library' : 'ts-build'}.json`;
	const rootBase = (await readOwnJson('tsconfig/ts.json')).compilerOptions;
	const buildBase = {
		...rootBase,
		...(await readOwnJson('tsconfig/ts-build.json')).compilerOptions,
		...(style === 'ts-library' && (await readOwnJson('tsconfig/ts-build-library.json')).compilerOptions)
	};

	/** @type {Record<string, unknown>} */
	let rootOverrides = {};
	let rootMigrated = rootSource === null;
	let sourceRootLeftRoot = false;
	const sentryOptions = hasSentry ? { compilerOptions: { sourceRoot: SENTRY_SOURCE_ROOT } } : {};
	if (rootSource === null) {
		plan.writes.push({ file: 'tsconfig.json', contents: serialize('', { extends: rootTarget }) });
		plan.files.push('create tsconfig.json');
	} else {
		const root = parseJsonc(rootSource);
		if (String(root.extends ?? '').startsWith(TOOLING)) {
			rootOverrides = root.compilerOptions ?? {};
			rootMigrated = true;
		} else if (root.extends !== undefined || root.references !== undefined) {
			plan.attention.push(
				`tsconfig.json uses extends or references, so it was left alone. Point it at ${rootTarget} by hand.`
			);
		} else if (
			Object.keys(splitOptions(root.compilerOptions ?? {}, rootBase).kept).some(
				(name) => !SIMPLE_TS_OVERRIDES.has(name)
			)
		) {
			const { kept } = splitOptions(root.compilerOptions ?? {}, rootBase);
			plan.attention.push(
				leftAlone(
					'tsconfig.json',
					Object.keys(kept).filter((name) => !SIMPLE_TS_OVERRIDES.has(name)),
					rootTarget
				)
			);
		} else {
			const split = splitOptions(root.compilerOptions ?? {}, rootBase);
			const notes = [];
			if ('sourceRoot' in split.kept && !(hasSentry && buildSource === null)) {
				delete split.kept.sourceRoot;
				sourceRootLeftRoot = true;
				notes.push(hasSentry ? '    moves: sourceRoot to tsconfig.build.json' : SOURCE_ROOT_REMOVED);
			}
			rootOverrides = split.kept;
			rootMigrated = true;
			/** @type {Record<string, unknown>} */
			const extras = {};
			if (!includesOnly(root.include, ['src', 'test'])) {
				extras.include = root.include ?? ['**/*'];
			}
			if (root.exclude !== undefined && canonical(root.exclude) !== canonical(['node_modules'])) {
				extras.exclude = root.exclude;
			}
			if (root.files !== undefined) {
				extras.files = root.files;
			}
			const config = {
				extends: rootTarget,
				...(Object.keys(split.kept).length > 0 && { compilerOptions: split.kept }),
				...extras
			};
			plan.writes.push({ file: 'tsconfig.json', contents: serialize(rootSource, config) });
			plan.files.push(...describeRewrite('tsconfig.json', rootTarget, split, extras, notes));
			if (split.changed.length > 0) {
				plan.attention.push(
					`${split.changed.join(', ')}: run the type check afterwards. Relative dynamic imports need a file extension under NodeNext.`
				);
			}
			if (root.compilerOptions?.noUncheckedIndexedAccess !== true) {
				plan.attention.push(
					'The shared tsconfig turns on noUncheckedIndexedAccess: reading array[i] or record[key] now includes undefined. Expect new type errors where the code does not check for it.'
				);
			}
		}
	}

	if (buildSource === null) {
		if (rootSource === null) {
			plan.writes.push({
				file: 'tsconfig.build.json',
				contents: serialize('', { extends: buildTarget, ...sentryOptions })
			});
			plan.files.push('create tsconfig.build.json');
			return { hasBuildConfig: true, previousOutDir: null };
		}
		plan.attention.push(
			'No tsconfig.build.json was found, so none was added. Add one extending ' +
				buildTarget +
				' if this project should build with tsc.'
		);
		return { hasBuildConfig: false, previousOutDir: null };
	}

	const build = parseJsonc(buildSource);
	if (String(build.extends ?? '').startsWith(TOOLING)) {
		return { hasBuildConfig: true, previousOutDir: null };
	}
	if (!rootMigrated) {
		plan.attention.push(`tsconfig.build.json was left alone because tsconfig.json was. Extend ${buildTarget} by hand.`);
		return { hasBuildConfig: false, previousOutDir: null };
	}
	const sourceRootReminder =
		hasSentry && sourceRootLeftRoot
			? ' tsconfig.json no longer sets sourceRoot, so set "sourceRoot": "/" there for Sentry.'
			: '';
	if (!['./tsconfig.json', './tsconfig', 'tsconfig.json'].includes(build.extends)) {
		plan.attention.push(
			`tsconfig.build.json does not extend ./tsconfig.json, so it was left alone. Extend ${buildTarget} by hand.${sourceRootReminder}`
		);
		return { hasBuildConfig: false, previousOutDir: null };
	}

	const { outDir, rootDir, sourceRoot: previousSourceRoot, ...own } = build.compilerOptions ?? {};
	const previousOutDir = typeof outDir === 'string' ? directoryOf(outDir) : null;
	const { types: _types, noEmit: _noEmit, sourceRoot: _sourceRoot, ...inherited } = rootOverrides;
	const split = splitOptions({ ...inherited, ...own }, buildBase);
	const complex = Object.keys(split.kept).filter((name) => !SIMPLE_TS_OVERRIDES.has(name));
	if (complex.length > 0) {
		plan.attention.push(leftAlone('tsconfig.build.json', complex, buildTarget) + sourceRootReminder);
		return { hasBuildConfig: false, previousOutDir: null };
	}
	if (typeof rootDir === 'string' && directoryOf(rootDir) !== 'src') {
		split.kept.rootDir = rootDir;
	}
	if (previousOutDir !== null && previousOutDir !== BUILD_DIR) {
		split.changed.push(`outDir ${previousOutDir}/ -> ${BUILD_DIR}/`);
	}
	const notes = [];
	if (hasSentry) {
		split.kept.sourceRoot = SENTRY_SOURCE_ROOT;
		if (previousSourceRoot === undefined && !sourceRootLeftRoot) {
			notes.push('    adds: sourceRoot "/" (Sentry is installed: this keeps source paths stable for issue grouping)');
		}
	} else if (previousSourceRoot !== undefined) {
		notes.push(SOURCE_ROOT_REMOVED);
	}
	/** @type {Record<string, unknown>} */
	const extras = {};
	if (build.include !== undefined && !includesOnly(build.include, ['src'])) {
		extras.include = build.include;
	}
	if (build.exclude !== undefined && canonical(build.exclude) !== canonical(['**/*.test.ts'])) {
		extras.exclude = build.exclude;
	}
	const config = {
		extends: buildTarget,
		...(Object.keys(split.kept).length > 0 && { compilerOptions: split.kept }),
		...extras
	};
	plan.writes.push({ file: 'tsconfig.build.json', contents: serialize(buildSource, config) });
	plan.files.push(...describeRewrite('tsconfig.build.json', buildTarget, split, extras, notes));
	return { hasBuildConfig: true, previousOutDir };
}

/**
 * @param {string} dir
 * @param {any} pkg the project's package.json before the migration
 * @param {string} previous the old build output directory
 * @returns {Promise<string[]>} places that still name the old build output directory
 */
async function findOutDirReferences(dir, pkg, previous) {
	const mention = new RegExp(`(^|[\\s"'./=:])${previous.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$|[\\s"'])`, 'm');
	const references = [];
	for (const field of ['main', 'types', 'typings', 'bin', 'exports', 'files']) {
		if (pkg[field] !== undefined && mention.test(JSON.stringify(pkg[field]).replaceAll('"', ' '))) {
			references.push(`package.json ${field}`);
		}
	}
	for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
		if (mention.test(command)) {
			references.push(`package.json scripts.${name}`);
		}
	}
	const sources = await Promise.all(OUT_DIR_REFERENCE_FILES.map((file) => readOptional(dir, file)));
	for (const [index, source] of sources.entries()) {
		if (source !== null && mention.test(source)) {
			references.push(OUT_DIR_REFERENCE_FILES[index]);
		}
	}
	return references;
}

/**
 * @param {string} dir
 * @param {Record<string, string>} scripts the project's scripts after the migration
 * @returns {Promise<string>} a reminder to make sure CI checks formatting, naming the CI config and script when it can
 */
async function ciReminder(dir, scripts) {
	const workflows = await readdir(path.join(dir, '.github/workflows')).catch(() => []);
	const candidates = [
		'.circleci/config.yml',
		...workflows.filter((file) => /\.ya?ml$/.test(file)).map((file) => `.github/workflows/${file}`)
	];
	const sources = await Promise.all(candidates.map((file) => readOptional(dir, file)));
	const configs = candidates.filter((_, index) => sources[index] !== null);
	const formatScripts = Object.keys(scripts).filter((name) =>
		/\boxfmt --check\b|\b(fmt|format):check\b/.test(scripts[name])
	);
	const ciText = sources.filter((source) => source !== null).join('\n');
	const covered = formatScripts.find((name) => new RegExp(`npm run ${name}(\\s|$)`, 'm').test(ciText));
	if (configs.length === 0) {
		return 'Double check your CI: no CI config was found here. It should run a step that fails on unformatted code, such as "npm run fmt:check".';
	}
	if (covered) {
		return `Double check CI: ${configs.join(', ')} runs "npm run ${covered}", which now includes the format check. Confirm that step fails the build on unformatted code.`;
	}
	return `Double check CI: ${configs.join(', ')} does not appear to run a script that checks formatting. Add a step such as "npm run ${formatScripts.includes('check') ? 'check' : 'fmt:check'}".`;
}

/**
 * Works out everything the migration would change, without changing anything.
 * @param {string} dir directory containing the package.json to migrate
 * @param {string} style a key of STYLES
 * @param {{ toolingSpec?: string }} [options] toolingSpec overrides the @particle/tooling version written to package.json
 * @returns {Promise<Plan>}
 */
export async function createPlan(dir, style, options = {}) {
	if (!Object.hasOwn(STYLES, style)) {
		throw new Error(`Unknown style "${style}". Expected one of: ${Object.keys(STYLES).join(', ')}`);
	}
	const toolingSpec = options.toolingSpec ?? `^${toolingPackage.version}`;
	const typescriptSpec = toolingPackage.peerDependencies.typescript;
	const packageSource = await readFile(path.join(dir, 'package.json'), 'utf8');
	const pkg = JSON.parse(packageSource);
	const original = structuredClone(pkg);

	/** @type {Plan} */
	const plan = {
		style,
		dependencies: [],
		files: [],
		scripts: [],
		attention: [],
		packageJson: null,
		writes: [],
		deletes: []
	};

	const removed = [];
	for (const field of ['dependencies', 'devDependencies']) {
		for (const name of Object.keys(pkg[field] ?? {})) {
			if (LEGACY_PACKAGES.test(name)) {
				delete pkg[field][name];
				removed.push(name);
			}
		}
	}
	if (removed.length > 0) {
		plan.dependencies.push(`remove ${removed.join(', ')}`);
	}
	const typescriptField = pkg.dependencies?.typescript ? 'dependencies' : 'devDependencies';
	const currentTypescript = pkg[typescriptField]?.typescript;
	if (currentTypescript !== undefined) {
		const major = Number(/\d+/.exec(currentTypescript.replace(/^npm:.+@/, ''))?.[0]);
		if (currentTypescript.startsWith('npm:') || !(major >= 7)) {
			pkg[typescriptField].typescript = typescriptSpec;
			plan.dependencies.push(`typescript ${currentTypescript} -> ${typescriptSpec}`);
			plan.attention.push('TypeScript moves to version 7: run the type check afterwards and fix any new errors.');
		}
	} else if (style !== 'js') {
		pkg.devDependencies = { ...pkg.devDependencies, typescript: typescriptSpec };
		plan.dependencies.push(`add typescript ${typescriptSpec}`);
	}
	if (pkg.devDependencies?.[TOOLING] !== toolingSpec) {
		pkg.devDependencies = { ...pkg.devDependencies, [TOOLING]: toolingSpec };
		plan.dependencies.push(
			`add ${TOOLING} ${toolingSpec} (installs oxlint, oxfmt and oxlint-tsgolint as peer dependencies)`
		);
	}
	if (pkg.devDependencies) {
		pkg.devDependencies = Object.fromEntries(
			Object.entries(pkg.devDependencies).toSorted(([a], [b]) => a.localeCompare(b, 'en'))
		);
	}

	const legacyFiles = LEGACY_FILES.filter((file) => existsSync(path.join(dir, file)));
	const tracked = await Promise.all(legacyFiles.map((file) => isTracked(dir, file)));
	for (const [index, file] of legacyFiles.entries()) {
		plan.deletes.push(file);
		plan.files.push(`delete ${file}${tracked[index] ? '' : ' (not tracked by git, so it cannot be restored)'}`);
	}
	const legacyLintConfigs = legacyFiles.filter((file) => file !== '.eslintignore' && !file.startsWith('.oxfmtrc'));
	if (legacyLintConfigs.length > 0) {
		plan.attention.push(
			`${legacyLintConfigs.join(', ')}: project-specific rules and ignores are not carried over, and the files are deleted. Save anything you still need before applying, then re-add it in oxlint.config.ts.`
		);
	}
	for (const [file, contents] of Object.entries(lintFiles(style))) {
		if (!existsSync(path.join(dir, file))) {
			plan.writes.push({ file, contents });
			plan.files.push(`create ${file}`);
		}
	}

	const hasSentry = Object.keys({ ...original.dependencies, ...original.devDependencies }).some((name) =>
		name.startsWith('@sentry/')
	);
	const { hasBuildConfig, previousOutDir } = await planTsconfigs(dir, style, plan, hasSentry);

	if (hasBuildConfig) {
		const gitignore = (await readOptional(dir, '.gitignore')) ?? '';
		const ignored = gitignore.split('\n').some((line) => directoryOf(line.trim().replace(/^\//, '')) === BUILD_DIR);
		if (!ignored) {
			const separator = gitignore === '' || gitignore.endsWith('\n') ? '' : '\n';
			plan.writes.push({ file: '.gitignore', contents: `${gitignore}${separator}${BUILD_DIR}/\n` });
			plan.files.push(`add ${BUILD_DIR}/ to .gitignore`);
		}
	}
	if (previousOutDir !== null && previousOutDir !== BUILD_DIR) {
		const references = await findOutDirReferences(dir, original, previousOutDir);
		plan.attention.push(
			`Build output moves from ${previousOutDir}/ to ${BUILD_DIR}/.` +
				(references.length > 0
					? ` Update these references to the old directory by hand: ${references.join(', ')}.`
					: '')
		);
	}

	pkg.scripts ??= {};
	for (const [name, command] of Object.entries(pkg.scripts)) {
		let steps = command.split('&&').map((step) => step.trim());
		steps = steps.map((step) => (/^(eslint( \.)?|oxlint)$/.test(step) ? LINT : step));
		if (name === 'check' && !/\boxfmt\b|\b(fmt|format):check\b/.test(command)) {
			const lintStep = steps.findIndex((step) => /^oxlint\b/.test(step));
			steps = steps.toSpliced(lintStep === -1 ? steps.length : lintStep + 1, 0, FORMAT_CHECK);
		}
		const migrated = steps.join(' && ');
		if (
			migrated !==
			command
				.split('&&')
				.map((step) => step.trim())
				.join(' && ')
		) {
			pkg.scripts[name] = migrated;
			plan.scripts.push(`${name}: "${command}" -> "${migrated}"`);
		}
		if (/\beslint\b/.test(migrated)) {
			plan.attention.push(`scripts.${name} still runs eslint with options ("${migrated}"). Update it by hand.`);
		}
	}
	const wantedScripts = {
		...FORMAT_SCRIPTS,
		...(style !== 'js' && { check: `tsc && ${LINT} && ${FORMAT_CHECK}` }),
		...(style !== 'js' && hasBuildConfig && { build: BUILD_SCRIPT })
	};
	const added = [];
	for (const [name, command] of Object.entries(wantedScripts)) {
		if (!(name in pkg.scripts)) {
			pkg.scripts[name] = command;
			added.push(name);
		}
	}
	if (added.length > 0) {
		plan.scripts.push(`add ${added.join(', ')}`);
	}

	if (JSON.stringify(pkg) !== JSON.stringify(original)) {
		plan.packageJson = serialize(packageSource, pkg);
	}
	if (hasChanges(plan)) {
		plan.attention.push(await ciReminder(dir, pkg.scripts));
	}
	return plan;
}

/**
 * @param {Plan} plan
 * @returns {boolean} whether applying the plan would change anything
 */
export const hasChanges = (plan) => plan.packageJson !== null || plan.writes.length > 0 || plan.deletes.length > 0;

/**
 * @param {string} line a plan line
 * @returns {'red' | 'yellow' | 'green' | null} the color for removals, changes and additions
 */
function lineColor(line) {
	const text = line.trimStart();
	if (/^(remove|delete|removes:|drops) /.test(text)) {
		return 'red';
	}
	if (/^(rewrite|changes:|moves:) /.test(text) || text.includes(' -> ')) {
		return 'yellow';
	}
	if (/^(add|create|adds:) /.test(text)) {
		return 'green';
	}
	return null;
}

/**
 * @param {Plan} plan
 * @param {{ color?: boolean }} [options] color defaults to whether stdout is a terminal that supports it
 * @returns {string} the plan as text for the terminal
 */
export function formatPlan(plan, { color } = {}) {
	/**
	 * @param {Parameters<typeof styleText>[0]} format
	 * @param {string} text
	 * @returns {string}
	 */
	const paint = (format, text) =>
		color === false ? text : styleText(format, text, { validateStream: color !== true });
	const sections = [
		['Dependencies (package.json)', plan.dependencies],
		['Files', plan.files],
		['Scripts (package.json)', plan.scripts]
	];
	const changes = sections
		.filter(([, lines]) => lines.length > 0)
		.map(([title, lines]) => {
			const body = lines.map((line) => {
				const text = line.startsWith(' ') ? line : `  - ${line}`;
				const format = lineColor(line);
				return format ? paint(format, text) : text;
			});
			return `${paint('bold', title)}\n${body.join('\n')}`;
		});
	const attention = formatAttention(plan, { color });
	return [...changes, ...(attention ? [attention] : [])].join('\n\n');
}

/**
 * @param {Plan} plan
 * @param {{ color?: boolean }} [options] color defaults to whether stdout is a terminal that supports it
 * @returns {string} the notes the user has to act on, or an empty string when there are none
 */
export function formatAttention(plan, { color } = {}) {
	if (plan.attention.length === 0) {
		return '';
	}
	const title = 'Needs your attention';
	const heading = color === false ? title : styleText(['bold', 'yellow'], title, { validateStream: color !== true });
	return `${heading}\n${plan.attention.map((line) => `  - ${line}`).join('\n')}`;
}

/**
 * @param {string} dir
 * @param {Plan} plan
 * @returns {Promise<void>}
 */
export async function applyPlan(dir, plan) {
	const writes =
		plan.packageJson === null ? plan.writes : [...plan.writes, { file: 'package.json', contents: plan.packageJson }];
	await Promise.all([
		...writes.map(({ file, contents }) => writeFile(path.join(dir, file), contents)),
		...plan.deletes.map((file) => rm(path.join(dir, file)))
	]);
}
