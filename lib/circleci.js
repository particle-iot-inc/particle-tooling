import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const CIRCLECI_CONFIG = '.circleci/config.yml';
/** The commands that run the tests in CI: `npm test`, `npm run test...` and `npm run coverage...`. */
const TEST_COMMAND = /^npm (t|test|run (test|coverage)\S*)$/;
/** Keeps yq from warning about merge keys (`<<: *anchor`), which CircleCI configs use. Older yq versions lack it. */
const MERGE_FLAG = '--yaml-fix-merge-anchor-to-spec';

/**
 * @param {string} resultsPath
 * @returns {string} the step to add, indented as a list item under `steps:`
 */
const snippet = (resultsPath) => `      - store_test_results:\n          path: ${resultsPath}`;

/**
 * @param {string} reason why the config was not changed
 * @returns {string} an attention note with the step to add by hand
 */
const byHand = (reason) =>
	`${CIRCLECI_CONFIG} was not changed because ${reason}. Add this after the step that runs the tests in each test job, so CircleCI shows the results:\n${snippet('test-results')}`;

/**
 * @typedef {object} TestStep
 * @property {(string | number)[]} path where the steps list is in the config
 * @property {number} index the position of the test step in that list
 * @property {string} command
 * @property {string | undefined} workingDirectory the step's own working_directory
 * @property {boolean} stored whether the list already has a store_test_results step
 */

/**
 * @param {unknown} node the config, as parsed by yq
 * @param {(string | number)[]} at the path to node
 * @param {TestStep[]} found mutated with every test step under node
 */
function findTestSteps(node, at, found) {
	if (Array.isArray(node)) {
		node.forEach((child, index) => findTestSteps(child, [...at, index], found));
		return;
	}
	if (node === null || typeof node !== 'object') {
		return;
	}
	const steps = /** @type {Record<string, unknown>} */ (node).steps;
	if (Array.isArray(steps)) {
		const stored = steps.some((step) => step !== null && typeof step === 'object' && 'store_test_results' in step);
		for (const [index, step] of steps.entries()) {
			const runStep = step?.run;
			const command = typeof runStep === 'string' ? runStep : runStep?.command;
			if (typeof command === 'string' && TEST_COMMAND.test(command.trim())) {
				const workingDirectory = typeof runStep === 'object' ? runStep.working_directory : undefined;
				found.push({ path: [...at, 'steps'], index, command: command.trim(), workingDirectory, stored });
			}
		}
	}
	for (const [key, child] of Object.entries(node)) {
		findTestSteps(child, [...at, key], found);
	}
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number[]} [okCodes] exit codes besides 0 that are not failures
 * @returns {Promise<string>} stdout
 */
async function run(command, args, okCodes = []) {
	try {
		return (await execFile(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
	} catch (err) {
		if (okCodes.includes(err.code)) {
			return err.stdout;
		}
		err.tool = command;
		throw err;
	}
}

/**
 * @param {any} err a failure from run
 * @returns {string} which tool failed and the first line of what it said
 */
const failure = (err) => {
	const said = String(err?.stderr || err?.message || err)
		.trim()
		.split('\n')[0];
	return `${err?.tool ?? 'a tool it runs'} failed while preparing the edit${said ? ` (${said})` : ''}`;
};

/**
 * @returns {Promise<string | null>} why the tools the edit needs cannot be used, or null when they can
 */
async function missingTools() {
	const missing = [];
	try {
		const version = await run('yq', ['--version']);
		if (!/mikefarah/.test(version) || !/version v?4\./.test(version)) {
			return `the yq on PATH is not mikefarah yq version 4 (${version.trim()})`;
		}
	} catch {
		missing.push('yq');
	}
	for (const tool of ['diff', 'patch']) {
		try {
			// oxlint-disable-next-line no-await-in-loop
			await run(tool, ['--version']);
		} catch (err) {
			if (err.code === 'ENOENT') {
				missing.push(tool);
			}
		}
	}
	return missing.length > 0 ? `${new Intl.ListFormat('en').format(missing)} could not be found on PATH` : null;
}

/**
 * @param {(string | number)[]} at
 * @returns {string} a yq path expression
 */
const yqPath = (at) => at.map((key) => (typeof key === 'number' ? `[${key}]` : `[${JSON.stringify(key)}]`)).join('');

/**
 * Plans adding `store_test_results` after the test step of the CircleCI config. The edit is made with yq, and only
 * the lines it adds are patched into the original, so the rest of the file keeps its formatting: yq on its own drops
 * blank lines and reformats flow sequences and some block scalars.
 * @param {string} dir
 * @returns {Promise<{ write?: { file: string, contents: string }, line?: string, attention?: string }>}
 */
export async function planCircleci(dir) {
	let original;
	try {
		original = await readFile(path.join(dir, CIRCLECI_CONFIG), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') {
			return {};
		}
		throw err;
	}
	const unavailable = await missingTools();
	if (unavailable !== null) {
		return { attention: byHand(unavailable) };
	}

	const scratch = await mkdtemp(path.join(tmpdir(), 'particle-tooling-circleci-'));
	try {
		const source = path.join(scratch, 'config.yml');
		await writeFile(source, original);
		let help;
		try {
			help = await run('yq', ['--help']);
		} catch (err) {
			return { attention: byHand(failure(err)) };
		}
		const flags = help.includes(MERGE_FLAG) ? [MERGE_FLAG] : [];
		/**
		 * @param {string} expression
		 * @param {string} file
		 * @param {string[]} [extra]
		 * @returns {Promise<string>}
		 */
		const yq = (expression, file, extra = []) => run('yq', [...flags, ...extra, expression, file]);

		let parsed;
		try {
			parsed = JSON.parse(await yq('.', source, ['-o=json']));
		} catch (err) {
			return { attention: byHand(`yq could not read it (${failure(err)})`) };
		}
		/** @type {TestStep[]} */
		const found = [];
		findTestSteps(parsed, [], found);
		if (found.length === 0) {
			return { attention: byHand('no step runs "npm test", "npm run test..." or "npm run coverage"') };
		}
		if (found.length > 1) {
			return {
				attention: byHand(`several steps run the tests (${found.map((step) => `"${step.command}"`).join(', ')})`)
			};
		}
		const [step] = found;
		if (step.stored) {
			return {};
		}
		const directory = step.workingDirectory?.replace(/\/+$/, '');
		const resultsPath = directory && directory !== '.' ? `${directory}/test-results` : 'test-results';
		const insert = JSON.stringify({ store_test_results: { path: resultsPath } });
		const list = `.${yqPath(step.path)}`;
		const after = step.index + 1;
		const expression = `${list} |= .[:${after}] + [${insert}] + .[${after}:]`;

		const noop = path.join(scratch, 'noop.yml');
		const edited = path.join(scratch, 'edited.yml');
		const patchFile = path.join(scratch, 'edit.patch');
		try {
			await writeFile(noop, await yq('.', source));
			await writeFile(edited, await yq(expression, source));
			await writeFile(patchFile, await run('diff', ['-B', '-U3', noop, edited], [1]));
		} catch (err) {
			return { attention: byHand(failure(err)) };
		}
		try {
			await run('patch', ['-s', '-f', '-i', patchFile, source]);
		} catch {
			return { attention: byHand('the edit could not be applied without reformatting the file') };
		}
		const contents = await readFile(source, 'utf8');
		let result;
		let expected;
		try {
			[result, expected] = await Promise.all([yq('.', source, ['-o=json']), yq('.', edited, ['-o=json'])]);
		} catch (err) {
			return { attention: byHand(failure(err)) };
		}
		if (result !== expected) {
			return { attention: byHand('the edit could not be applied without reformatting the file') };
		}
		const name = typeof step.path.at(-2) === 'string' ? ` of job ${step.path.at(-2)}` : '';
		return {
			write: { file: CIRCLECI_CONFIG, contents },
			line: `add store_test_results (path ${resultsPath}) after "${step.command}"${name} in ${CIRCLECI_CONFIG}`
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
