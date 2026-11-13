import { defineConfig } from 'oxlint';

import shared from './oxlint.js';

export default defineConfig({
	extends: [shared],
	overrides: [
		{
			files: ['bin/**'],
			rules: {
				'no-console': 'off'
			}
		}
	]
});
