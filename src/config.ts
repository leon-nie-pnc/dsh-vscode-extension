/**
 * Configuration resolution for the dsh-chat extension.
 *
 * Resolves the `dsh` binary (config > DSH_BIN > PATH), the bind host/port,
 * and any extra arguments. The `dsh web` app only supports binding
 * `127.0.0.1` for safety, so the host defaults there and is validated.
 * @module dsh-config
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import * as vscode from 'vscode'

/** The single supported bind host (the dsh web app rejects 0.0.0.0). */
export const DEFAULT_HOST = '127.0.0.1'
/** Default port, matching the dsh web composition fallback. */
export const DEFAULT_PORT = 3080

/** Fully resolved launch configuration for a `dsh web` process. */
export interface DshConfig {
  /** Absolute path to the `dsh` executable. */
  bin: string
  host: string
  port: number
  /** Extra argv passed to `dsh web` after the host/port flags. */
  extraArgs: readonly string[]
  /** The URL the web app will serve once healthy. */
  url: string
}

/**
 * Locate the `dsh` executable, or throw a diagnostic that tells the user how
 * to install it. Resolution order: `dsh.binPath` config, `DSH_BIN` env, the
 * source launcher (`bin/dsh-source`) in an open workspace folder, then `dsh`
 * on PATH. Auto-locating the launcher means a source checkout works with no
 * machine-specific `dsh.binPath` — it follows wherever the repo is opened.
 * @returns the absolute executable path.
 */
export function resolveDshBin(config: vscode.WorkspaceConfiguration, binFromPath?: string): string {
  const configured = config.get<string>('binPath', '')
  if (configured !== '') {
    const absolute = isAbsolute(configured) ? configured : normalize(configured)
    if (!existsSync(absolute)) {
      throw new Error(`dsh.binPath points at ${absolute}, which does not exist.`)
    }
    return absolute
  }
  const fromEnv = process.env.DSH_BIN
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!existsSync(fromEnv)) {
      throw new Error(`DSH_BIN points at ${fromEnv}, which does not exist.`)
    }
    return fromEnv
  }
  const launcher = findWorkspaceLauncher()
  if (launcher !== undefined) return launcher
  const found = binFromPath ?? which('dsh')
  if (found === undefined) {
    throw new Error(
      'Could not find the `dsh` executable. Install it with `npm i -g @deepseek-ai/dsh`, '
      + 'set `dsh.binPath` in settings, or set the DSH_BIN environment variable.',
    )
  }
  return found
}

/**
 * Look for the source-tree launcher `bin/dsh-source` in any open workspace
 * folder. This is what makes a source checkout self-adaptive: open the
 * extension repo and the launcher is found without any absolute path setting.
 * @returns the launcher's absolute path, or undefined when none is present.
 */
function findWorkspaceLauncher(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = join(folder.uri.fsPath, 'bin', 'dsh-source')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Find an executable on PATH using the platform's own lookup (`which`/`where`).
 * @param name - the executable name.
 * @returns the first matching path, or undefined when absent.
 */
function which(name: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(cmd, [name], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const first = result.stdout.split(/\r?\n/).find(line => line.trim() !== '')
  return first === undefined ? undefined : first.trim()
}

/**
 * Resolve the full launch configuration from VSCode settings and the ambient
 * environment.
 * @returns the validated configuration.
 */
export function resolveDshConfig(): DshConfig {
  const config = vscode.workspace.getConfiguration('dsh')
  const bin = resolveDshBin(config)
  const host = config.get<string>('host', DEFAULT_HOST)
  if (host !== DEFAULT_HOST) {
    throw new Error(`dsh.host must be ${DEFAULT_HOST}; the dsh web app rejects any other bind host for safety.`)
  }
  const port = config.get<number>('port', DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dsh.port must be an integer between 1 and 65535, got ${JSON.stringify(port)}.`)
  }
  const extraArgs = config.get<readonly string[]>('extraArgs', [])
  return { bin, host, port, extraArgs, url: `http://${host}:${port}` }
}

/** The workspace folder to spawn `dsh web` from, or the user's home directory. */
export function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]
  return folder === undefined ? dirname(process.env.HOME ?? join(process.cwd())) : folder.uri.fsPath
}
