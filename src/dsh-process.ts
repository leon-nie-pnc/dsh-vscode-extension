/**
 * Spawn and supervise one local `dsh web` process for the extension.
 *
 * `dsh web` guards its UI with a per-launch token: it prints a line
 * `dsh web: http://127.0.0.1:PORT/?token=XXXX` on stdout, and the root path
 * returns 401 until that URL is visited (which sets an auth cookie). The token
 * is random per launch and lives only in memory, so the only way to obtain it
 * is to parse the child's stdout. This module captures that authenticated URL
 * and reports it as the URL to load in the webview iframe.
 *
 * Reuses an already-running server only when the base URL answers below 400
 * (an older, tokenless server), since a token-guarded server started elsewhere
 * exposes no token to adopt. Only a process this class spawned is killed on
 * disposal.
 * @module dsh-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { get } from 'node:http'
import type { Readable } from 'node:stream'
import type { DshConfig } from './config'

/** Status of the supervised server, surfaced on the status bar. */
export type DshStatus = 'stopped' | 'starting' | 'running' | 'error'

/** How long to wait for the authenticated URL line and reachability before failing. */
const HEALTH_TIMEOUT_MS = 30_000
/** Poll interval between reachability checks. */
const HEALTH_POLL_MS = 250
/** Matches the authenticated URL `dsh web` prints, e.g. `http://127.0.0.1:3080/?token=abc`. */
const TOKEN_URL_RE = /https?:\/\/\S*[?&]token=[A-Za-z0-9_-]+/

/** A supervised `dsh web` process and its state. */
export interface RunningDsh {
  status: DshStatus
  /** The URL to load in the iframe: the authenticated `?token=` URL when this
   * extension spawned the server, or the base URL for an adopted one. */
  url: string
  /** The child process, present only when this extension spawned it. */
  child?: ChildProcess
  error?: string
}

/**
 * The HTTP status `url` currently returns, or undefined when unreachable.
 * @param url - the URL to probe.
 * @param timeoutMs - per-probe timeout.
 * @returns the status code, or undefined on connection error/timeout.
 */
function probeStatus(url: string, timeoutMs = 1_000): Promise<number | undefined> {
  return new Promise(resolve => {
    const req = get(url, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve(undefined))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(undefined)
    })
  })
}

/**
 * Whether `url` currently answers with an authorized status (below 400).
 *
 * A token-guarded root without a cookie returns 401 (not healthy); an
 * authenticated `?token=` URL returns 303 (healthy), and a tokenless server
 * returns 200 (healthy).
 * @param url - the base URL to probe.
 * @param timeoutMs - per-probe timeout.
 * @returns true when the server answers below 400.
 */
export async function isServerHealthy(url: string, timeoutMs = 1_000): Promise<boolean> {
  const status = await probeStatus(url, timeoutMs)
  return status !== undefined && status < 400
}

/** Poll `url` until it answers below 400 or the timeout elapses. */
async function waitForReachable(url: string, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isServerHealthy(url)) return true
    await sleep(HEALTH_POLL_MS)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Spawn a supervised `dsh web` process, capturing its authenticated URL.
 *
 * When the base URL already answers below 400 an existing tokenless server is
 * reused and no child is spawned. Otherwise a child is spawned, its stdout is
 * scanned for the `?token=` URL, and that URL is confirmed reachable.
 * @param config - the resolved launch configuration.
 * @param cwd - the working directory for the spawned process.
 * @param onLog - sink for the child's stdout/stderr lines (diagnostics).
 * @returns the running server state, with `url` set to the authenticated URL.
 */
export async function startDsh(config: DshConfig, cwd: string, onLog: (line: string) => void): Promise<RunningDsh> {
  if (await isServerHealthy(config.url)) {
    return { status: 'running', url: config.url }
  }

  const child = spawn(config.bin, ['web', '--host', config.host, '--port', String(config.port), '--no-open', ...config.extraArgs], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let authenticatedUrl: string | undefined
  let onUrl: ((url: string) => void) | undefined
  const urlSeen = new Promise<string>(resolve => { onUrl = resolve })

  const handleLine = (line: string): void => {
    onLog(line)
    if (authenticatedUrl === undefined) {
      const match = TOKEN_URL_RE.exec(line)
      if (match !== null) {
        authenticatedUrl = match[0]
        onUrl?.(authenticatedUrl)
      }
    }
  }

  const drain = (stream: Readable): void => {
    let buffer = ''
    stream.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') handleLine(line)
      }
    })
    stream.on('end', () => {
      if (buffer.trim() !== '') handleLine(buffer)
    })
  }
  // stdio is ['ignore','pipe','pipe'], so both streams are present.
  if (child.stdout !== null) drain(child.stdout)
  if (child.stderr !== null) drain(child.stderr)

  const exit = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`dsh web exited with code ${code} signal ${signal}`))
    })
  })

  const failed = (error: string): RunningDsh => {
    if (child.exitCode === null) stopChild(child)
    return { status: 'error', url: config.url, child, error }
  }

  let url: string
  try {
    url = await Promise.race([urlSeen, exit, sleep(HEALTH_TIMEOUT_MS).then(() => { throw new Error('timeout') })])
  } catch (error) {
    const reason = error instanceof Error && error.message === 'timeout'
      ? `dsh web did not announce its URL within ${HEALTH_TIMEOUT_MS / 1000}s.`
      : `dsh web failed to start: ${error instanceof Error ? error.message : String(error)}`
    return failed(`${reason} See the "DSH" output channel for logs.`)
  }

  if (!await waitForReachable(url)) {
    return failed(`dsh web announced ${config.url} but it did not become reachable. See the "DSH" output channel for logs.`)
  }

  return { status: 'running', url, child }
}

/**
 * Terminate a child process this extension spawned, with a graceful window.
 * @param child - the child to stop.
 */
export function stopChild(child: ChildProcess | undefined): void {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 2_000)
  child.once('exit', () => clearTimeout(timer))
  if (timer.unref !== undefined) timer.unref()
}
