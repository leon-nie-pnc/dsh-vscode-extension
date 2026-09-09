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

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { get } from 'node:http'
import type { Readable } from 'node:stream'
import type { DshConfig } from './config'
import { startAuthProxy, type AuthProxy } from './dsh-proxy'

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
  /** The auth proxy fronting a spawned, token-guarded server; absent for an adopted tokenless one. */
  proxy?: AuthProxy
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

  // A `dsh web` orphaned by a previous window reload can keep holding the port
  // and would make the spawn below fail with EADDRINUSE. The adopt check above
  // already rejected it (a token-guarded root answers 401, not < 400), so it
  // exposes no token to reuse; reclaim the port before spawning a fresh one.
  await reclaimPort(config.port)

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

  // The webview iframe is cross-origin to the server, so it cannot carry the
  // SameSite=Strict auth cookie. Front the server with a proxy that injects the
  // cookie on every request; the iframe loads the proxy, which needs none.
  let proxy: AuthProxy
  try {
    proxy = await startAuthProxy(config.url, url)
  } catch (error) {
    return failed(`dsh web auth proxy failed to start: ${error instanceof Error ? error.message : String(error)} See the "DSH" output channel for logs.`)
  }
  return { status: 'running', url: proxy.url, child, proxy }
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

/** Run a lookup command and return its stdout, or '' when the tool is absent or fails. */
function execCapture(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, [...args], { timeout: 3_000 }, (_error, stdout) => resolve(stdout))
  })
}

/** Collect the distinct positive integers from lines of a PID listing. */
function parsePids(values: Iterable<string>): number[] {
  const pids = new Set<number>()
  for (const value of values) {
    const pid = Number(value.trim())
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * PIDs currently listening on `port`, via the platform's own socket lookup.
 * Returns an empty list when the lookup tool is unavailable.
 * @param port - the loopback port to inspect.
 */
async function listenerPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const out = await execCapture('netstat', ['-ano', '-p', 'tcp'])
    const pids: string[] = []
    for (const line of out.split(/\r?\n/)) {
      const match = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
      if (match !== null && Number(match[1]) === port) pids.push(match[2])
    }
    return parsePids(pids)
  }
  if (process.platform === 'darwin') {
    return parsePids((await execCapture('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])).split(/\r?\n/))
  }
  const out = await execCapture('ss', ['-tlnpH', `sport = :${port}`])
  return parsePids([...out.matchAll(/pid=(\d+)/g)].map(match => match[1]))
}

/**
 * Kill any process listening on `port` and wait until the socket is free.
 *
 * Only reached after the adopt check declined the current listener, so the
 * listener is a stale `dsh web` (or a process shutting down), never a server
 * this extension wants to keep. Best-effort: a missing lookup tool leaves the
 * port untouched and the caller's spawn surfaces a still-occupied port itself.
 * @param port - the loopback port to reclaim.
 */
async function reclaimPort(port: number): Promise<void> {
  const initial = await listenerPids(port)
  if (initial.length === 0) return
  for (const pid of initial) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited between lookup and signal */ }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await listenerPids(port)).length === 0) return
    await sleep(HEALTH_POLL_MS)
  }
  for (const pid of await listenerPids(port)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
}
