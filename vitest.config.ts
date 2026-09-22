import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Every workspace package, aliased to its source entry.
 *
 * Derived from the manifests rather than listed by hand. A hand-written alias
 * is an alias that gets forgotten, and the failure it produces — "Cannot find
 * package '@archava/knowledge'" — reads like a missing dependency rather than a
 * missing line in this file, which costs a debugging round-trip every time a
 * package is added.
 */
function workspaceAliases(): Record<string, string> {
  const root = path.resolve(__dirname, 'packages')
  const aliases: Record<string, string> = {}
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(root, entry.name, 'package.json')
    const entryPath = path.join(root, entry.name, 'src/index.ts')
    if (!existsSync(manifestPath) || !existsSync(entryPath)) continue
    const name = readManifestName(manifestPath)
    if (name === null) continue
    aliases[name] = entryPath
  }
  return aliases
}

/** The `name` a package publishes under, or null when it publishes none. */
function readManifestName(manifestPath: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return null
  const name = (parsed as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

export default defineConfig({
  resolve: {
    alias: workspaceAliases(),
  },
  test: {
    include: ['{packages,apps,tools}/**/test/**/*.test.ts', '{packages,apps,tools}/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/index.ts'],
    },
  },
})
