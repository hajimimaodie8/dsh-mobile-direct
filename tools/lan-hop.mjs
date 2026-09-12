#!/usr/bin/env node
/**
 * lan-hop — the missing middle hop for DSH Mobile, as a standalone process.
 *
 * Why a separate process, and not a plugin: the same logic was first written as
 * a harness plugin, and it killed the harness twice (heap exhaustion, `exit code
 * 134`, desktop safe mode). Whatever the trigger was, it lived inside that
 * process — so this version deliberately lives outside it. It can be killed,
 * crashed, or restarted without the harness noticing.
 *
 * What it does:
 *
 *   1. finds the running harness (its port, from the desktop shell's log);
 *   2. mints a pairing code and prints the payload a DSH Mobile app scans;
 *   3. serves the `/relay/*` routes that app expects, so pairing needs no
 *      separate plugin;
 *   4. proxies everything else to the harness with a browser-session cookie it
 *      signs itself from the harness's own durable secret — which is the one
 *      thing neither the app nor `dsh-relay` 0.2.1 can do, and the reason every
 *      `/api` call would otherwise be a 401.
 *
 * Usage:
 *   node tools/lan-hop.mjs                 # port 3455, all interfaces
 *   node tools/lan-hop.mjs --port 3455 --harness 53210
 *   node tools/lan-hop.mjs --dsh-home "C:\\Users\\me\\.dsh"
 *
 * The QR/payload it prints is also rendered by the browser entry page it serves.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createEntry } from '../lib/entry.js'

/** Where the harness keeps its home, for a machine running the desktop shell. */
function candidateHomes() {
  const homes = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') homes.push(process.env.DSH_HOME.trim())
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  homes.push(path.join(appData, 'dsh-desktop', 'harness'))
  homes.push(path.join(os.homedir(), '.dsh'))
  return homes
}

/** The harness home that actually has a credential store. */
function resolveDshHome(explicit) {
  const homes = explicit === undefined ? candidateHomes() : [explicit]
  for (const home of homes) {
    if (fs.existsSync(path.join(home, '.credentials.yaml'))) return home
  }
  return homes[0]
}

/** The harness port the desktop shell last started, from its own log. */
function discoverHarnessPort(logFile, explicit) {
  if (explicit !== undefined) return explicit
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const matches = [...text.matchAll(/endpoint http:\/\/127\.0\.0\.1:(\d+)/g)]
    if (matches.length > 0) return Number(matches[matches.length - 1][1])
  } catch {
    /* fall through */
  }
  return undefined
}

function parseArgs(argv) {
  const args = { port: 3455, bind: '0.0.0.0', harness: undefined, dshHome: undefined, logFile: undefined }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--port') { args.port = Number(value); index++ }
    else if (flag === '--bind') { args.bind = String(value); index++ }
    else if (flag === '--harness') { args.harness = Number(value); index++ }
    else if (flag === '--dsh-home') { args.dshHome = String(value); index++ }
    else if (flag === '--log') { args.logFile = String(value); index++ }
    else if (flag === '--help' || flag === '-h') { args.help = true }
  }
  return args
}

const HELP = `lan-hop — pairing + authenticated proxy for DSH Mobile, outside the harness

  --port <n>        port to listen on (default 3455)
  --bind <addr>     interface to bind (default 0.0.0.0)
  --harness <n>     harness port (default: discovered from the desktop log)
  --dsh-home <dir>  harness home holding .credentials.yaml
  --log <file>      desktop harness log to read the port from
`

/** Every non-loopback IPv4 a phone could plausibly reach, best first. */
async function lanAddresses() {
  const { lanCandidates } = await import('../lib/index.js')
  return lanCandidates().map((entry) => entry.address)
}

/**
 * Write a page carrying both QRs and open it.
 *
 * The app scans the JSON payload; a phone camera (or any browser) scans the
 * browser-entry link. `qrcode` is a normal dependency, so this is best-effort:
 * without it the terminal output still carries the payload verbatim, which the
 * app's pairing screen also accepts as pasted text.
 */
async function writeQrPage({ payload, browserEntryUrl }) {
  let qrcode
  try {
    qrcode = (await import('qrcode')).default
  } catch {
    return undefined
  }
  const options = { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }
  const appSvg = await qrcode.toString(JSON.stringify(payload), options)
  const browserSvg = await qrcode.toString(browserEntryUrl, options)
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>lan-hop 扫码</title>
<style>
 body{font:15px/1.6 system-ui,'Microsoft YaHei',sans-serif;margin:0;padding:28px;background:#0f1115;color:#e8eaed}
 h1{font-size:19px;margin:0 0 4px} p{margin:0 0 20px;color:#9aa0a6;font-size:13px}
 .row{display:flex;gap:28px;flex-wrap:wrap}
 .card{background:#fff;color:#0f1115;border-radius:14px;padding:18px;text-align:center;min-width:280px}
 .card h2{font-size:15px;margin:0 0 10px} svg{width:240px;height:240px}
 code{font-size:12px;word-break:break-all;color:#5f6368}
</style></head><body>
<h1>扫码直连</h1>
<p>左边给手机 App：<b>中继 → 配对中继</b> 扫它。右边给手机浏览器：相机扫它就直接进入。</p>
<div class="row">
 <div class="card"><h2>App 配对码</h2>${appSvg}<p><code>${escapeForHtml(JSON.stringify(payload))}</code></p></div>
 <div class="card"><h2>手机浏览器</h2>${browserSvg}<p><code>${escapeForHtml(browserEntryUrl)}</code></p></div>
</div></body></html>`
  const file = path.join(os.tmpdir(), 'lan-hop-qr.html')
  fs.writeFileSync(file, html, 'utf8')
  return file
}

function escapeForHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(HELP)
    return
  }

  const dshHome = resolveDshHome(args.dshHome)
  // The entry reads its secret through `$DSH_HOME`; point it at the resolved home.
  process.env.DSH_HOME = dshHome
  // …but never let it write state into that tree: the desktop shell watches it
  // for configuration changes, and that feedback loop is what killed the harness
  // when this logic still ran as a plugin. Keep every write far away from it.
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  process.env.DSH_LAN_HOP_STATE =
    process.env.DSH_LAN_HOP_STATE ?? path.join(localAppData, 'dsh-lan-hop', 'devices.json')

  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  const logFile = args.logFile ?? path.join(appData, 'dsh-desktop', 'logs', 'harness.log')
  const harnessPort = discoverHarnessPort(logFile, args.harness)
  if (harnessPort === undefined) {
    console.error(`lan-hop: could not find the harness port in ${logFile} — pass --harness <port>`)
    process.exitCode = 1
    return
  }

  const entry = createEntry({
    ctx: { webServer: { port: harnessPort } },
    config: {
      entryPort: args.port,
      entryBind: args.bind,
      pairingCodeLength: 8,
      entryMode: 'direct',
    },
    log: console,
  })
  await entry.start()

  const addresses = await lanAddresses()
  const address = addresses[0] ?? '127.0.0.1'
  const info = entry.describe(address)
  const payload = {
    v: 1,
    kind: 'dsh-relay-pair',
    url: info.origin,
    code: info.code,
    expiresAt: info.expiresAt,
  }

  console.log('')
  console.log(`  harness       127.0.0.1:${String(harnessPort)}   (DSH_HOME ${dshHome})`)
  console.log(`  lan hop       ${info.origin}   (binding ${args.bind}:${String(args.port)})`)
  if (addresses.length > 1) console.log(`  other addrs   ${addresses.slice(1).join(', ')}`)
  console.log('')
  console.log('  手机 App：「中继 → 配对中继」扫下面这个载荷生成的二维码，或直接粘贴这段 JSON：')
  console.log('')
  console.log(`  ${JSON.stringify(payload)}`)
  console.log('')
  console.log(`  手机浏览器直接进入： ${info.browserEntryUrl}`)
  console.log(`  已配对设备与撤销：   ${info.devicesUrl}   （仅本机可访问）`)
  const qrPage = await writeQrPage({ payload, browserEntryUrl: info.browserEntryUrl })
  if (qrPage !== undefined) console.log(`  二维码页面（双击或用浏览器打开）： ${qrPage}`)
  console.log('')
  console.log('  配对码 15 分钟有效、一次性；过期后重启本程序即可换新。Ctrl+C 退出。')
  console.log('')

  const shutdown = async () => {
    console.log('\nlan-hop: stopping')
    await entry.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  console.error(`lan-hop failed: ${String(error?.stack ?? error)}`)
  process.exit(1)
})
