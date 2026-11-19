#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { applyPlan, createPlan, detectStyle, formatAttention, formatPlan, hasChanges, STYLES } from '../lib/migrate.js';

const styleNames = Object.keys(STYLES);

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
	console.error(message);
	process.exit(1);
}

/**
 * @param {import('node:readline/promises').Interface} prompt
 * @param {string} question
 * @returns {Promise<string>} the trimmed answer. Exits when the prompt is closed with Ctrl+D.
 */
async function ask(prompt, question) {
	try {
		return (await prompt.question(question)).trim();
	} catch (err) {
		if (err.code === 'ABORT_ERR') {
			process.exit(1);
		}
		throw err;
	}
}

/**
 * @param {import('node:readline/promises').Interface} prompt
 * @param {string} detected the style offered as the default
 * @returns {Promise<string>} the chosen style, which may not be a valid one
 */
async function askStyle(prompt, detected) {
	console.log('What kind of project is this?');
	for (const [index, name] of styleNames.entries()) {
		console.log(`  ${index + 1}) ${name}: ${STYLES[name]}${name === detected ? ' (detected)' : ''}`);
	}
	const fallback = styleNames.indexOf(detected) + 1;
	const answer = (await ask(prompt, `Style (1-${styleNames.length}) [${fallback}]: `)) || String(fallback);
	return styleNames[Number(answer) - 1] ?? answer;
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {Promise<number>} the exit code of npm
 */
function npm(dir, args) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const child = spawn('npm', args, { cwd: dir, stdio: 'inherit' });
	child.on('error', reject);
	child.on('close', resolve);
	return promise;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			style: { type: 'string' },
			yes: { type: 'boolean', short: 'y', default: false },
			install: { type: 'boolean', default: true },
			'tooling-spec': { type: 'string' }
		},
		allowNegative: true
	});
	const dir = process.cwd();
	if (!existsSync(path.join(dir, 'package.json'))) {
		fail('No package.json here. Run this from the root of the project to migrate.');
	}
	const interactive = process.stdin.isTTY === true;
	if (!interactive && (!values.style || !values.yes)) {
		fail(`Pass --style and --yes when not running interactively. Styles: ${styleNames.join(', ')}`);
	}
	const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
	try {
		const style = values.style ?? (await askStyle(prompt, await detectStyle(dir)));
		if (!Object.hasOwn(STYLES, style)) {
			fail(`Unknown style "${style}". Expected one of: ${styleNames.join(', ')}`);
		}
		const plan = await createPlan(dir, style, { toolingSpec: values['tooling-spec'] });
		if (!hasChanges(plan)) {
			console.log('Nothing to change: this project is already set up.');
			if (plan.attention.length > 0) {
				console.log(`\n${formatPlan(plan)}`);
			}
			process.exit(0);
		}
		console.log(`\nMigrating ${path.basename(dir)} as a ${STYLES[style]}. Nothing has been changed yet.\n`);
		console.log(formatPlan(plan));
		const uninstall = values.install && plan.uninstall.length > 0 ? ['uninstall', ...plan.uninstall] : null;
		if (uninstall) {
			console.log(`\nFirst: npm ${uninstall.join(' ')} (before the changes above, so the lockfile drops them)`);
		}
		console.log(values.install ? `${uninstall ? '' : '\n'}Then: npm install\n` : '');
		if (!values.yes && !/^y(es)?$/i.test(await ask(prompt, 'Apply these changes? [y/N] '))) {
			fail('No changes made.');
		}
		if (uninstall && (await npm(dir, uninstall)) !== 0) {
			fail('npm uninstall failed. Nothing else was changed: fix the error and run the migration again.');
		}
		await applyPlan(dir, plan);
		console.log('Changes applied.');
		if (!values.install && plan.uninstall.length > 0) {
			console.log(
				`npm was not run. The lockfile still lists ${plan.uninstall.join(', ')}. If npm install fails with ERESOLVE naming one of them, run npm install --force once: they are no longer in package.json, so the forced install prunes them.`
			);
		}
		if (values.install) {
			const code = await npm(dir, ['install']);
			if (code !== 0) {
				fail(
					'npm install failed. The file changes above are in place. See "If an install fails" in the README (https://github.com/particle-iot/particle-tooling#if-an-install-fails) for the known causes, then run npm install again.'
				);
			}
		}
		if (plan.attention.length > 0) {
			console.log(`\n${formatAttention(plan)}`);
		}
	} finally {
		prompt?.close();
	}
}
