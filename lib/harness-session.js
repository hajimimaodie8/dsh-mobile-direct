/**
 * Mint the harness browser-session cookie this plugin presents upstream.
 *
 * Harness 0.1.2 authenticates its entire `/api` surface (every unary call and
 * both WebSocket upgrades) against a signed, **authority-bound** cookie, and
 * answers 401 without one. A LAN client cannot obtain that cookie the way a
 * browser does — the launch token is printed once per harness process, is only
 * accepted on the index route, and is never persisted.
 *
 * What a plugin *can* do is what the harness itself does: read the durable
 * signing secret from the credential store it shares, and mint the cookie
 * directly. That is not a bypass — this plugin already runs inside the harness
 * process with the operator's authority. Minting one only lets a remote client
 * speak the same HTTP contract a browser would.
 *
 * The exact shape is taken from `@deepseek-ai/dsh-client-connection`:
 *
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON{version:1, authority, issuedAt, expiresAt})
 *                 + "." + base64url(HMAC-SHA256(secret, body))
 *   secret = 32 bytes, base64url, in credential record
 *            `client-connection/browser-session` as {kind:"grant", payload:{...}}
 *
 * @module dsh-mobile-direct/harness-session
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/** Credential record holding the browser-session signing secret. */
const RECORD_KEY = 'client-connection/browser-session'

/** Cookie payload version and prefix this harness generation writes. */
const COOKIE_PAYLOAD_VERSION = 1
const COOKIE_PREFIX = 'dsh-auth-'

/** Default cookie lifetime; the harness default is 30 days. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** `$DSH_HOME`, matching how the harness resolves its own home. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh')
}

/** base64url without padding, on any Node this harness supports. */
function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

/**
 * The secret, decoded from the credential store.
 *
 * `ctx.credentials` is preferred when the harness exposes a record read; the
 * on-disk store is the fallback, because a plugin is loaded inside a running
 * harness whose credential provider may be a different backend than the file.
 *
 * @param ctx - the plugin context, for the credential service when present.
 * @returns the 32-byte secret, or undefined when this home has none.
 */
export async function loadSecret(ctx) {
  const record = await readRecord(ctx)
  const encoded = record?.payload?.secret
  if (typeof encoded !== 'string') return undefined
  const secret = Buffer.from(encoded, 'base64url')
  if (secret.length !== 32) return undefined
  return secret
}

async function readRecord(ctx) {
  const service = ctx?.credentials ?? ctx?.get?.('credentials')
  if (service !== undefined && service !== null) {
    for (const method of ['getRecord', 'readRecord', 'record']) {
      if (typeof service[method] !== 'function') continue
      try {
        const record = await service[method](RECORD_KEY)
        if (record !== undefined) return record
      } catch {
        /* fall through to the file */
      }
    }
  }
  return readRecordFromFile()
}

/** Read the record out of `$DSH_HOME/.credentials.yaml`. */
function readRecordFromFile() {
  const file = path.join(dshHome(), '.credentials.yaml')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const require = createRequire(import.meta.url)
    const yamlModule = require('js-yaml')
    const yaml = yamlModule.default ?? yamlModule
    const doc = yaml.load(text)
    return doc?.records?.[RECORD_KEY]
  } catch {
    // No YAML parser available: read the one value this module needs, straight
    // from the record's own block.
    return parseRecordByScan(text)
  }
}

/**
 * Minimal fallback parser for exactly one nested key.
 *
 * The credential file is written by the harness with plain two-space
 * indentation and unquoted base64url values, so a scanner over the record block
 * is enough to recover the secret without a YAML dependency.
 */
function parseRecordByScan(text) {
  const lines = text.split(/\r?\n/)
  let inRecords = false
  let inRecord = false
  let inPayload = false
  let kind
  let secret
  let version
  for (const line of lines) {
    if (/^records:\s*$/.test(line)) {
      inRecords = true
      continue
    }
    if (!inRecords) continue
    if (/^\S/.test(line) && !/^records:/.test(line)) break // left the records block
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    if (indent === 2) {
      inRecord = trimmed === `${RECORD_KEY}:`
      inPayload = false
      continue
    }
    if (!inRecord) continue
    if (indent === 4) {
      inPayload = trimmed === 'payload:'
      const match = /^kind:\s*(.+)$/.exec(trimmed)
      if (match) kind = match[1].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    if (indent === 6 && inPayload) {
      const secretMatch = /^secret:\s*(.+)$/.exec(trimmed)
      if (secretMatch) secret = secretMatch[1].trim().replace(/^['"]|['"]$/g, '')
      const versionMatch = /^version:\s*(\d+)$/.exec(trimmed)
      if (versionMatch) version = Number(versionMatch[1])
      continue
    }
  }
  if (secret === undefined) return undefined
  return { kind: kind ?? 'grant', payload: { version, secret } }
}

/** The cookie name for one authority — `host:port` as the harness sees it. */
export function cookieName(authority) {
  return COOKIE_PREFIX + b64url(crypto.createHash('sha256').update(authority).digest())
}

/** Sign one cookie value exactly as the harness does. */
export function encodeCookie(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64url(crypto.createHmac('sha256', secret).update(body).digest())
  return `v1.${body}.${signature}`
}

/**
 * The `Cookie` header value proving a browser session for `authority`.
 *
 * Minted fresh per request: the harness refuses a cookie claiming to be issued
 * in the future, and a fresh HMAC costs microseconds.
 *
 * @param authority - the `host:port` the upstream request will carry.
 * @param secret - the 32-byte signing secret.
 * @returns one `name=value` pair, ready to send as `Cookie`.
 */
export function cookieFor(authority, secret) {
  const issuedAt = Date.now()
  const value = encodeCookie(
    { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt: issuedAt + MAX_AGE_MS },
    secret,
  )
  return `${cookieName(authority)}=${value}`
}
