/**
 * The LAN entry: a second listener that lets a phone reach the harness.
 *
 * Why this exists at all (and why it is not just "use dsh-relay"): a harness at
 * 0.1.2 authenticates its whole `/api` surface with a signed, authority-bound
 * cookie. A phone cannot obtain that cookie — the launch token is printed once
 * per harness process and only accepted on the index route — so *something on
 * the machine* has to mint it. That is the one job this listener does, and it is
 * the job `dsh-relay` 0.2.1 documents in its own type surface but does not
 * implement: it strips the client's `Authorization`/`Cookie` and forwards
 * without adding a credential, so every proxied `/api` call is answered 401.
 *
 * The listener is deliberately small and self-contained:
 *
 *   - `POST /relay/pair` mints this device a bearer token, using the same JSON
 *     contract the DSH Mobile app already speaks, so the app needs no change;
 *   - every other path is proxied to the harness on loopback with a freshly
 *     minted browser-session cookie (see `harness-session.js`) and a rewritten
 *     `Host`, including the WebSocket upgrades;
 *   - a browser can enter with a one-time key carried in the QR, which becomes a
 *     signed cookie on first use — no typing, no certificate.
 *
 * @module dsh-mobile-direct/entry
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { cookieFor, loadSecret } from './harness-session.js'

/** Paths the entry owns; everything else is proxied. */
const RELAY_PREFIX = '/relay'

/** Bearer-token lifetime and pairing-code lifetime. */
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 15 * 60 * 1000
const BROWSER_KEY_TTL_MS = 5 * 60 * 1000
const BROWSER_COOKIE = 'dsh_md_entry'
const BROWSER_SESSION_MS = 30 * 24 * 60 * 60 * 1000

/** Headers that never travel upstream, plus the two the entry replaces. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const CLIENT_ONLY = new Set(['authorization', 'cookie'])

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'mobile-direct', 'devices.json')
}

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function readState() {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (typeof doc?.signingKey === 'string' && typeof doc?.devices === 'object') return doc
  } catch {
    /* fall through to a fresh state */
  }
  return { signingKey: b64url(crypto.randomBytes(32)), devices: {} }
}

function writeState(state) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, undefined, 2)}\n`, 'utf8')
}

/** Hash a bearer token for storage — the token itself is never persisted. */
function hashToken(signingKey, token) {
  return crypto.createHmac('sha256', signingKey).update(token).digest('hex')
}

/** Constant-time comparison over equal-length hex digests. */
function sameHash(left, right) {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function readBearer(headers) {
  const raw = typeof headers.authorization === 'string' ? headers.authorization : ''
  const match = /^Bearer +(\S+)$/i.exec(raw.trim())
  return match === null ? undefined : match[1]
}

function readCookie(headers, name) {
  const raw = typeof headers.cookie === 'string' ? headers.cookie : ''
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function page(title, body) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font:15px/1.6 system-ui,'Microsoft YaHei',sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#0f1115">
<h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</body></html>`
}

/**
 * One LAN entry listener.
 *
 * @param options.ctx - plugin context; `ctx.webServer.port` is the upstream.
 * @param options.config - resolved plugin configuration.
 */
export function createEntry({ ctx, config, log }) {
  const state = { peer: undefined, secret: undefined, secretAt: 0 }
  let server
  let code
  const browserKeys = new Map()

  const upstreamHost = '127.0.0.1'

  function upstreamPort() {
    const port = ctx?.webServer?.port
    return Number.isSafeInteger(port) && port > 0 ? port : 3080
  }

  function authority() {
    return `${upstreamHost}:${String(upstreamPort())}`
  }

  async function sessionSecret() {
    const now = Date.now()
    if (state.secret !== undefined && now - state.secretAt < 60_000) return state.secret
    const secret = await loadSecret(ctx)
    if (secret !== undefined) {
      state.secret = secret
      state.secretAt = now
    }
    return secret
  }

  /** Mint a pairing code and keep exactly one outstanding, like the relay does. */
  function issueCode() {
    const digits = config.pairingCodeLength ?? 8
    let value = ''
    while (value.length < digits) value += String(crypto.randomInt(0, 10))
    code = { code: value, expiresAt: Date.now() + CODE_TTL_MS }
    return code
  }

  function peekCode() {
    if (code !== undefined && code.expiresAt > Date.now()) return code
    return issueCode()
  }

  function claimCode(candidate) {
    if (code === undefined || code.expiresAt <= Date.now()) return false
    if (candidate !== code.code) return false
    code = undefined
    return true
  }

  /** Mint one device token and remember only its hash. */
  function mintDevice(name) {
    const current = readState()
    const id = crypto.randomBytes(8).toString('hex')
    const token = b64url(crypto.randomBytes(32))
    const now = Date.now()
    current.devices[id] = {
      id,
      name: name === '' ? 'device' : name,
      hash: hashToken(current.signingKey, token),
      createdAt: now,
      expiresAt: now + DEVICE_TTL_MS,
      lastSeenAt: undefined,
    }
    writeState(current)
    return { id, token, expiresAt: now + DEVICE_TTL_MS }
  }

  function deviceForToken(token) {
    const current = readState()
    const presented = hashToken(current.signingKey, token)
    for (const device of Object.values(current.devices)) {
      if (typeof device?.hash !== 'string') continue
      if (!sameHash(device.hash, presented)) continue
      if (typeof device.expiresAt === 'number' && device.expiresAt <= Date.now()) return undefined
      device.lastSeenAt = Date.now()
      writeState(current)
      return device
    }
    return undefined
  }

  function liveDevices() {
    const current = readState()
    return Object.values(current.devices).filter(
      (device) => typeof device?.expiresAt !== 'number' || device.expiresAt > Date.now(),
    )
  }

  function revokeDevice(id) {
    const current = readState()
    if (current.devices[id] === undefined) return false
    delete current.devices[id]
    writeState(current)
    return true
  }

  /** Sign a browser-entry cookie so a phone that scanned once stays in. */
  function signBrowserSession(issuedAt) {
    const current = readState()
    const body = b64url(JSON.stringify({ v: 1, issuedAt, expiresAt: issuedAt + BROWSER_SESSION_MS }))
    const signature = b64url(crypto.createHmac('sha256', current.signingKey).update(body).digest())
    return `${body}.${signature}`
  }

  function browserSessionValid(value) {
    if (typeof value !== 'string') return false
    const at = value.lastIndexOf('.')
    if (at <= 0) return false
    const body = value.slice(0, at)
    const current = readState()
    const expected = b64url(crypto.createHmac('sha256', current.signingKey).update(body).digest())
    if (!sameHash(expected, value.slice(at + 1))) return false
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      return typeof claims.expiresAt === 'number' && claims.expiresAt > Date.now()
    } catch {
      return false
    }
  }

  /** A one-time key carried by the browser QR link. */
  function issueBrowserKey() {
    const key = b64url(crypto.randomBytes(16))
    browserKeys.set(key, Date.now() + BROWSER_KEY_TTL_MS)
    for (const [existing, expiry] of browserKeys) {
      if (expiry <= Date.now()) browserKeys.delete(existing)
    }
    return key
  }

  function consumeBrowserKey(key) {
    const expiry = browserKeys.get(key)
    if (expiry === undefined || expiry <= Date.now()) return false
    browserKeys.delete(key)
    return true
  }

  /** Who is asking — the entry's own fence, before anything is proxied. */
  function identity(request) {
    const peer = request.socket?.remoteAddress ?? ''
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') return { kind: 'loopback' }
    const bearer = readBearer(request.headers)
    if (bearer !== undefined && deviceForToken(bearer) !== undefined) return { kind: 'device' }
    if (browserSessionValid(readCookie(request.headers, BROWSER_COOKIE))) return { kind: 'browser' }
    return { kind: 'none' }
  }

  function isOperator(request) {
    const peer = request.socket?.remoteAddress ?? ''
    return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  }

  function sendJson(response, status, value, headers = {}) {
    const body = `${JSON.stringify(value, undefined, 2)}\n`
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    response.end(body)
  }

  function sendHtml(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
    response.end(body)
  }

  function refuse(response, status, message) {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end(message)
  }

  function readBody(request, limit = 64 * 1024) {
    return new Promise((resolve) => {
      const chunks = []
      let total = 0
      request.on('data', (chunk) => {
        total += chunk.length
        if (total > limit) {
          request.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', () => resolve(undefined))
    })
  }

  /** Headers for one upstream request: rewritten Host, minted cookie, no client credentials. */
  function upstreamHeaders(headers) {
    const dropped = new Set(HOP_BY_HOP)
    if (typeof headers.connection === 'string') {
      for (const name of headers.connection.split(',')) dropped.add(name.trim().toLowerCase())
    }
    const out = {}
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (dropped.has(lower) || CLIENT_ONLY.has(lower)) continue
      if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
      out[lower] = value
    }
    const target = authority()
    out.host = target
    if (headers.origin !== undefined) out.origin = `http://${target}`
    if (headers.referer !== undefined) out.referer = `http://${target}/`
    out.cookie = cookieFor(target, state.secret)
    return out
  }

  /** Proxy one HTTP request, minting the upstream session cookie on the way. */
  async function proxy(request, response, url) {
    const secret = await sessionSecret()
    if (secret === undefined) {
      refuse(response, 503, 'dsh-mobile-direct: the harness browser-session secret is unavailable')
      return
    }
    state.secret = secret
    state.secretAt = Date.now()
    const target = authority()
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort(),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: upstreamHeaders(request.headers),
      agent: false,
    })
    upstream.on('response', (incoming) => {
      const headers = {}
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
        headers[name] = value
      }
      response.writeHead(incoming.statusCode ?? 502, headers)
      incoming.pipe(response)
    })
    upstream.on('error', (error) => {
      if (!response.headersSent) refuse(response, 502, `dsh-mobile-direct: upstream error: ${String(error.message)}`)
      else response.destroy()
    })
    request.pipe(upstream)
  }

  /** Proxy one WebSocket upgrade, with the same credential treatment. */
  function proxyUpgrade(request, socket, head) {
    const target = authority()
    const headers = { ...upstreamHeaders(request.headers) }
    for (const name of ['upgrade', 'connection']) {
      if (typeof request.headers[name] === 'string') headers[name] = request.headers[name]
    }
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort(),
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers,
      agent: false,
    })
    upstream.on('upgrade', (incoming, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(incoming.statusCode ?? 101)} ${incoming.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const done = () => {
        upstreamSocket.destroy()
        socket.destroy()
      }
      upstreamSocket.on('error', done)
      socket.on('error', done)
      upstreamSocket.on('close', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
    })
    upstream.on('response', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  }

  /** The entry's own pages and pairing routes. */
  async function handleOwn(request, response, url) {
    const route = url.pathname.slice(RELAY_PREFIX.length) || '/'

    if (route === '/health') {
      return sendJson(response, 200, { service: 'dsh-relay', ok: true })
    }

    if (route === '/pair' && request.method === 'POST') {
      const body = await readBody(request)
      if (body === undefined) return refuse(response, 413, 'too large')
      const wantsJson = (request.headers.accept ?? '').includes('application/json')
      let fields
      try {
        fields = JSON.parse(body)
      } catch {
        fields = Object.fromEntries(new URLSearchParams(body))
      }
      const candidate = typeof fields.code === 'string' ? fields.code.trim() : ''
      if (!claimCode(candidate)) {
        if (wantsJson) return sendJson(response, 403, { error: 'pairing-failed', message: 'That code is not valid.' })
        return sendHtml(response, 403, page('配对失败', '<p>配对码无效、已过期或已被使用。</p>'))
      }
      const name = typeof fields.name === 'string' && fields.name.trim() !== '' ? fields.name.trim() : 'device'
      const device = mintDevice(name)
      if (wantsJson) {
        return sendJson(response, 200, { deviceId: device.id, token: device.token, expiresAt: device.expiresAt })
      }
      return sendHtml(
        response,
        200,
        page('配对成功', `<p>设备 <code>${escapeHtml(device.name)}</code> 已配对。</p><p><a href="/">进入 Harness</a></p>`),
      )
    }

    if (route === '/pair' && request.method === 'GET') {
      if (!isOperator(request)) {
        return sendHtml(
          response,
          200,
          page('Pair this device', `<form method="post" action="/relay/pair">
<label>配对码<br><input name="code" inputmode="numeric" autocomplete="one-time-code" style="font-size:20px;letter-spacing:.2em;padding:8px"></label>
<p><label>设备名<br><input name="name" placeholder="my-phone" style="padding:8px"></label></p>
<button type="submit" style="padding:8px 16px">Pair</button></form>`),
        )
      }
      const live = peekCode()
      return sendHtml(
        response,
        200,
        page(
          'Pair a device',
          `<p style="font-size:34px;letter-spacing:.22em;font-family:Consolas,monospace">${escapeHtml(live.code)}</p>
<p>有效期至 ${new Date(live.expiresAt).toLocaleTimeString()}</p>
<p>在手机上打开 <code>/relay/pair</code> 输入此码，或用 App 的「中继 → 配对中继」扫码。</p>`,
        ),
      )
    }

    if (route === '/devices' && request.method === 'GET') {
      if (!isOperator(request)) return refuse(response, 403, 'Sign in to manage devices.')
      const rows = liveDevices()
        .map(
          (device) =>
            `<li>${escapeHtml(device.name)} <span style="color:#8a8f98">${escapeHtml(device.id)}</span>
<form method="post" action="/relay/devices/revoke" style="display:inline"><input type="hidden" name="deviceId" value="${escapeHtml(device.id)}">
<button type="submit">撤销</button></form></li>`,
        )
        .join('')
      return sendHtml(
        response,
        200,
        page('已配对设备', rows === '' ? '<p>还没有设备配对。</p>' : `<ul>${rows}</ul>`),
      )
    }

    if (route === '/devices/revoke' && request.method === 'POST') {
      if (!isOperator(request)) return refuse(response, 403, 'Sign in to manage devices.')
      const body = await readBody(request)
      const fields = Object.fromEntries(new URLSearchParams(body ?? ''))
      const id = typeof fields.deviceId === 'string' ? fields.deviceId : ''
      revokeDevice(id)
      response.writeHead(303, { location: '/relay/devices', 'cache-control': 'no-store' })
      return response.end()
    }

    return refuse(response, 404, 'not found')
  }

  function handler(request, response) {
    const url = new URL(request.url ?? '/', 'http://entry.invalid')

    // A browser entry link: `/?k=<one-time key>` becomes a signed cookie.
    const key = url.searchParams.get('k')
    if (key !== null && consumeBrowserKey(key)) {
      response.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': `${BROWSER_COOKIE}=${signBrowserSession(Date.now())}; Max-Age=${String(
          Math.floor(BROWSER_SESSION_MS / 1000),
        )}; Path=/; HttpOnly; SameSite=Lax`,
      })
      return response.end()
    }

    const run = async () => {
      if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(`${RELAY_PREFIX}/`)) {
        return handleOwn(request, response, url)
      }
      const who = identity(request)
      if (who.kind === 'none') {
        return refuse(
          response,
          403,
          'dsh-mobile-direct: pair this device first (scan the QR in the harness UI), or open the browser entry link.',
        )
      }
      return proxy(request, response, url)
    }

    run().catch((error) => {
      const message = String(error?.message ?? error)
      // Always report to the harness log: a swallowed error here is otherwise
      // invisible, and every proxied request would just say "internal error".
      console.error(`[dsh-mobile-direct] entry handler failed: ${String(error?.stack ?? error)}`)
      log?.warn?.(`entry handler failed: ${message}`)
      if (!response.headersSent) refuse(response, 500, `dsh-mobile-direct: internal error: ${message}`)
      else response.destroy()
    })
  }

  return {
    /** Start listening; resolves once the socket is bound. */
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler)
        server.on('upgrade', (request, socket, head) => {
          if (identity(request).kind === 'none') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
            socket.destroy()
            return
          }
          proxyUpgrade(request, socket, head)
        })
        server.on('error', reject)
        server.listen(config.entryPort, config.entryBind ?? '0.0.0.0', () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    /** Stop listening and drop every pending connection. */
    stop() {
      return new Promise((resolve) => {
        if (server === undefined) return resolve()
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
    /** What the badge needs: where to point a phone, and a live code. */
    describe(address) {
      const host = address ?? '127.0.0.1'
      const origin = `http://${host}:${String(config.entryPort)}`
      const live = peekCode()
      return {
        origin,
        code: live.code,
        expiresAt: live.expiresAt,
        browserEntryUrl: `${origin}/?k=${issueBrowserKey()}`,
        devicesUrl: `${origin}/relay/devices`,
      }
    },
    devices: liveDevices,
  }
}

/** Whether a LAN address looks reachable from a phone (used by the badge). */
export function isBindable(address) {
  const socket = net.isIP(address)
  return socket !== 0
}
