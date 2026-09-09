/**
 * Local authenticating reverse proxy for the dsh web server.
 *
 * The VSCode webview embeds the harness UI in a cross-origin iframe. dsh web
 * guards `/` and `/api` with a `SameSite=Strict` auth cookie, which a browser
 * never sends from a cross-site iframe, so the framed app would only see 401s.
 * This proxy closes that gap: it performs the one-time `?token=` cookie
 * exchange in Node, then on every forwarded request injects that cookie and
 * rewrites Host and Origin to the upstream authority (the `/api` fence rejects
 * an Origin that does not equal Host). The iframe loads the proxy origin and
 * needs no cookie of its own.
 *
 * The proxy binds loopback only and forwards solely to the single upstream it
 * was created for; it holds the harness auth for the local user exactly as the
 * spawned `dsh web` already trusts this machine.
 * @module dsh-proxy
 */

import { createServer, get, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A running auth proxy and the URL to frame. */
export interface AuthProxy {
  /** Base URL to load in the iframe; carries no token and needs no browser cookie. */
  url: string
  /** Loopback port the proxy listens on, for the iframe CSP `frame-src`. */
  port: number
  /** Stop the proxy and release its port. */
  dispose: () => void
}

/**
 * Run the `?token=` exchange once and return the `name=value` cookie to inject.
 * @param tokenUrl - the authenticated `?token=` URL `dsh web` announced.
 * @returns the first `name=value` pair of the minted auth cookie.
 */
function fetchAuthCookie(tokenUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(tokenUrl, res => {
      res.resume()
      const setCookie = res.headers['set-cookie']
      if (setCookie === undefined || setCookie.length === 0) {
        reject(new Error(`dsh web returned no auth cookie (status ${String(res.statusCode)}) for the token URL`))
        return
      }
      resolve(setCookie[0].split(';', 1)[0])
    })
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('timed out fetching the dsh web auth cookie')))
  })
}

/**
 * Start the authenticating proxy in front of `baseUrl`.
 * @param baseUrl - the upstream `dsh web` base URL, e.g. `http://127.0.0.1:3080`.
 * @param tokenUrl - the authenticated `?token=` URL used once to mint the cookie.
 * @returns the running proxy: its loopback URL, port, and disposer.
 */
export async function startAuthProxy(baseUrl: string, tokenUrl: string): Promise<AuthProxy> {
  const upstream = new URL(baseUrl)
  const authority = upstream.host
  const origin = `${upstream.protocol}//${authority}`
  const cookie = await fetchAuthCookie(tokenUrl)

  // Replace the browser's Host/Origin/Cookie so the upstream fence sees a
  // same-authority, authenticated request; forward everything else verbatim.
  const rewrite = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const out: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (value === undefined || lower === 'host' || lower === 'origin' || lower === 'cookie') continue
      out[name] = value
    }
    out.host = authority
    out.origin = origin
    out.cookie = cookie
    return out
  }

  const server = createServer((req, res) => {
    const upstreamReq = httpRequest(
      { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: rewrite(req.headers) },
      (upstreamRes: IncomingMessage) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end('dsh proxy: upstream request failed')
    })
    req.pipe(upstreamReq)
  })

  // Forward WebSocket/other protocol upgrades with the same header rewrite.
  server.on('upgrade', (req, socket, head) => {
    const upstreamReq = httpRequest({
      host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: rewrite(req.headers),
    })
    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      socket.write(`HTTP/1.1 ${String(upstreamRes.statusCode)} ${upstreamRes.statusMessage ?? ''}\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstreamReq.on('error', () => socket.destroy())
    if (head.length > 0) upstreamReq.write(head)
    upstreamReq.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/`, port, dispose: () => server.close() }
}
