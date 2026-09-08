/**
 * Spawn and supervise one local `dsh web` process for the extension.
 *
 * Reuses an already-running server when the target URL answers, so a user's
 * manually started `dsh web` is adopted instead of a second process racing
 * for the port. Only a process this class spawned is killed on disposal.
 * @module dsh-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { get } from 'node:http'
import type { Readable } from 'node:stream'
import type { DshConfig } from './config'

/** Status of the supervised server, surfaced on the status bar. */
export type DshStatus = 'stopped' | 'starting' | 'running' | 'error'

/** How long to keep polling `/` for a healthy response before failing. */
const HEALTH_TIMEOUT_MS = 30_000
/** Poll interval between health checks. */
const HEALTH_POLL_MS = 250

/** A supervised `dsh web` process and its state. */
export interface RunningDsh {
  status: DshStatus
  url: string
  /** The child process, present only when this extension spawned it. */
  child?: ChildProcess
  error?: string
}

/**
 * Whether `url` currently serves an HTTP 200 response.
 * @param url - the base URL to probe.
 * @param timeoutMs - per-probe timeout.
 * @returns true when the server answers 200.
 */
export function isServerHealthy(url: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const req = get(url, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Poll `url` until it answers 200 or the timeout elapses.
 * @param url - the base URL to probe.
 * @param timeoutMs - overall deadline.
 * @returns true when the server became healthy.
 */
async function waitForHealthy(url: string, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<boolean> {
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
 * Spawn a supervised `dsh web` process, adopting any already-running server.
 *
 * When the target URL already answers 200 the existing server is reused and
 * no child is spawned. Otherwise a child is spawned and polled for health.
 * @param config - the resolved launch configuration.
 * @param cwd - the working directory for the spawned process.
 * @param onLog - sink for the child's stderr lines (diagnostics).
 * @returns the running server state.
 */
export async function startDsh(config: DshConfig, cwd: string, onLog: (line: string) => void): Promise<RunningDsh> {
  if (await isServerHealthy(config.url)) {
    return { status: 'running', url: config.url }
  }

  const child = spawn(config.bin, ['web', '--host', config.host, '--port', String(config.port), ...config.extraArgs], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const drain = (stream: Readable): void => {
    let buffer = ''
    stream.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') onLog(line)
      }
    })
    stream.on('end', () => {
      if (buffer.trim() !== '') onLog(buffer)
    })
  }
  // stdio is ['ignore','pipe','pipe'], so both streams are present.
  if (child.stdout !== null) drain(child.stdout)
  if (child.stderr !== null) drain(child.stderr)

  const exit = new Promise<'exited'>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve('exited')
      else reject(new Error(`dsh web exited with code ${code} signal ${signal}`))
    })
  })

  const healthy = await Promise.race([
    waitForHealthy(config.url).then(ok => ok),
    exit.then(() => false),
  ])

  if (!healthy) {
    if (child.exitCode === null) stopChild(child)
    return {
      status: 'error',
      url: config.url,
      child,
      error: `dsh web did not become healthy at ${config.url}. See the "DSH" output channel for logs.`,
    }
  }

  return { status: 'running', url: config.url, child }
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
