/**
 * The Vitest config published as `@particle/tooling/vitest`. Merge it under the project's own config with `mergeConfig`.
 *
 * In CircleCI it adds a JUnit report at `test-results/junit.xml` next to the default console output, for
 * `store_test_results`. `addFileAttribute` gives each test case the `file` attribute CircleCI uses for timing data.
 * Anywhere else it sets nothing, so a local run keeps Vitest's default reporter and writes no file.
 */
export default process.env.CIRCLECI
	? {
			test: {
				reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml', addFileAttribute: true }]]
			}
		}
	: {};
