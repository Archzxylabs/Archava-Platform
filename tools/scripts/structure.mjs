#!/usr/bin/env node
/* global console, process */
/**
 * The claims about this repo's shape that no other gate makes.
 *
 * Vitest aliases every `@archava/*` name to its source entry (see
 * `vitest.config.ts`), so a package that imports a neighbour it never declared
 * resolves fine under `pnpm test` and fails the moment something outside the
 * bundler's alias table tries to load it. The lockfile does not catch it
 * either: a missing workspace dependency is simply absent, not wrong. So the
 * boundary has to be asserted directly, and this is where.
 *
 * Three claims, all about the repository as a whole rather than about any one
 * package, which is why none of them belongs in a package's own test suite:
 *
 * 1. **The runnable app is still runnable.** The root scripts `dev`, `start`,
 *    `build:web` and `typecheck:web` exist to run `apps/web`, and every
 *    `--filter <name>` in the root manifest names a project that exists. When
 *    the browser app is the only thing exercising several packages, its
 *    disappearance would otherwise be a silent failure — no test in the repo
 *    imports it, so deleting the directory leaves every other gate green.
 * 2. **Every cross-package import is declared.** For each workspace project,
 *    every `@archava/*` specifier in its source and tests is named in that
 *    project's own manifest. This is what proves the boundary works through
 *    declared workspace dependencies rather than through aliases.
 * 3. **No file reaches another package by filesystem path.** A relative
 *    specifier resolving outside its own project directory is how a scratch
 *    script becomes a hidden dependency: it needs no manifest entry, survives
 *    `pnpm install`, and keeps working until the tree is re-laid-out.
 *
 * Usage: `pnpm structure` (or `node tools/scripts/structure.mjs`).
 * Exit code 0 means every claim held; 1 names each violation found.
 *
 * An optional first argument names a directory to check instead of this
 * repository. That is the seam the gate's own tests build throwaway trees
 * behind: a gate that only ever inspects its own healthy repo can be tested
 * for nothing except that it is quiet.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
)
const SOURCE_SUFFIXES = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo'])

/**
 * `from '<spec>'`, `import '<spec>'`, `import('<spec>')` and `require('<spec>')`.
 *
 * Four patterns rather than one grammar, because a regex that understood every
 * form of import would be a parser. The two dynamic ones are included because an
 * `await import()` of an undeclared package breaks exactly as hard as a static
 * one and is harder to catch by eye.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
]

const problems = []

function fail(message) {
  problems.push(message)
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`${relativeOf(filePath)} is not readable JSON: ${error.message}`)
    return null
  }
}

function relativeOf(absolute) {
  return path.relative(repoRoot, absolute) || '.'
}

/** The `packages` globs from `pnpm-workspace.yaml`, or the conventional ones. */
function readWorkspaceGlobs() {
  const manifestPath = path.join(repoRoot, 'pnpm-workspace.yaml')
  if (!existsSync(manifestPath)) return ['packages/*', 'apps/*', 'tools/*']
  const globs = []
  let inPackages = false
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages && /^\S/.test(line)) break
    const item = inPackages ? /^\s*-\s*['"]?([^'"\s]+)['"]?/.exec(line) : null
    if (item?.[1] !== undefined) globs.push(item[1])
  }
  return globs.length > 0 ? globs : ['packages/*', 'apps/*', 'tools/*']
}

/** Every workspace project, keyed by the name it publishes under. */
function workspaceProjects() {
  const found = new Map()
  for (const glob of readWorkspaceGlobs()) {
    const base = glob.replace(/\/?\*+$/, '')
    const absoluteBase = path.join(repoRoot, base)
    if (!existsSync(absoluteBase)) continue
    for (const entry of readdirSync(absoluteBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(absoluteBase, entry.name)
      const manifestPath = path.join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath)
      if (manifest === null || typeof manifest.name !== 'string') continue
      found.set(manifest.name, { name: manifest.name, directory, manifest })
    }
  }
  return found
}

/** Every source file under a project, in a stable order. */
function sourceFiles(directory) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(current, entry.name))
        continue
      }
      if (SOURCE_SUFFIXES.has(path.extname(entry.name))) files.push(path.join(current, entry.name))
    }
  }
  walk(directory)
  return files.sort()
}

/** Every module specifier a file mentions in an import position. */
function specifiersOf(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const specifiers = []
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      if (match[1] !== undefined) specifiers.push(match[1])
    }
  }
  return specifiers
}

/** The dependencies a project declares, across the three fields that can hold one. */
function declaredDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
}

/* ------------------------------------------------------------------ claims -- */

/** Claim 1: the runnable app and the root scripts that target it still exist. */
function checkRunnableApp(projects) {
  const rootManifest = readJson(path.join(repoRoot, 'package.json'))
  if (rootManifest === null) return

  const web = projects.get('@archava/web')
  if (web === undefined) {
    fail('`@archava/web` is not a workspace project; nothing would run the browser app')
    return
  }
  for (const script of ['dev', 'build', 'start']) {
    if (typeof web.manifest.scripts?.[script] !== 'string') {
      fail(
        `@archava/web has no \`${script}\` script; the root scripts delegate to it and would fail`,
      )
    }
  }
  for (const name of ['dev', 'start', 'build:web', 'typecheck:web']) {
    const command = rootManifest.scripts?.[name]
    if (typeof command !== 'string') {
      fail(`root script \`${name}\` is missing; the browser app is supposed to be one command away`)
    } else if (!/@archava\/web/.test(command)) {
      fail(`root script \`${name}\` does not target @archava/web: ${command}`)
    }
  }
  // pnpm exits 0 when a filter matches nothing, so `--filter <gone-project> build`
  // is a silent success. The flag is what turns the same command into an error,
  // and asserting it here keeps the two mechanisms from drifting apart.
  for (const command of Object.values(rootManifest.scripts ?? {})) {
    if (typeof command !== 'string' || !/--filter\s+\S*archava\/web/.test(command)) continue
    if (!/--fail-if-no-match/.test(command)) {
      fail(
        `root script \`${command}\` filters @archava/web without \`--fail-if-no-match\`; pnpm exits 0 when a filter matches nothing`,
      )
    }
  }
  for (const [name, command] of Object.entries(rootManifest.scripts ?? {})) {
    if (typeof command !== 'string') continue
    for (const match of command.matchAll(/--filter\s+(\S+)/g)) {
      const projectName = (match[1] ?? '').replace(/\.\.\.$/, '')
      if (!projects.has(projectName)) {
        fail(`root script \`${name}\` filters \`${projectName}\`, which is not a workspace project`)
      }
    }
  }
}

/** Claims 2 and 3: what each project imports is declared, and nothing escapes by path. */
function checkBoundaries(projects) {
  for (const project of projects.values()) {
    const declared = declaredDependencies(project.manifest)
    for (const filePath of sourceFiles(project.directory)) {
      const relative = relativeOf(filePath)
      for (const specifier of specifiersOf(filePath)) {
        if (specifier.startsWith('@archava/')) {
          const name = specifier.split('/').slice(0, 2).join('/')
          if (!declared.has(name)) {
            fail(
              `${relative} imports ${name}, which ${project.name} does not declare in its package.json`,
            )
          }
          continue
        }
        if (!specifier.startsWith('.')) continue
        const resolved = path.resolve(path.dirname(filePath), specifier)
        if (resolved !== project.directory && !resolved.startsWith(project.directory + path.sep)) {
          fail(`${relative} imports ${specifier}, which resolves outside its own package`)
        }
      }
    }
  }
}

/* --------------------------------------------------------------------- run -- */

const projects = workspaceProjects()
if (projects.size === 0)
  fail('no workspace projects found; pnpm-workspace.yaml and the tree disagree')

checkRunnableApp(projects)
checkBoundaries(projects)

if (problems.length === 0) {
  console.log(`structure: ${projects.size} workspace projects, every @archava/* import declared.`)
} else {
  console.error(`structure: ${problems.length} problem(s).`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}
