# Shared tooling config for Particle

Shared [oxlint](https://oxc.rs/docs/guide/usage/linter.html), [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) and TypeScript configuration for Particle projects.

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
- **`.gitignore`:** adds `.claude/`, so agent worktrees (full copies of the repo) are not linted and formatted along with the project. oxlint and oxfmt only skip what the project's own `.gitignore` lists, not a global gitignore.
- **Build output:** standardizes on `build/`, adds it to `.gitignore`, and lists every place that still names the old directory (`package.json` fields, scripts, `Dockerfile`, CI config) for you to update.
- **Scripts:** removes a `lint` script and has `check` do the linting: plain `eslint` steps become `oxlint --deny-warnings` (so a warning fails the check, in CI too), `check` gains `oxfmt --check`, and other scripts that ran `npm run lint` are pointed at `npm run check`. Adds `fmt` where it is missing, a `check` for TypeScript projects (`tsc && oxlint --deny-warnings && oxfmt --check`) and for JavaScript projects that had a `lint` script, and `build` for TypeScript projects.
- **CI:** looks at `.circleci/config.yml` and `.github/workflows` and reminds you to confirm that CI runs a step that checks formatting.
- **Install:** runs `npm install` at the end.

Anything it cannot decide for you is listed under "Needs your attention", before you confirm and again at the end.

Options:

| Option         | Effect                                                |
| -------------- | ----------------------------------------------------- |
| `--style`      | Skip the style question                               |
| `--yes`, `-y`  | Apply without asking. Required when not in a terminal |
| `--no-install` | Skip `npm install`                                    |

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

A JavaScript project has one file. It covers the whole project unless `include` narrows it:

```jsonc
// tsconfig.json
{ "extends": "@particle/tooling/tsconfig/js.json" }
```

## Development

```shell
$ npm run check   # lint and format check
$ npm test
```

To try local changes in another project, pack this one and point the migration at the tarball:

```bash
$ npm pack
$ cd ../api-service
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
