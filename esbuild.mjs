/**
 * Bundle the extension entry point into a single `dist/extension.js`.
 * `vscode` is external — the extension host provides it at runtime.
 *
 * Usage:
 *   node esbuild.mjs              # one-shot production build (minified)
 *   node esbuild.mjs --watch      # rebuild on source change
 *   node esbuild.mjs --production # identical to the default (alias for vsce prepublish)
 */
import { context } from 'esbuild'
import { fileURLToPath } from 'node:url'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [fileURLToPath(new URL('src/extension.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: fileURLToPath(new URL('dist/extension.js', import.meta.url)),
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching src/ for changes…')
} else {
  const ctx = await context(options)
  await ctx.rebuild()
  await ctx.dispose()
}
