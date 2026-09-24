import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The structural gate, tested against trees that should fail it.
 *
 * A gate is only as good as the violations it actually rejects, and the
 * repository's own tree is healthy — so testing the gate against itself could
 * never do more than assert it is quiet. Each case here builds a tree with one
 * defect and asserts the gate names it, which is the only evidence that the
 * freeze protects anything at all.
 */

/** pnpm's package globs, as `pnpm-workspace.yaml` states them. */
const WORKSPACE = 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "tools/*"\n'

/** A two-package workspace plus the browser app: legal in every respect. */
function healthy() {
  return {
    'pnpm-workspace.yaml': WORKSPACE,
    'package.json': JSON.stringify({
      name: 'root',
      private: true,
      scripts: {
        dev: 'pnpm --fail-if-no-match --filter @archava/web dev',
        start: 'pnpm --fail-if-no-match --filter @archava/web start',
        build: 'pnpm --fail-if-no-match --filter @archava/web... build',
        'build:web': 'pnpm --fail-if-no-match --filter @archava/web build',
        'typecheck:web': 'pnpm --fail-if-no-match --filter @archava/web exec tsc --noEmit',
      },
    }),
    'packages/core/package.json': JSON.stringify({
      name: '@archava/core',
      version: '0.0.0',
      main: './src/index.ts',
    }),
    'packages/core/src/index.ts': 'export const core = true\n',
    'packages/adapters/package.json': JSON.stringify({
      name: '@archava/adapters',
      version: '0.0.0',
      main: './src/index.ts',
      dependencies: { '@archava/core': 'workspace:*' },
    }),
    // The legal shape: a declared neighbour, imported by its package name.
    'packages/adapters/src/index.ts':
      "import { core } from '@archava/core'\nexport const adapters = core\n",
    'packages/adapters/test/index.test.ts':
      "import { adapters } from '@archava/core'\nimport { adapters as local } from '../src/index.js'\nexport const unused = [adapters, local]\n",
    'apps/web/package.json': JSON.stringify({
      name: '@archava/web',
      version: '0.0.0',
      private: true,
      scripts: { dev: 'tsx src/server.ts', start: 'node server.js', build: 'tsx src/server.ts' },
      dependencies: { '@archava/adapters': 'workspace:*', '@archava/core': 'workspace:*' },
    }),
    'apps/web/src/main.ts':
      "import { adapters } from '@archava/adapters'\nexport const main = adapters\n",
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const GATE = path.resolve(HERE, '..', 'structure.mjs')

/** The gate as a subprocess, against a tree the caller built. */
function runStructure(directory: string): { code: number; stdout: string; stderr: string } {
  const ran = spawnSync(process.execPath, [GATE, directory], { encoding: 'utf8', cwd: REPO_ROOT })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/** A throwaway workspace, torn down by the returned `done`. */
function fixtureTree(files: Readonly<Record<string, string>>): { root: string; done: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'archava-structure-'))
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

const open = new Set<ReturnType<typeof fixtureTree>>()

afterEach(() => {
  for (const tree of open) tree.done()
  open.clear()
})

/** Assert that the tree with one file replaced fails, and says why. */
function rejectsOne(
  override: Record<string, string>,
  expected: readonly (string | RegExp)[],
): string {
  const tree = fixtureTree({ ...healthy(), ...override })
  open.add(tree)
  const result = runStructure(tree.root)
  expect(result.code, `expected exit 1, got ${result.code}\n${result.stdout}${result.stderr}`).toBe(
    1,
  )
  const report = result.stdout + result.stderr
  for (const needle of expected) {
    expect(report).toContain(needle)
  }
  return report
}

describe('the structural gate', () => {
  it('passes a workspace whose imports are all declared', () => {
    const tree = fixtureTree(healthy())
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('every @archava/* import declared')
  })

  it('rejects an @archava/* import the package never declared', () => {
    // The alias table in `vitest.config.ts` resolves this happily, and the
    // lockfile records no absence, so without this check the boundary would
    // only ever fail in whatever tool loaded the package next.
    const report = rejectsOne(
      {
        'packages/adapters/src/index.ts':
          "import { core } from '@archava/core'\nimport { pricing } from '@archava/pricing'\nexport const adapters = [core, pricing]\n",
      },
      ['@archava/pricing'],
    )
    expect(report).toContain('@archava/adapters does not declare')
  })

  it('rejects an undeclared import even when it only appears in a test', () => {
    rejectsOne(
      {
        'packages/adapters/test/index.test.ts':
          "import { pricing } from '@archava/pricing'\nexport const unused = pricing\n",
      },
      ['@archava/pricing'],
    )
  })

  it('rejects a relative import that reaches into another package', () => {
    rejectsOne(
      {
        'packages/adapters/src/index.ts':
          "import { core } from '../../../core/src/index.js'\nexport const adapters = core\n",
      },
      ['resolves outside its own package'],
    )
  })

  it('rejects a dynamic import of an undeclared package', () => {
    // An `import()` of a neighbour breaks exactly as hard as a static one and
    // is harder to catch by eye, so the gate reads both.
    rejectsOne(
      {
        'packages/adapters/src/index.ts':
          "export const adapters = { load: () => import('@archava/pricing') }\n",
      },
      ['@archava/pricing'],
    )
  })

  it('rejects a vanished browser app', () => {
    // Nothing in `pnpm test` imports `apps/web`, so its deletion would leave
    // every other gate green: this is the claim that notices.
    const files = healthy()
    const withoutApp: Record<string, string> = files
    delete withoutApp['apps/web/package.json']
    delete withoutApp['apps/web/src/main.ts']
    const tree = fixtureTree(withoutApp)
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('`@archava/web` is not a workspace project')
  })

  it('rejects a browser app that cannot be run', () => {
    const files = healthy()
    files['apps/web/package.json'] = JSON.stringify({
      name: '@archava/web',
      version: '0.0.0',
      private: true,
      scripts: { build: 'tsx src/server.ts' },
    })
    const tree = fixtureTree(files)
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code).toBe(1)
    const report = result.stdout + result.stderr
    expect(report).toContain('`dev` script')
    expect(report).toContain('`start` script')
  })

  it('rejects a web-targeting root script that dropped --fail-if-no-match', () => {
    // pnpm exits 0 when a filter matches nothing, so the flag is the only thing
    // standing between "the app is gone" and a silently green build.
    const files = healthy()
    files['package.json'] = JSON.stringify({
      name: 'root',
      private: true,
      scripts: { build: 'pnpm --filter @archava/web... build' },
    })
    const tree = fixtureTree(files)
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('--fail-if-no-match')
  })

  it('rejects a root script filtering a project that does not exist', () => {
    const files = healthy()
    files['package.json'] = JSON.stringify({
      name: 'root',
      private: true,
      scripts: { build: 'pnpm --fail-if-no-match --filter @archava/vanished build' },
    })
    const tree = fixtureTree(files)
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain(
      '`@archava/vanished`, which is not a workspace project',
    )
  })

  it('rejects a workspace the manifest globs no longer describe', () => {
    // Globs dropping `apps/*` removes the browser app from the project set even
    // though its directory is right where it was.
    const files = healthy()
    const withoutGlob: Record<string, string> = files
    delete withoutGlob['apps/web/package.json']
    delete withoutGlob['apps/web/src/main.ts']
    withoutGlob['pnpm-workspace.yaml'] = 'packages:\n  - "packages/*"\n'
    withoutGlob['package.json'] = JSON.stringify({
      name: 'root',
      private: true,
      scripts: { build: 'pnpm --fail-if-no-match --filter @archava/web... build' },
    })
    const tree = fixtureTree(withoutGlob)
    open.add(tree)
    const result = runStructure(tree.root)
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('`@archava/web` is not a workspace project')
  })

  it('does not mistake a project for its own neighbour on a shared prefix', () => {
    // `@archava/core-check` must not satisfy a dependency on `@archava/core`;
    // taking only the first two path segments is what keeps the lookup exact.
    rejectsOne(
      {
        'packages/adapters/package.json': JSON.stringify({
          name: '@archava/adapters',
          version: '0.0.0',
          main: './src/index.ts',
          dependencies: { '@archava/core-check': 'workspace:*' },
        }),
        'packages/core-check/package.json': JSON.stringify({
          name: '@archava/core-check',
          version: '0.0.0',
          main: './src/index.ts',
        }),
      },
      ['imports @archava/core, which @archava/adapters does not declare'],
    )
  })
})
