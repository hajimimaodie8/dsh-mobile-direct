# dsh-mobile-direct

**一次扫码，手机直接进入电脑上的 DeepSeek Harness。**

在 harness 网页界面右上角放一个二维码入口：

- **手机 App**（DSH Mobile）扫一下即完成配对，拿到设备令牌（默认 30 天，之后不用再扫）；
- **手机浏览器**扫另一个码，直接进入——不输密码、不点确认、不装证书。

---

## 它解决的两个真实问题

### 一、二维码里的地址不能用

harness 的配对二维码如果由 `dsh-relay` 生成，里面的地址取自"你打开那个页面时用的 `Host`"。而所有人都是在跑 harness 的那台电脑上、用 `http://127.0.0.1:3443/relay/pair` 打开的，于是二维码里装的是 `127.0.0.1`——手机扫了等于让手机连它自己。

本插件改为**自己签发配对码、自己拼载荷**，把地址写成本机真正可达的局域网地址。

### 二、更根本的：`/api` 全是 401

Harness **0.1.2 起了鉴权**：整个 `/api` 面（每个一元调用 + 两条 WebSocket 上行）都要求一个**签名且绑定 authority 的 cookie**，没有就 401。手机拿不到它——启动令牌每个进程只打印一次、只在 index 路由上接受、且从不持久化。

所以中间必须有**一个跑在这台机器上的东西**替你签这个 cookie。这正是这条路能通的关键。

> `dsh-relay` 0.2.1 做不到这件事：它的类型面（`lib/types/harness-session.d.ts`）明确写了"relay 应从 `ctx.credentials` 读密钥、自己签一个 harness 会话 cookie 给上游"，但它的运行时里没有这个实现——`lib/index.js` 把客户端的 `Authorization`/`Cookie` 删掉后原样转发（`RELAY_ONLY`），上游请求只改了 `Host`。于是**配对能成功，之后每个 `/api` 调用都是 401**。（本插件因此不再依赖它。）

---

## 工作原理

```
手机 ──http──▶ dsh-mobile-direct :3444 ──重新签发会话──▶ harness 127.0.0.1:<port>
                ├─ /relay/health      {service:"dsh-relay",ok:true}
                ├─ /relay/pair        配对：JSON 契约，换设备令牌
                ├─ /relay/devices     已配对设备与撤销（仅本机）
                ├─ /?k=<一次性密钥>    浏览器一键进入（落 cookie 后 302 到 /）
                └─ 其它一切 ──代理（含 WebSocket）──▶ harness
```

- 会话 cookie 按 `@deepseek-ai/dsh-client-connection` 的规格现签现用：
  `dsh-auth-<base64url(sha256(authority))> = v1.<payload>.<HMAC-SHA256(secret, body)>`，
  密钥从 harness 自己的凭据记录 `client-connection/browser-session` 读取（优先走 `ctx.credentials`，回退到 `$DSH_HOME/.credentials.yaml`）。
- 手机侧的身份校验：**设备令牌**（App）、**一次性密钥换来的签名 cookie**（浏览器），或 loopback（操作者）。其它一律 403。
- 本插件**不监听公网、不存储你的 harness 凭据**，也不改动 harness 自身。

## 依赖

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness ≥ 0.1.2 | 提供 `webServer` 路由与 index 注入缝；也是它要求那个会话 cookie。 |
| Node ≥ 22.19 或 ≥ 24 | 跟随 harness 运行时。 |
| `dsh-relay` | **不再必需**。只有把 `entryMode` 设为 `'relay'`（用它的配对页出码）时才需要。 |

## 安装

```sh
dsh plugin --profile web add dsh-mobile-direct
# 然后重启 harness
```

装好后不需要任何配置。右上角出现 **「手机直连」**：点开 →「App 配对」用 App 扫；「手机浏览器」用相机扫。

## 使用

1. **App**：`DSH Mobile → 中继 → 配对中继` → 扫「App 配对」那个码。载荷是：

   ```json
   {
     "v": 1,
     "kind": "dsh-relay-pair",
     "url": "http://192.168.1.6:3444",
     "code": "02602725",
     "expiresAt": 1789142081733
   }
   ```

   App 会用 `POST {url}/relay/pair`（JSON，`{code, name}`）换 `{deviceId, token, expiresAt}`，之后所有 `/api` 与两条 WebSocket 都带这个令牌。

2. **浏览器**：扫「手机浏览器」那个码 → 直接进入（链接里带一次性密钥，用掉即失效并落成签名 cookie）。

3. **管理**：面板里的「设备」链接（或 `http://<局域网地址>:3444/relay/devices`，仅本机可访问）→ 逐个撤销。

## 配置（全部可选）

```yaml
- id: mobile-direct
  config:
    entryMode: 'direct'   # 'direct' = 本插件自己的入口（推荐）；'relay' = 用 dsh-relay 出码
    entryEnabled: true    # 关掉则只剩界面面板，不再监听
    entryPort: 3444       # 入口端口
    entryBind: '0.0.0.0'  # 绑定地址
    lanAddress: ''        # 固定广播的局域网地址；留空则自动挑选并在面板里可切换
    badge: true           # 是否注入右上角入口
```

## 已知边界

- **版本匹配很重要**：DSH Mobile App 自己的兼容表写明 —— `0.10.0` 对应 harness `0.1.3-alpha.1`，`0.9.x` 对应 `0.1.2-alpha.1`，**两者不能互换**（0.10.0 的 App 对 0.1.2 的 harness 会请求 `session/follow` 这个 0.1.2 不认识的流，并给 `commands/execute` 传一个 0.1.2 未声明的参数）。本插件解决的是"配对与鉴权"，**版本错配仍需自行对齐**。
- 明文 `http://`：局域网内传输是明文的（家用可以；公共 WiFi 请不要这么用）。要做加密需要给入口配证书，并让 App 侧信任——目前不在本插件范围内。
- 入口只面向局域网；不要把它转发到公网。

## 开发

```sh
npm install
```

用 profile 的 patch 层以 `file://` 热加载时注意两点：Windows 路径里的空格要写 `%20`；**ESM 模块按 URL 缓存**，改代码后要么换一个新路径（如复制到 `build/lib/`），要么重启 harness——只改查询串不一定生效。

## 许可

MIT。

## 致谢

- [`dsh-relay`](https://github.com/sorsama/deepseek-harness-relay)（sorsama）——`/relay/*` 的接口形态与 `CLIENT_INTEGRATION` 契约；本插件按同一契约实现，以便 App 无需改动。
- [DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile)（sorsama）——载荷解析规则以它的 `core/wire/RelayPairing.kt` 为准。
- `@deepseek-ai/dsh-client-connection`——会话 cookie 的权威规格。
