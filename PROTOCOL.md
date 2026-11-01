# Alma-style E2E Relay Protocol — `relay-e2e/v1`

沉淀自 Alma v0.4.213 逆向（经作者 yetone 许可；协议常量原值 `alma-relay-e2e/v1`）。
本文档是规范：服务器、桌面 agent、手机 client 三方都按此实现，互相兼容。

## 0. 角色

```
┌──────────┐  出站 WS (注册一次,常驻)     ┌─────────────┐   出站 WS (用时连)    ┌────────┐
│ Desktop  │ ────────────────────────▶ │    Relay     │ ◀────────────────── │ Phone  │
│ agent    │   /agent?th=<tokenHash>   │  (盲转字节)   │  /c/<rt>/__e2e__    │ client │
└──────────┘                           └─────────────┘                      └────────┘
     │                                                                        │
     └───────────────── E2E 加密隧道（relay 只见密文）──────────────────────────┘
```

- **Desktop agent**：内网里的机器。向 relay 建立一条常驻出站 WebSocket 并注册；收到隧道帧后代理到本地 `127.0.0.1:<localPort>`（HTTP 与 WS）。
- **Relay**：只做配对路由与字节盲转。**永远看不到明文**（E2E 模式下）。
- **Phone client**：在外网的设备。与 desktop 在 relay 上会合，跑 E2E 握手，然后在加密隧道内收发 HTTP/WS 帧。

## 1. 配对凭证

| 值 | 生成 | 用途 |
|---|---|---|
| `code` | `randomBytes(32).toString("base64url")` | 共享密钥（PSK）。只存在于两端，永不上传 |
| `routingToken` | `HKDF-SHA256(code, salt="relay-e2e/v1/routing", info=∅, 128bit)` → base64url | 手机连接用的路由键；relay 日志只见它 |
| `tokenHash` | `sha256hex(routingToken)` | desktop 注册用的路由键 |

routingToken 是 code 的确定性派生 —— 拿到 code 即可算出（这是设计使然，code 即一切凭证）；
confirm 机制保证没有 code 无法完成握手。code 为 256-bit 随机数，不可暴力。

## 2. E2E 加密（`relay-e2e/v1`）

### 2.1 套件

- ECDH **P-256**（双方均生成一次性密钥对）
- HKDF-**SHA-256**
- **AES-GCM**（128-bit tag）
- 全部走 WebCrypto（Node ≥18 全局 `crypto.subtle`，浏览器同）

### 2.2 握手（3 步，PAKE 风格）

```
I → R:  {"t":"hi", "epk":<b64u>, "n":<b64u>}          // 临时公钥 + 16B nonce
R → I:  {"t":"hi", "epk":<b64u>, "n":<b64u>, "cr":<b64u>}
I → R:  {"t":"ok", "ci":<b64u>}
任一 →  {"t":"err", "message":"..."}                   // 拒绝/失败
```

密钥派生（双方对称计算）：

```
shared       = ECDH(my_eph_priv, peer_eph_pub)                     // 256 bit
transcript   = SHA256( "relay-e2e/v1" ‖ I_pub ‖ R_pub ‖ I_nonce ‖ R_nonce )
c2s          = HKDF(shared, salt=code, info="c2s|"‖transcript)      // 256 bit → AES-GCM key
s2c          = HKDF(shared, salt=code, info="s2c|"‖transcript)      // 256 bit → AES-GCM key
confirmR     = HKDF(shared, salt=code, info="confirm-r|"‖transcript) // 256 bit, 原始字节
confirmI     = HKDF(shared, salt=code, info="confirm-i|"‖transcript) // 256 bit, 原始字节
```

验证：initiator 常量时间比对 `cr`；通过后发 `ci`；responder 常量时间比对 `ci`。
任一比对失败 → `{"t":"err","message":"auth-failed"}`，会话作废。
**transcript 把双方公钥与 nonce 绑入所有密钥** → 防降级/交叉协议；**code 进 HKDF salt** → 无 code 的 MITM（包括 relay 本身）算不出 confirm。

### 2.3 帧加密

握手后所有应用帧 = JSON → UTF-8 → AES-GCM：

```
wire := IV(12B) ‖ ciphertext
IV   := 0x00×4 ‖ counter(BigEndian uint64)   // 每方向独立、从 0 严格递增
```

方向密钥分离（c2s / s2c）。**重放防护是接收端行为**：发送端严格递增只保证 nonce
不重复（GCM 下重用 IV 是灾难性的）；接收端必须拒绝 `counter ≤ 已见最大值` 的帧并
作废会话。WS 交付有序，诚实对端不可能触发此检查——只有复制帧的中间盒（恶意
relay）会。客户端/agent 双端都执行该检查。

## 3. Relay 线协议（agent ↔ server）

agent 连接 `wss://<server>/agent?th=<tokenHash>`，open 后发送：

```json
{"t":"register", "tokenHash":"<64-hex>", "name":"<device name>", "key":"<可选 JWT>"}
```

server 回复：
- `{"t":"registered"}` —— 注册成功
- `{"t":"error","message":"..."}` —— 拒绝（agent 进入 error 态）

**抢占语义**：同一 `tokenHash` 已有 agent 时，第二个注册成功，**旧连接被以 close code `4000` 踢掉**。agent 收到 4000 进入 `replaced` 状态，不再自动重连（用户显式 reconnect 才恢复）。
本 kit 的 `RelayAgent` 另提供**可选的自动回收**（`reclaimMs`，默认关闭，语义仍是上句）：被抢占后延迟重新注册抢回配对——适合无人值守的常驻部署；连续被顶（注册存活 < 60s）按 ×2 退避到上限，稳定注册（≥ 60s）后退避复位。两个都开自动回收的常驻 agent 会以递增间隔互换配对而不是震荡风暴。

服务器**以连接 URL 的 `th` 查询参数定位房间**；`register` 帧内的 `tokenHash` /
`name` / `key` 字段对通用服务器是保留字段，可忽略（本 kit 的两种服务器实现均忽略）。

心跳：agent 每 15s `ws.ping()`，一个周期无 `pong` → `terminate()` 并按退避重连（1s 起、翻倍、上限 30s；任何成功注册即复位 1s）。

agent ↔ server 的其余帧即第 4 节的隧道帧（server 转）加 `pushed`（本文档范围外，可省略；无 APNs key 的服务器不实现，agent 不得依赖）。

## 4. 隧道帧（隧道内 JSON，E2E 下为密文）

HTTP 代理（phone → agent）：

| 帧 | 字段 | 说明 |
|---|---|---|
| `hreq` | `id, method, path, headers{}, b?` | `b` = body 的 base64；GET/HEAD 不带。**请求体单帧发送、不分块**（见 §6 尺寸限制） |
| `hcancel` | `id` | 中止未完成的 hreq；client 端应立即本地 settle，不等待 agent 确认 |

HTTP 响应（agent → phone）：

| 帧 | 字段 | 说明 |
|---|---|---|
| `hres` | `id, status, headers{}` | 始终先发；响应头过滤 hop-by-hop |
| `hchunk` | `id, b` | body 分块（32KB/块），背压见 §6 |
| `hend` | `id` | body 结束 |
| `herr` | `id, message` | 失败。被 `hcancel` 中止的请求**尽力**回 `herr`（`message:"cancelled"`）——client 通常已在本地 settle 并删除 pending，迟到的 herr 无对应请求时忽略即可 |

agent 侧 HTTP 规则：剥离 `host / connection / content-length / accept-encoding`，
强制 `accept-encoding: identity`，`redirect: "manual"`（30x 原样回传，由 client 决定跟随）。

WebSocket 隧道：

| 帧 | 方向 | 字段 | 说明 |
|---|---|---|---|
| `wopen` | phone→agent* | `id, path` | 开一条本地 WS 到 `ws://127.0.0.1:port<path>` |
| `wopened` | agent→phone | `id` | 本地 WS 已建立 |
| `wmsg` | 双向 | `id, s?` 或 `id, b?` | 文本帧 `s`；二进制帧 `b`=base64 |
| `wclose` | 双向 | `id, code, reason?` | 关闭 |
| `werr` | agent→phone | `id, message` | 建立失败（仅 CONNECTING 阶段） |

\* `wopen` 有两个来源：① **非 E2E 模式**（本 kit 不实现）phone 在隧道明文里直接发；
② **E2E 模式** phone 直接 WS 连 `/c/<rt>/__e2e__`，由 **server 合成** `wopen{id, path:"/__alma_e2e__"}` 给 agent —— phone 对此无感知。

## 5. Phone 连接路径（E2E 模式）

```
1. phone  WS 连接  wss://<server>/c/<routingToken>/__alma_e2e__
2. server 计算 sha256hex(routingToken) → 定位 room（与 agent 的 tokenHash 同键）
   └─ agent 不在线：phone 挂起等待；agent 注册时对挂起者补发 wopen；60s 仍无 agent → close 4404
      （挂起期间早帧缓冲上限 **256 帧 / 64 KiB**——正常握手 3 帧合计 <1 KB，上限只约束
       恶意客户端的存储滥用；超限帧静默丢弃）
      client 的握手超时预算应 **大于 60s**，否则本地超时先到，4404 这个"桌面端不在线"
      的明确信号永远送不到端上（`@hsinsekai-nanami/client` 的 `handshakeTimeoutMs`，
      默认 70s；"socket 一直没打开"仍用较短的 `connectTimeoutMs`，两类失败因此可区分）
3. server 向 agent 发 {"t":"wopen","id":<tunnelId>,"path":"/__alma_e2e__"}
4. agent 创建 E2E responder（responder 角色）→ 回 {"t":"wopened","id":<tunnelId>}
5. phone 的 E2ESession 握手消息（JSON 字符串）与密文（二进制）：
   server 包装为 {"t":"wmsg","id":<tunnelId>,"s":...} / {"t":"wmsg","id":...,"b":...} 发给 agent
   agent 回给同 id 的 wmsg 由 server 解包后原样发回 phone WS
6. 任一侧 WS 关闭 → server 向对侧发 {"t":"wclose","id":...}（agent 侧）或直接 close（phone 侧）
```

**server 全程只做：** hash 定位、id 分配、wmsg 的包/解包转发。密文与明文对它不可区分。

## 6. 背压与尺寸限制

agent 在 `ws.bufferedAmount > 16 MiB` 时暂停读取 HTTP body（50ms 轮询）再继续发 `hchunk`。
phone client 实现对称的接收即可（WebSocket 自带 TCP 背压，通常无需额外处理）。

尺寸限制（实现相关，两套服务器不同）：

| | Workers relay（DO） | Node fixture |
|---|---|---|
| 单条 WS 消息上限 | **1 MiB**（CF 平台限制） | 256 MiB（agent 侧 `maxPayload`） |
| 响应 body | 32KB/块分块，不受影响 | 同左 |
| 请求 body | **单帧不分块**：经 base64(+33%) 与 JSON 包装后必须 < 1 MiB，即原始 body 实际上限约 **700KB** | 受 maxPayload 限制，可到 ~180MB |

超大请求体（上传）需要协议演进（请求分块），本版本不支持；H2/H3 响应流同样受
单帧限制的是 hchunk 包装层——32KB 分块已足够小。

## 7. 与 Alma 官方的兼容性

本 kit 保留握手密码学编排与帧格式原样（协议字符串改为 `relay-e2e/v1`，如需与官方
Alma 手机端互通可改回 `alma-relay-e2e/v1` 并实现其 `/c/<code>` 非 E2E 路径——默认不做）。
官方 Alma 的配对 URI 为 `alma://connect?u=<server>&k=<code>&e2e=1`，`u` 可指向任意兼容服务器。

## 8. 本 kit 明确不实现（Alma 有、通用件不需要）

- APNs 推送（`push`/`pushed` 帧、device token 管理）
- community OAuth / registrationKey 账号绑定（`key` 字段保留，服务器可忽略）
- team relay（同一通道复用、关 E2E 的变体）
- 非 E2E 兼容模式（code 明文路由，安全性降级，不沉淀）

## 9. 关闭码速查

| code | 谁发 | 含义 | 端上反应 |
|---|---|---|---|
| `1000` | 任一侧 | 正常关闭（用户 stop / 请求结束） | 清理状态，无需重连 |
| `1011` | server → phone | 注册的 agent 掉线，隧道被拆 | client `error`，可重连等 agent 回来 |
| `4000` | server → agent | 新 agent 抢占同一配对，旧连接被踢 | agent 进 `replaced`，默认**不自动重连**等用户显式 reconnect（opt-in 自动回收见 §3） |
| `4404` | server → phone | 挂起 60s 仍无 agent 注册 | client `error`，提示"桌面端未上线" |
| `1006` | 传输层 | 异常断开（无 close 帧，射频掉线/网络切换） | client `error`，结合 watchdog/lastFrameAt 判断重连 |

握手阶段的拒绝不走关闭码，走隧道内 `{"t":"err","message":"auth-failed"}`（错误码
见 §2.2）；服务器对非法路由（`th` 非 64-hex、路径不匹配）直接 HTTP 400/404。
