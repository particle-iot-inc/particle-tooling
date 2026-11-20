# Shared tooling config for Particle

Shared [oxlint](https://oxc.rs/docs/guide/usage/linter.html), [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html), TypeScript and [Vitest](https://vitest.dev/) configuration for Particle projects.

## Usage

Run the migration from the root of the project. It does not need the package installed first:

```shell
$ npx @particle/tooling
```

It asks what kind of project this is (or takes `--style`), prints everything it is going to change, and waits for confirmation before touching anything.

| Style        | Project                                     |
| ------------ | ------------------------------------------- |
| `js`         | JavaScript project                          |
| `ts-service` | TypeScript service                          |
| `ts-library` | TypeScript library, built with declarations |

What it does, depending on what it finds:

- **Dependencies:** removes ESLint and its configs and plugins, adds `@particle/tooling` (which installs `oxlint`, `oxfmt` and `oxlint-tsgolint` as peers), and moves `typescript` to version 7.
- **Lint and format configs:** deletes `eslint.config.*`, `.eslintrc*`, `.oxlintrc.json` and `.oxfmtrc.json`, and creates `oxlint.config.ts` and `oxfmt.config.ts` that re-export the shared configs. In a package that is not an ES module (no `"type": "module"`), the files are `.mts`, and existing `.ts` ones are renamed: Node only loads a `.ts` config as an ES module in an ES module package, and otherwise warns or fails. TypeScript projects re-export `@particle/tooling/oxlint-typescript`, JavaScript projects `@particle/tooling/oxlint`.
- **tsconfigs:** rewrites `tsconfig.json` and `tsconfig.build.json` to extend the shared configs, keeping the project's own `include`, `exclude` and `types`. A config with other project-specific compiler options, or one that already extends something else, is left alone and reported for you to migrate by hand.
- **Sentry:** when the project depends on a `@sentry/*` package, the build config gets `"sourceRoot": "/"`, which strips the build path from source references so Sentry groups issues consistently. Without Sentry it is removed, because it makes Node stack traces point at paths that do not exist.
- **`.gitignore`:** adds `.claude/` and `CLAUDE.md`. These are often ignored only in a developer's global gitignore, and oxlint and oxfmt only skip what the project's own `.gitignore` lists. Without the entries, agent worktrees (full copies of the repo) get linted and formatted along with the project, and a local `CLAUDE.md` fails the format check on one machine but not in CI.
- **Build output:** standardizes on `build/`, adds it to `.gitignore`, and lists every place that still names the old directory (`package.json` fields, scripts, `Dockerfile`, CI config) for you to update.
- **Scripts:** removes a `lint` script and has `check` do the linting: plain `eslint` steps become `oxlint --deny-warnings` (so a warning fails the check, in CI too), `check` gains `oxfmt --check`, and other scripts that ran `npm run lint` are pointed at `npm run check`. Adds `fmt` where it is missing, a `check` for TypeScript projects (`tsc && oxlint --deny-warnings && oxfmt --check`) and for JavaScript projects that had a `lint` script, and `build` for TypeScript projects.
- **Vitest:** in a project that depends on `vitest`, wraps the `export default defineConfig({...})` in `vitest.config.*` with `mergeConfig` and the [shared Vitest config](#vitest-config), or creates a `vitest.config.ts` (`.mts` outside an ES module package) that re-exports it. A config it cannot rewrite safely, such as one that passes `defineConfig` a function, is left alone and reported. Adds `test-results/` to `.gitignore`.
- **CircleCI test results:** in a project that depends on `vitest`, adds a `store_test_results` step after the step in `.circleci/config.yml` that runs `npm test`, `npm run test…` or `npm run coverage`, in a top-level job or an inline orb's job. A test step with its own `working_directory` gets it in the stored path. The edit is made with [yq](https://github.com/mikefarah/yq) (version 4), and only the lines it adds are patched into the file with `diff` and `patch`, so the rest of the file keeps its formatting. Without those tools, with no test step or several, or when the edit would touch a line yq reformats, the file is left alone and the step to add is printed instead.
- **CI:** looks at `.circleci/config.yml` and `.github/workflows` and reminds you to confirm that CI runs a step that checks formatting.
- **Install:** runs `npm uninstall` for the removed packages before changing anything, then `npm install` at the end. The uninstall comes first so the lockfile drops typescript-eslint, which does not accept TypeScript 7 and would otherwise make `npm install` fail with `ERESOLVE`. Other conflicts can still stop the install: see [If an install fails](#if-an-install-fails).
- **TypeScript 7 conflicts:** before you confirm, lists any remaining dependency whose locked version does not accept TypeScript 7, such as an older `typedoc`.

Anything it cannot decide for you is listed under "Needs your attention", before you confirm and again at the end.

Options:

| Option         | Effect                                                |
| -------------- | ----------------------------------------------------- |
| `--style`      | Skip the style question                               |
| `--yes`, `-y`  | Apply without asking. Required when not in a terminal |
| `--no-install` | Skip `npm uninstall` and `npm install`                |

### If an install fails

The file changes are already in place when `npm install` fails, so fix the cause and run `npm install` again. The known causes:

- **`ERESOLVE` naming typescript-eslint:** the lockfile still lists the removed ESLint packages. This happens with `--no-install`, or with a version of this package before 0.1.9. Run `npm install --force` once. The conflict is between packages that are no longer in `package.json`, so the forced install prunes them and leaves a valid tree. A plain `npm install` works after that.
- **`ERESOLVE` naming another package's `typescript` range:** a remaining dependency does not support TypeScript 7. The plan lists these under "Needs your attention". Upgrade or remove that dependency.
- **`ERESOLVE` naming `vitest` through `vite-plus` or `@vitest/browser-playwright`:** npm 10 mishandles a chain of optional peer dependencies when the lockfile pins an older vitest 3 patch. Run the install once with npm 11 (`npx npm@11 install`), or bump `vitest` and `@vitest/coverage-v8` to the latest 3.x first. npm 10 installs from the resulting lockfile without trouble.
- **`Cannot read properties of null (reading 'edgesOut')`:** an npm 10 bug ([npm/cli#9787](https://github.com/npm/cli/issues/9787)) that `oxfmt` and vitest 4 together trigger when npm resolves without a lockfile, or on `npm update`. Do not delete `package-lock.json` to get past an install error. If it is already gone, regenerate it with npm 11.6 or later (`npx npm@11 install`). npm 10 installs from that lockfile without trouble.

After migrating, format the project once and commit that separately:

```shell
$ npm run fmt
$ npm run check
```

The config files are TypeScript, which requires Node 22.23.4 or later.

## Lint configs

| Config                                | Use                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@particle/tooling/oxlint`            | JavaScript projects                                                                       |
| `@particle/tooling/oxlint-typescript` | TypeScript projects: the same rules plus the TypeScript rules, with type-aware linting on |

Type-aware rules such as `no-floating-promises` run through `oxlint-tsgolint`, which is installed as a peer dependency, and need a `tsconfig.json`. Only the typed rules named in `oxlint-typescript.js` are enforced. The other typed rules in the enabled categories are switched off there, and a project can turn one on in its own config.

## Overriding

Replace the re-export with a config that builds on the shared one.

```ts
// oxlint.config.ts
import shared from '@particle/tooling/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
	extends: [shared],
	rules: { 'no-console': 'off' }
});
```

oxfmt has no `extends`, so spread the shared options. The merge is shallow: nested options such as `sortImports` are replaced as a whole.

```ts
// oxfmt.config.ts
import shared from '@particle/tooling/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({ ...shared, printWidth: 120 });
```

## TypeScript configs

`typescript` is an optional peer dependency. The configs target TypeScript 7, so install it in projects that use them:

```shell
$ npm install --save-dev typescript@^7
```

| Config                                             | Use                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@particle/tooling/tsconfig/js.json`               | JavaScript projects, with `checkJs` off                                         |
| `@particle/tooling/tsconfig/ts.json`               | Type checking for TypeScript projects: `src` and `test`, no emit                |
| `@particle/tooling/tsconfig/ts-build.json`         | Building TypeScript services: `src` without tests, to `build/`                  |
| `@particle/tooling/tsconfig/ts-build-library.json` | Building TypeScript libraries: the same, with declarations and declaration maps |

A TypeScript project has two files. A library extends `ts-build-library.json` in the second one:

```jsonc
// tsconfig.json
{ "extends": "@particle/tooling/tsconfig/ts.json" }
```

```jsonc
// tsconfig.build.json
{ "extends": "@particle/tooling/tsconfig/ts-build.json" }
```

`ts.json` sets `module` to `NodeNext`, so the output is CommonJS or ES modules according to `type` in the project's `package.json`.

`tsconfig.build.json` does not inherit from the project's `tsconfig.json`. A compiler option overridden there has to be repeated in `tsconfig.build.json` if the build needs it.

### Libraries: publish `src` with `build`

`ts-build-library.json` emits declaration maps, which point from each `.d.ts` file back to the `.ts` file it came from. For those to work in a consuming project, publish the source alongside the build output:

```json
{
	"files": ["build/", "src/", "!**/*.test.ts"]
}
```

With `src` in the package, "go to definition" in an editor opens the real TypeScript source. Without it, the map points at a file that is not there and the editor falls back to the declaration file.

A JavaScript project has one file. It covers the whole project unless `include` narrows it:

```jsonc
// tsconfig.json
{ "extends": "@particle/tooling/tsconfig/js.json" }
```

## Vitest config

`@particle/tooling/vitest` reports test results to CircleCI. Merge it under the project's own Vitest config:

```ts
// vitest.config.ts
import shared from '@particle/tooling/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
	shared,
	defineConfig({
		test: { setupFiles: ['./src/test-setup.ts'] }
	})
);
```

When `CIRCLECI` is set, it keeps the default console reporter and adds Vitest's JUnit reporter, writing `test-results/junit.xml` with a `file` attribute on each test case (CircleCI uses it for timing data). Anything a test logs goes into the report too. Anywhere else it sets nothing, so local runs are unchanged and write no file. It applies whichever npm script CI runs.

Add `test-results/` to `.gitignore`, so oxlint and oxfmt skip the report, and store it after the test step in each CircleCI test job:

```yaml
- run: npm test
- store_test_results:
    path: test-results
```

`vitest` is an optional peer dependency, from version 3.2. A project that sets its own `reporters` gets them in addition to these: `mergeConfig` concatenates arrays.

## Development

```shell
$ npm run check   # lint and format check
$ npm test
```

The CircleCI migration tests need [yq](https://github.com/mikefarah/yq) version 4 on `PATH`, and are skipped without it.

To try local changes in another project, pack this one and point the migration at the tarball:

```bash
$ npm pack
$ cd ../my-service
$ node ../particle-tooling/bin/init.js --tooling-spec file:../particle-tooling/particle-tooling-0.1.0.tgz
```

## Pre-releasing

To use a new config in a PR for another service, publish a pre-release. Don't forget to update your PR with the released version before merging!

1. Run `npm version <premajor|preminor|prepatch>`
   - For subsequent pre-releases on the same feature branch, run `npm version prerelease` to increment the pre-release number
2. Push to origin `git push --follow-tags`
3. CircleCI will publish the npm package to the `beta` tag
4. Point your PR to the new version `npm install --save-dev @particle/tooling@beta`

## Releasing changes

1. Merge your changes to main and be on `main`
2. Run `npm version <major|minor|patch>`
3. Push to origin `git push --follow-tags`
4. CircleCI will publish the npm package to the `latest` tag
5. Point your project to the new version `npm install --save-dev @particle/tooling@latest`
