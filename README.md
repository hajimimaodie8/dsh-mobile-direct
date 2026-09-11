# dsh-mobile-direct

**一次扫码，手机直接进入电脑上的 DeepSeek Harness。**

在 harness 网页界面右上角放一个二维码入口：手机 App 扫一下就完成配对（拿到设备令牌，默认 30 天免配对）；手机浏览器扫另一个码，点一下就能进入——不留密码、不装证书、不填端口。

---

## 它解决的问题

`dsh-relay` 已经会配对：`/relay/pair` 会渲染一个二维码，客户端（DSH Mobile App，或任何实现 relay `CLIENT_INTEGRATION` 的客户端）读它、认领里面的配对码、换到设备令牌。

它唯一做不到的，是**把正确的地址放进那个二维码**。relay 用「你打开这个页面时用的 `Host`」来拼载荷——而所有人都是在那台跑 harness 的电脑上、用 `http://127.0.0.1:3443/relay/pair` 打开的，于是二维码里装的是 `127.0.0.1`，手机扫了等于让手机连它自己。

本插件只补这一环：

- 通过 loopback 以**操作者**身份向 relay 取一个实时配对码（relay 因此才会签发），同时在 `Host` 头里声明**局域网地址**——这样拼出来的载荷里是手机真正能访问的地址；
- 把载荷渲染成二维码（App 用），再给一个浏览器用的入口二维码（`/relay/pair?code=…`，点一下就进）；
- 在右上角面板里让你**选择要广播的本机地址**，因为装了 VMware / Hyper-V / WSL 的机器有好几个私有地址，只有一个在手机所在的网络里。

它**不**自己实现代理、隧道或鉴权：手机唯一要连的仍然是 relay，拿到的也是 relay 自己的令牌。

---

## 依赖

| 依赖 | 说明 |
| --- | --- |
| **dsh-relay** ≥ 0.2.0 | **必需**。它是底层通道：TLS/明文监听、`/relay/pair`、设备令牌、以及**服务端代签 harness 会话 cookie**——这正是纯 `http://` + IP 的浏览器进不去的原因（harness 0.1.2 的会话 cookie 是 `Secure` 的，浏览器在明文 http 上存不住，必须由服务端代签；dsh-pocket 的局域网入口卡在这一点上，见其 issue #91）。 |
| DeepSeek Harness ≥ 0.1.2 | 提供 `webServer` 路由与 index 注入缝。 |
| Node ≥ 22.19 或 ≥ 24 | 跟随 harness 运行时。 |

---

## 安装

```sh
# 1) 先装底层通道
dsh plugin --profile web add dsh-relay
# 2) 再装本插件
dsh plugin --profile web add dsh-mobile-direct
# 3) 重启 harness
```

通过插件市场安装（可选）：重启后在 **设置 → 插件市场** 里搜索 `dsh-mobile-direct`，一键安装，然后重启。

装好后不需要任何配置。右上角会出现 **「手机直连」** 按钮。

> ⚠️ 如果你之前用 `file://` 开发方式在 `profiles/web/cordis.patch.yml` 里插过一行 `mobile-direct`，**请先删掉那一行**再安装正式包，否则两个同 id 的 row 会冲突。

---

## 使用

点右上角 **「手机直连」**：

### ① App 配对（推荐，一次就好）

1. 手机打开 **DSH Mobile** → `Relay → Pair a relay`；
2. 扫面板里的二维码。

App 会读到一个 JSON 载荷：

```json
{
  "v": 1,
  "kind": "dsh-relay-pair",
  "url": "http://192.168.1.6:3443",
  "code": "27157965",
  "expiresAt": 1789140086869
}
```

然后用 `POST {url}/relay/pair`（`Content-Type: application/json`，body `{code, name}`）换取 `{deviceId, token, expiresAt}`，之后所有 `/api` 调用与两条 WebSocket 上行都带这个令牌。**配对成功后不用再扫**——令牌默认 30 天，到期才需要重配。

> 载荷字段与版本号是这个 App 硬校验的：`kind` 必须是 `dsh-relay-pair`，`v` 不能高于 1。本插件按此生成，并跟随 relay 的默认值（`pairingCodeLength: 8`、`pairingWindowMs` 默认 5 分钟，本仓库文档建议放宽到 15 分钟）。

### ② 手机浏览器进入

切到面板的 **「手机浏览器」** 标签，用手机相机/浏览器扫那个码：它会打开 `/relay/pair?code=…`（配对码已填好），**点一下 `Pair`** 就进去了，不需要密码。

### 地址选错了怎么办

面板底部的下拉框列出本机所有候选地址（含网卡名）。选对之后会记住（写在 `$DSH_HOME/mobile-direct/settings.json`），也可用配置项 `lanAddress` 固定。

---

## 配置（全部可选）

写在 profile 的 `cordis.patch.yml` 里（按 id 覆盖，会整体替换 config，所以要把想保留的项都写上）：

```yaml
- id: mobile-direct
  config:
    relayPort: 3443        # relay 的监听端口
    relayScheme: 'http'    # 与 relay 的 tls 设置一致：'off' → http，自签/证书 → https
    lanAddress: '192.168.1.6'  # 固定广播地址；留空则由面板下拉选择
    badge: true            # 是否注入右上角入口
```

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /mobile-direct/state.json` | 状态、候选地址、载荷、配对码、两个入口 URL，以及内联的二维码 data URL。`?refresh=1` 换一个新码，`?qr=browser` 让二维码指向浏览器入口。 |
| `GET /mobile-direct/qr.svg` | 直接返回二维码 SVG（`?target=browser` 切到浏览器入口）。 |
| `POST /mobile-direct/address` | `{"address":"192.168.1.6"}`，记住要广播的地址。 |
| `GET /mobile-direct/` | 一个朴素的说明页。 |

这些路由都在 harness 自己的 web server 上，所以也能通过 relay 的 origin 访问到。

---

## 安全

- 本插件自身**不监听任何端口**，也不持有任何凭据；它只是把 relay 已经签发的配对码写进二维码。
- 手机最终拿到的凭据是 **relay 的设备令牌**，与手动配对完全等价，随时可在 `http://<地址>:3443/relay/devices` 逐个撤销。
- 若 relay 用 `tls: 'off'`（明文 http），局域网内传输是明文的——适合家里自用，**公共/公司 WiFi 请不要这么配**；改回自签证书或自有证书即可加密（此时 App 会按二维码里的 `fingerprint` 做公钥固定，不需要你装 CA）。
- 配对码是**一次性**的，5～15 分钟内有效；面板上的「换一个码」会立即作废旧码。

---

## 开发

```sh
npm install          # 只有一个运行时依赖 qrcode
```

在本机调试时不需要反复重启 harness——用 profile 的 patch 层以 `file://` 热加载即可（**注意 Windows 路径里的空格要转义为 `%20`**）：

```yaml
- insert:
    - id: mobile-direct
      name: 'file:///D:/deepseek%20harness/dsh-mobile-direct/lib/index.js'
      config:
        relayPort: 3443
        relayScheme: 'http'
```

本地源码目录里需要有 `node_modules/qrcode`（开发期从 profile 的 `node_modules/qrcode` 做个 junction 即可）。

## 许可

MIT。

## 致谢

- [`dsh-relay`](https://github.com/sorsama/deepseek-harness-relay)（sorsama）——底层通道与 `/relay/pair` 契约，以及「服务端代签 harness 会话」这一关键设计。
- [DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile)（sorsama）——本插件的载荷格式即按其 `core/wire/RelayPairing.kt` 的解析规则对齐。
- [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（shaobeichen）——「手机访问」这一交互形态的先例。
