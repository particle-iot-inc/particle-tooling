import base from '@particle/tooling/oxlint';
import shared from '@particle/tooling/oxlint-typescript';
import { defineConfig } from 'oxlint';

export const javascript = defineConfig({ extends: [base] });

export default defineConfig({
	extends: [shared],
	rules: { 'no-console': 'off' }
});
