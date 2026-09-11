/**
 * dsh-mobile-direct — a scan-once mobile entry for DeepSeek Harness.
 *
 * The problem this solves is narrow and specific. `dsh-relay` already knows how
 * to pair a phone: `/relay/pair` renders a QR whose payload a client (the DSH
 * Mobile app, or any client implementing the relay's CLIENT_INTEGRATION) reads
 * and claims to mint a device token. What it cannot do by itself is put the
 * *right address* in that QR. The relay builds the payload from the `Host` it was
 * reached by, so the page opened the way everyone opens it — on the machine
 * running the harness, at `127.0.0.1:3443` — yields a QR carrying `127.0.0.1`,
 * which no phone can use.
 *
 * This plugin closes that last gap and nothing else:
 *
 *   - it asks the relay for a live pairing code over loopback (where it is the
 *     operator, so the relay will issue one) while *claiming* the LAN address in
 *     the `Host` header, so the payload it builds carries an address the phone
 *     can actually reach;
 *   - it renders that payload as a QR, plus a second QR for a browser entry, in a
 *     small panel pinned to the top-right corner of the harness web UI;
 *   - it lets the operator pick which local address to advertise, because a
 *     machine with virtual adapters (VMware, Hyper-V, WSL) has several and only
 *     one of them is on the network the phone is on.
 *
 * It deliberately does not re-implement a proxy, a tunnel, or authentication: the
 * relay remains the only listener the phone talks to, and the token the app
 * receives is the relay's own.
 *
 * @module dsh-mobile-direct
 */
import os from 'node:os'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'

/** Cordis plugin identity. */
export const name = 'mobile-direct'

/** The relay owns the listener; we only need the harness's route registry. */
export const inject = ['webServer']

/** Every route this plugin serves lives under this prefix. */
const PREFIX = '/mobile-direct'

/** Payload discriminator and version the DSH Mobile app and the relay agree on. */
const PAYLOAD_KIND = 'dsh-relay-pair'
const PAYLOAD_VERSION = 1

/** Defaults, overridable from the profile patch's `config`. */
const DEFAULTS = {
  relayPort: 3443,
  relayScheme: 'http',
  badge: true,
  lanAddress: '',
  label: '',
}

/** Private IPv4 ranges — the only ones a phone is plausibly on the same side of. */
function isPrivateAddress(address) {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  )
}

/**
 * Interface names that are never the network the phone is on. A machine running
 * VMware or Hyper-V typically has two or three of these carrying a private
 * address, and advertising one of them is the most common way this feature
 * "works" and still cannot be reached.
 */
const VIRTUAL_INTERFACE =
  /vmware|virtualbox|hyper-?v|vethernet|loopback|bluetooth|tailscale|zerotier|docker|wsl|radmin|^tap|^tun/i

/** Candidate addresses, best first, with the reason each one ranks where it does. */
export function lanCandidates() {
  const found = []
  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      const virtual = VIRTUAL_INTERFACE.test(interfaceName)
      const isPrivate = isPrivateAddress(entry.address)
      found.push({
        address: entry.address,
        interface: interfaceName,
        virtual,
        private: isPrivate,
        // Higher is better: a real private address on a real interface wins.
        rank: (isPrivate ? 4 : 0) + (virtual ? 0 : 2),
      })
    }
  }
  found.sort((left, right) => right.rank - left.rank || left.address.localeCompare(right.address))
  return found
}

/** Where this plugin keeps the operator's chosen address. */
function settingsPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'mobile-direct', 'settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(patch) {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = { ...readSettings(), ...patch }
  fs.writeFileSync(file, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
  return next
}

/** The address to advertise: config, then the operator's saved choice, then the best candidate. */
export function chooseAddress(config) {
  const candidates = lanCandidates()
  const saved = readSettings().lanAddress
  const preferred = [config.lanAddress, saved].filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const wanted of preferred) {
    const match = candidates.find((candidate) => candidate.address === wanted.trim())
    if (match) return match
  }
  return candidates[0]
}

/** One plain-HTTP request to the relay's own listener, with the `Host` we want it to believe. */
function relayRequest({ port, hostHeader, requestPath, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'text/html,application/json' }
    if (hostHeader !== undefined) headers.Host = hostHeader
    if (method === 'POST') headers['Content-Length'] = '0'
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, method, headers },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/**
 * Read the live code and its remaining validity out of the relay's operator page.
 *
 * The page is the relay's own markup — `<div class="code">12345678</div>` followed
 * by `Expires in N seconds, and works once.` — and there is no JSON route that
 * exposes a pairing code, because issuing one is an operator action by design.
 * Reading it here is the same action the operator would take by eye; the only
 * difference is that we then put the right address next to it.
 */
export function parseOperatorPage(html) {
  const code = /<div class="code">\s*(\d{6,12})\s*<\/div>/.exec(html)
  const ttl = /Expires in (\d+) seconds/.exec(html)
  const named = /dsh-relay|Pair a device/.test(html)
  return {
    code: code === null ? undefined : code[1],
    ttlSeconds: ttl === null ? undefined : Number(ttl[1]),
    lookedLikeRelay: named,
  }
}

/** Mint a fresh code at the relay, then read it back. */
async function readRelayCode(config, { forceNew }) {
  const port = config.relayPort
  const address = chooseAddress(config)
  const hostHeader = address === undefined ? undefined : `${address.address}:${port}`
  if (forceNew) {
    await relayRequest({ port, hostHeader, requestPath: '/relay/pair/new', method: 'POST' })
  }
  const page = await relayRequest({ port, hostHeader, requestPath: '/relay/pair' })
  if (page.status !== 200) {
    return { ok: false, status: page.status, reason: page.status === 403 ? 'host-refused' : `http-${page.status}` }
  }
  const parsed = parseOperatorPage(page.body)
  if (parsed.code === undefined) {
    return { ok: false, status: page.status, reason: parsed.lookedLikeRelay ? 'no-code-on-page' : 'not-a-relay' }
  }
  return {
    ok: true,
    code: parsed.code,
    ttlSeconds: parsed.ttlSeconds,
    expiresAt: Date.now() + (parsed.ttlSeconds ?? 300) * 1000,
    address,
    origin: `${config.relayScheme}://${address === undefined ? '127.0.0.1' : address.address}:${port}`,
  }
}

/** The whole state the UI needs, in one object. */
async function buildState(config, { refresh = false } = {}) {
  const candidates = lanCandidates()
  const address = chooseAddress(config)
  let relay
  try {
    relay = await readRelayCode(config, { forceNew: refresh })
  } catch (error) {
    relay = { ok: false, reason: 'unreachable', message: String(error && error.message ? error.message : error) }
  }
  if (!relay.ok) {
    return {
      ok: false,
      reason: relay.reason,
      message: relay.message,
      relayPort: config.relayPort,
      relayScheme: config.relayScheme,
      candidates,
      address: address === undefined ? undefined : address.address,
    }
  }
  const origin = relay.origin
  const payload = {
    v: PAYLOAD_VERSION,
    kind: PAYLOAD_KIND,
    url: origin,
    code: relay.code,
    expiresAt: relay.expiresAt,
  }
  return {
    ok: true,
    generatedAt: Date.now(),
    relayPort: config.relayPort,
    relayScheme: config.relayScheme,
    address: address === undefined ? undefined : address.address,
    addressInterface: address === undefined ? undefined : address.interface,
    candidates,
    code: relay.code,
    expiresAt: relay.expiresAt,
    ttlSeconds: relay.ttlSeconds,
    origin,
    payload,
    /** What a client scans to enrol and mint a device token. */
    appPayloadText: JSON.stringify(payload),
    /** What a browser opens to claim this code with one tap. */
    browserEntryUrl: `${origin}/relay/pair?code=${relay.code}`,
    /** The relay's own root, once a session or token exists there. */
    browserUrl: `${origin}/`,
    /** Devices are managed on the relay; URL kept here so the panel can link it. */
    devicesUrl: `${origin}/relay/devices`,
  }
}

/** Render any string as an inline SVG QR. */
async function renderQr(text) {
  return QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0f1115', light: '#ffffff' },
  })
}

/** JSON or HTML out of one handler. */
function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, undefined, 2)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendSvg(res, status, body) {
  res.writeHead(status, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * The top-right badge and its panel.
 *
 * Injected into the index document rather than registered as a client plugin, so
 * it needs no build step and appears identically in the desktop shell and in any
 * browser — including the phone's, which is where the QR most needs to be
 * readable. Everything it renders comes from `/mobile-direct/state.json`.
 */
const BADGE_ID = 'dsh-mobile-direct-badge'

function badgeMarkup() {
  const css = [
    `#${BADGE_ID}{position:fixed;right:16px;top:56px;z-index:2147483000;font:13px/18px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif)}`,
    `#${BADGE_ID} .md-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:15px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.08);opacity:.9}`,
    `#${BADGE_ID} .md-btn:hover{opacity:1;color:var(--dsw-alias-label-primary,#0f1115)}`,
    `#${BADGE_ID} .md-panel{display:none;margin-top:8px;width:276px;padding:14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary,#0f1115)}`,
    `#${BADGE_ID}.md-open .md-panel{display:block}`,
    `#${BADGE_ID} h4{margin:0 0 8px;font-size:13px;font-weight:600}`,
    `#${BADGE_ID} .md-qr{display:flex;justify-content:center;padding:8px;background:#fff;border-radius:10px}`,
    `#${BADGE_ID} .md-qr img{width:200px;height:200px;display:block}`,
    `#${BADGE_ID} .md-code{margin:10px 0 2px;text-align:center;font:600 22px/28px var(--ds-font-family-code,Consolas,monospace);letter-spacing:.16em}`,
    `#${BADGE_ID} .md-note{margin:6px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98)}`,
    `#${BADGE_ID} .md-row{display:flex;gap:6px;margin-top:10px}`,
    `#${BADGE_ID} .md-row button,#${BADGE_ID} .md-row a{flex:1;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font:inherit;text-decoration:none;cursor:pointer}`,
    `#${BADGE_ID} select{width:100%;height:28px;margin-top:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font:inherit}`,
    `#${BADGE_ID} .md-tabs{display:flex;gap:4px;margin-bottom:8px}`,
    `#${BADGE_ID} .md-tabs button{flex:1;height:26px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.6}`,
    `#${BADGE_ID} .md-tabs button.md-on{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}`,
    `#${BADGE_ID} .md-err{margin:8px 0 0;font-size:12px;line-height:17px;color:#c33b38}`,
  ].join('\n')

  const script = [
    '(function(){',
    `var root=document.getElementById('${BADGE_ID}');`,
    'if(!root||root.dataset.ready==="1")return;root.dataset.ready="1";',
    'var img=root.querySelector(".md-qr img"),codeEl=root.querySelector(".md-code"),noteEl=root.querySelector(".md-note"),errEl=root.querySelector(".md-err"),sel=root.querySelector("select"),entry=root.querySelector(".md-entry"),devices=root.querySelector(".md-devices");',
    'var target="app";',
    'function setTarget(next){target=next;var buttons=root.querySelectorAll(".md-tabs button");for(var i=0;i<buttons.length;i++){buttons[i].className=buttons[i].dataset.t===next?"md-on":""}load(false)}',
    'function load(force){',
    '  var url="/mobile-direct/state.json"+(force?"?refresh=1":"")+(target==="browser"?"&qr=browser":"&qr=app");',
    '  fetch(url,{headers:{Accept:"application/json"}}).then(function(r){return r.json()}).then(function(state){',
    '    if(!state.ok){errEl.textContent="无法从 dsh-relay 取到配对码："+(state.reason||"unknown")+(state.message?(" ("+state.message+")"):"");img.removeAttribute("src");codeEl.textContent="";noteEl.textContent="请确认 dsh-relay 已安装并运行，端口 "+state.relayPort+" 可达。";return}',
    '    errEl.textContent="";img.src=state.qrDataUrl;codeEl.textContent=state.code||"";',
    '    if(target==="app"){noteEl.textContent="用 DSH Mobile App 的「Relay → Pair a relay」扫这个码：手机自动配对，拿到设备令牌（默认 30 天）。"}',
    '    else{noteEl.textContent="手机浏览器扫这个码，页面上点一下 Pair 即可进入（无需密码）。"}',
    '    entry.href=state.browserEntryUrl;devices.href=state.devicesUrl;',
    '    if(state.candidates&&state.candidates.length>1){',
    '      var html="";for(var i=0;i<state.candidates.length;i++){var c=state.candidates[i];html+="<option value=\""+c.address+"\""+(c.address===state.address?" selected":"")+">"+c.address+"  ("+c.interface+")</option>"}',
    '      sel.innerHTML=html;sel.style.display="block";',
    '    }else{sel.style.display="none"}',
    '  }).catch(function(e){errEl.textContent="请求失败："+e.message})',
    '}',
    'root.querySelector(".md-toggle").addEventListener("click",function(){root.classList.toggle("md-open");if(root.classList.contains("md-open"))load(false)});',
    'root.querySelector(".md-refresh").addEventListener("click",function(){load(true)});',
    'var tabs=root.querySelectorAll(".md-tabs button");for(var i=0;i<tabs.length;i++){tabs[i].addEventListener("click",function(){setTarget(this.dataset.t)})}',
    'sel.addEventListener("change",function(){fetch("/mobile-direct/address",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({address:this.value})}).then(function(){load(true)})});',
    '})();',
  ].join('\n')

  return `<style>\n${css}\n</style>
<div id="${BADGE_ID}">
<div class="md-btn md-toggle" role="button" tabindex="0" title="dsh-mobile-direct — 手机扫码直连">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" stroke="currentColor" stroke-width="1.7"/><path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" fill="currentColor"/></svg>
<span>手机直连</span>
</div>
<div class="md-panel">
  <div class="md-tabs">
    <button class="md-on" data-t="app" type="button">App 配对</button>
    <button data-t="browser" type="button">手机浏览器</button>
  </div>
  <div class="md-qr"><img alt="配对二维码" width="200" height="200"></div>
  <div class="md-code"></div>
  <p class="md-note"></p>
  <select title="选择要广播的局域网地址"></select>
  <div class="md-row">
    <button class="md-refresh" type="button">换一个码</button>
    <a class="md-entry" href="#" target="_blank" rel="noreferrer">浏览器进入</a>
  </div>
  <div class="md-row"><a class="md-devices" href="#" target="_blank" rel="noreferrer">已配对设备</a></div>
  <p class="md-err"></p>
</div>
</div>
<script>${script}</script>`
}

function injectBadge(html) {
  if (html.includes(BADGE_ID)) return html
  const close = html.lastIndexOf('</body>')
  if (close < 0) return html
  return `${html.slice(0, close)}${badgeMarkup()}\n${html.slice(close)}`
}

/** The standalone page: same information, for a browser that never loaded the SPA. */
function standalonePage(state) {
  const candidates = (state.candidates ?? [])
    .map((candidate) => `<li>${candidate.address} <span class="muted">(${candidate.interface})</span></li>`)
    .join('')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-mobile-direct</title></head>
<body style="font:14px/1.5 system-ui,'Microsoft YaHei',sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1 style="font-size:20px">手机扫码直连</h1>
<p>本机候选地址：</p><ul>${candidates}</ul>
<p>接口：<code>/mobile-direct/state.json</code> · <code>/mobile-direct/qr.svg</code> · <code>/mobile-direct/entry</code></p>
</body></html>`
}

/** Everything the plugin owns, mounted under one prefix. */
function handle(request, response, config) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(PREFIX.length) || '/'

  const run = async () => {
    if (route === '/' || route === '') {
      return sendHtml(response, 200, standalonePage({ candidates: lanCandidates() }))
    }
    if (route === '/state.json') {
      const refresh = url.searchParams.get('refresh') === '1'
      const wantsBrowserQr = url.searchParams.get('qr') === 'browser'
      let state
      try {
        state = await buildState(config, { refresh })
      } catch (error) {
        return sendJson(response, 200, { ok: false, reason: 'error', message: String(error) })
      }
      if (state.ok) {
        try {
          const qrText = wantsBrowserQr ? state.browserEntryUrl : state.appPayloadText
          state.qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(await renderQr(qrText), 'utf8').toString('base64')}`
        } catch (error) {
          state.qrError = String(error)
        }
      }
      return sendJson(response, 200, state)
    }
    if (route === '/qr.svg') {
      const wantsBrowserQr = url.searchParams.get('target') === 'browser'
      const state = await buildState(config, { refresh: url.searchParams.get('refresh') === '1' })
      if (!state.ok) return sendJson(response, 503, state)
      return sendSvg(response, 200, await renderQr(wantsBrowserQr ? state.browserEntryUrl : state.appPayloadText))
    }
    if (route === '/address' && request.method === 'POST') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body.address === 'string' && body.address.trim() !== '') {
          writeSettings({ lanAddress: body.address.trim() })
          return sendJson(response, 200, { ok: true, address: body.address.trim() })
        }
      } catch {
        /* fall through to the error below */
      }
      return sendJson(response, 400, { ok: false, reason: 'bad-request' })
    }
    return sendJson(response, 404, { ok: false, reason: 'not-found', route })
  }

  run().catch((error) => {
    try {
      sendJson(response, 500, { ok: false, reason: 'handler-crashed', message: String(error) })
    } catch {
      /* the response is already gone */
    }
  })
}

/** Mount the routes and the badge, and take both back down with this plugin. */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (request, response) => handle(request, response, resolved),
      }),
    ]
    if (resolved.badge) disposers.push(ctx.webServer.tapIndex(injectBadge))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    }
  })
}
