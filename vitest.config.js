import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import shared from './vitest.js';

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			exclude: [...configDefaults.exclude, 'test/fixtures/**']
		}
	})
);
