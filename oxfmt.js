/** The oxfmt config published as `@particle/tooling/oxfmt`. */
import { defineConfig } from 'oxfmt';

export default defineConfig({
	useTabs: true,
	singleQuote: true,
	sortImports: {},
	trailingComma: 'none',
	printWidth: 120
});
