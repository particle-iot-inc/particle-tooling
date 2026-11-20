import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const SHARED_VITEST = '@particle/tooling/vitest';

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const VITEST_CONFIGS = EXTENSIONS.map((extension) => `vitest.config.${extension}`);
const VITE_CONFIGS = EXTENSIONS.map((extension) => `vite.config.${extension}`);
const LOCAL_NAME = 'shared';

/**
 * @param {string} source
 * @param {number} index position of a quote, backtick or the slash that starts a comment
 * @returns {number} the position just after the string or comment that starts there, or -1 when it is not closed
 */
function skipLiteral(source, index) {
	const start = source[index];
	if (start === '/') {
		if (source[index + 1] === '/') {
			const end = source.indexOf('\n', index);
			return end === -1 ? source.length : end;
		}
		const end = source.indexOf('*/', index + 2);
		return end === -1 ? -1 : end + 2;
	}
	for (let position = index + 1; position < source.length; position++) {
		if (source[position] === '\\') {
			position++;
		} else if (source[position] === start) {
			return position + 1;
		}
	}
	return -1;
}

/**
 * @param {string} char
 * @param {string | undefined} next the character after it
 * @returns {boolean} whether a string or comment starts here
 */
const startsLiteral = (char, next) =>
	char === '"' || char === "'" || char === '`' || (char === '/' && (next === '/' || next === '*'));

/**
 * @param {string} source
 * @returns {boolean} whether a template literal in the source spans lines, so re-indenting would change its value
 */
function hasMultilineTemplate(source) {
	for (let position = 0; position < source.length; position++) {
		if (startsLiteral(source[position], source[position + 1])) {
			const next = skipLiteral(source, position);
			if (next === -1 || (source[position] === '`' && source.slice(position, next).includes('\n'))) {
				return true;
			}
			position = next - 1;
		}
	}
	return false;
}

/**
 * @param {string} source
 * @param {number} open position of an opening parenthesis
 * @returns {number} the position of the parenthesis that closes it, or -1. Skips strings and comments.
 */
function closingParen(source, open) {
	let depth = 0;
	for (let position = open; position < source.length; position++) {
		const char = source[position];
		if (startsLiteral(char, source[position + 1])) {
			const next = skipLiteral(source, position);
			if (next === -1) {
				return -1;
			}
			position = next - 1;
		} else if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth--;
			if (depth === 0) {
				return position;
			}
		}
	}
	return -1;
}

/**
 * Wraps a Vitest config whose default export is `defineConfig({...})` with `mergeConfig(shared, ...)`.
 * @param {string} source the config file contents
 * @returns {{ source: string } | { reason: string }} the rewritten config, or why it cannot be rewritten safely
 */
export function wrapVitestConfig(source) {
	if (/\bmodule\.exports\b|\brequire\(/.test(source)) {
		return { reason: 'it is a CommonJS module' };
	}
	if (new RegExp(`\\b${LOCAL_NAME}\\b`).test(source)) {
		return { reason: `it already uses the name "${LOCAL_NAME}"` };
	}
	const exports = [...source.matchAll(/\bexport\s+default\b/g)];
	const call = /\bexport\s+default\s+(defineConfig)\s*\(/.exec(source);
	if (exports.length !== 1 || call === null) {
		return { reason: 'its default export is not a defineConfig({...}) call' };
	}
	const callStart = call.index + call[0].indexOf(call[1]);
	const open = call.index + call[0].length - 1;
	const close = closingParen(source, open);
	if (close === -1 || !/^[ \t]*(;|\r?\n|$)/.test(source.slice(close + 1))) {
		return { reason: 'its default export is not a defineConfig({...}) call' };
	}
	const argument = source.slice(open + 1, close);
	if (!argument.trimStart().startsWith('{')) {
		return { reason: 'it passes defineConfig a function or a variable, which mergeConfig cannot merge' };
	}
	const imported = /import\s*\{([^}]*)\}\s*from\s*(['"])(vitest\/config|vite)\2/.exec(source);
	const names = imported?.[1]
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '');
	if (imported === null || !names?.includes('defineConfig')) {
		return { reason: 'it does not import defineConfig from vitest/config' };
	}

	const indent = /^[ \t]+/m.exec(source)?.[0] ?? '\t';
	const body = hasMultilineTemplate(argument)
		? argument
		: argument
				.split('\n')
				.map((line, index) => (index === 0 || line === '' ? line : `${indent}${line}`))
				.join('\n');
	const wrapped = `mergeConfig(\n${indent}${LOCAL_NAME},\n${indent}defineConfig(${body})\n)`;
	const quote = imported[2];
	const specifiers = names.includes('mergeConfig')
		? names
		: [...names, 'mergeConfig'].toSorted((a, b) => a.localeCompare(b, 'en'));
	const importLine =
		`import ${LOCAL_NAME} from ${quote}${SHARED_VITEST}${quote};\n` +
		`import { ${specifiers.join(', ')} } from ${quote}${imported[3]}${quote}`;
	return {
		source:
			source.slice(0, imported.index) +
			importLine +
			source.slice(imported.index + imported[0].length, callStart) +
			wrapped +
			source.slice(close + 1)
	};
}

/**
 * Plans the project's Vitest config: wraps the existing one with the shared config, or creates one.
 * @param {string} dir
 * @param {string} configExtension the extension for a new config, `ts` or `mts`
 * @returns {Promise<{ write?: { file: string, contents: string }, line?: string, attention?: string }>}
 */
export async function planVitestConfig(dir, configExtension) {
	const configs = VITEST_CONFIGS.filter((file) => existsSync(path.join(dir, file)));
	if (configs.length > 1) {
		return {
			attention: `There are several Vitest configs (${configs.join(', ')}), so none was changed. Merge ${SHARED_VITEST} into the one Vitest uses: see the README.`
		};
	}
	if (configs.length === 0) {
		const vite = VITE_CONFIGS.find((file) => existsSync(path.join(dir, file)));
		if (vite !== undefined) {
			return {
				attention: `Vitest reads its settings from ${vite}, so no vitest.config was created. Merge ${SHARED_VITEST} into it: see the README.`
			};
		}
		const file = `vitest.config.${configExtension}`;
		return {
			write: { file, contents: `export { default } from '${SHARED_VITEST}';\n` },
			line: `create ${file}`
		};
	}
	const [file] = configs;
	const source = await readFile(path.join(dir, file), 'utf8');
	if (source.includes(SHARED_VITEST)) {
		return {};
	}
	const result = wrapVitestConfig(source);
	if ('reason' in result) {
		return {
			attention: `${file} was left alone because ${result.reason}. Merge ${SHARED_VITEST} into it by hand: see the README.`
		};
	}
	return {
		write: { file, contents: result.source },
		line: `rewrite ${file} to merge ${SHARED_VITEST} (JUnit test results in CircleCI)`
	};
}
