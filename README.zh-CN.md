# relay-kit

[English](README.md) | 中文

[![npm core](https://img.shields.io/npm/v/@hsinsekai-nanami/core?label=%40hsinsekai-nanami%2Fcore)](https://www.npmjs.com/package/@hsinsekai-nanami/core)
[![npm agent](https://img.shields.io/npm/v/@hsinsekai-nanami/agent?label=%40hsinsekai-nanami%2Fagent)](https://www.npmjs.com/package/@hsinsekai-nanami/agent)
[![npm client](https://img.shields.io/npm/v/@hsinsekai-nanami/client?label=%40hsinsekai-nanami%2Fclient)](https://www.npmjs.com/package/@hsinsekai-nanami/client)

**可自托管的端到端加密 relay server——一条命令部署到你自己的 Cloudflare
账号。** 这个 relay 刻意做得无趣：它站在手机（外网任意位置）与桌面服务之间，
只见密文字节与路由 token，解密只发生在两端。

```
手机(在外) ──密文──▶ relay(CF Workers,盲转) ◀──密文── agent(内网桌面) ──明文──▶ 127.0.0.1:<port>
```

**本仓库交付什么**——relay server 是主体，其余一切为了让它可测试、可即刻上手：

- `workers/relay` —— **relay server 本体**（Cloudflare Workers + Durable Objects），部署即用
- `packages/agent` + `packages/client` —— 两端的**参考实现**。可以直接用
  （agent 已能代理任意本地 HTTP/WS 端口），也可以按 [`PROTOCOL.md`](PROTOCOL.md) 自己实现
- `test/fixtures/relay-server.mjs` —— 协议等价的 Node relay，既是测试夹具，也是单进程自托管选项

`relay-e2e/v1` 协议通过逆向 **Alma**（v0.4.213，yetone 的 AI 助手应用）的
relay server 实现沉淀而来（经作者许可），协议分析见 `PROTOCOL.md`。项目本身
与服务无关，可挂到任何本地 HTTP/WS 端口上。注意协议字符串与官方
`alma-relay-e2e/v1` 不同，**默认与官方 Alma 客户端不互通**——互通需要什么见
PROTOCOL.md §7。

配对凭证是一个 256-bit code，同时充当路由派生盐与 PAKE 盐——没有 code 的中间人（**包括 relay 本身**）无法完成握手。

## 特性

- **盲转 relay**：服务器只按 token 路由、只搬字节，永远见不到明文。
- **一个 code 即一切**：路由 token 与 PAKE 盐由同一 256-bit code 派生；无
  code 的中间人既学不到东西也无法插入。
- **免费额度友好**：每个 pairing 一间 Durable Object，建立在 WebSocket
  **Hibernation API** 上——空闲房间 isolate 被逐出，连着但不说话的 pairing
  时长消耗 ≈ 0。7×24 挂 agent + 偶尔手机访问，落在 CF 免费额度内。
- **零依赖 core**：`packages/core` 只用 WebCrypto，Node ≥ 18 / 浏览器 /
  Capacitor WebView 行为一致。
- **实机打磨过**：手机射频掉线、大陆网络、代理、半死隧道——client 内置空闲
  看门狗与打发在途请求的 teardown 语义，不会把请求挂死。

## 布局

| 路径 | 内容 |
|---|---|
| `PROTOCOL.md` | 协议规范（帧表 / 握手 / 错误码 / 尺寸限制 / 服务器行为） |
| `workers/relay` | **relay server 本体**——CF Workers（每 pairing 一间冬眠 DO） |
| `packages/core` | 双端共享：E2E 握手 + AES-GCM 帧，零依赖（WebCrypto） |
| `packages/agent` | 参考桌面端：向 relay 建常驻出站 WS，把 HTTP/WS 帧代理到本地端口 |
| `packages/client` | 参考手机/浏览器端：E2E 客户端 + 隧道上的 `fetch()` / `WebSocket()` |
| `test/fixtures/relay-server.mjs` | 协议等价的 Node 参考实现（测试夹具，也可自托管当 relay） |
| `test/` | 本地端到端套件 + 打真实部署 relay 的 live 测试 + 打真 Worker 的 e2e |

其他项目文档：[SECURITY.md](SECURITY.md)（漏洞报送与威胁模型）、[CONTRIBUTING.md](CONTRIBUTING.md)、[CHANGELOG.md](CHANGELOG.md)。

## 快速开始

```bash
npm install
npm test          # 端到端冒烟（全本地，无需部署）
```

需要 Node ≥ 23（测试直接 import TypeScript 源码）。想连**真 Worker** 一起测
（miniflare：DO + 冬眠 + storage）：`npm run test:dev`；`npm run typecheck`
对全部代码跑 `tsc --noEmit`。

### 部署 relay（本项目的意义所在——约 2 分钟）

```bash
npx wrangler login     # 一次性；提供你自己的 Cloudflare 账号
cd workers/relay
npx wrangler deploy    # 默认 workers.dev 子域
```

无构建步骤、无需填配置、无需建数据库——这一个 Worker 就是完整的服务器，
7×24 挂 agent + 偶尔手机访问落在免费额度内。给 Worker 绑自定义域名的方法
见 `wrangler.toml` 里的注释示例。

**更懒的路子**：把本仓库丢给你的 coding agent（Claude Code、Cursor……），
说一句"帮我部署 relay"——[`AGENTS.md`](AGENTS.md) 里教了它完整路径和验证
方法。你只需要出一个 Cloudflare 账号 + 点一次浏览器授权。

### 挂上一个本地服务

```bash
node packages/agent/src/cli.ts \
  --server https://<your-relay>.workers.dev \
  --port 3425            # 省略 --code 则生成新配对码并打印
```

CLI 会打印配对码与手机侧连接 URL。另一端用 `packages/client` 连
`wss://<relay>/c/<routingToken>/__alma_e2e__`，以同一 code 完成 E2E 握手后，
其 `fetch()` / `WebSocket()` 的每个请求都落在 `127.0.0.1:<port>` 上——本地
网关 API、dev server、任意服务皆可。

## 测试

| 文件 | 覆盖 |
|---|---|
| `test/smoke.mjs` | 本地夹具全链路：HTTP GET/POST、WS 隧道、错码拒绝、双 agent 抢占、fetch 取消（hcancel）、不可达 relay 诊断 |
| `test/phone-before-agent.mjs` | client 先于 agent 到达——早帧缓冲与回放 |
| `test/close-pending.mjs` | 未配对 client 的拆除路径 |
| `test/watchdog.mjs` | 空闲看门狗收割半死隧道而非挂死请求 |
| `test/workers.mjs` | **真 Worker** 跑在 `wrangler dev`（miniflare）下：把下面两个 live 测试打到真实 Durable Object 代码上——进 CI |
| `test/live.mjs` | 同样的 e2e 打真实部署 relay（`--server`，可选 `--proxy`） |
| `test/live-pending.mjs` | 打真实部署 relay 的 phone-before-agent（跨 isolate 逐出的早帧缓冲） |

## 网络现实（大陆环境）

`*.workers.dev` 直连不通（DNS 污染 / SNI 阻断），agent 内置 `--proxy`（或
`HTTPS_PROXY` 环境变量）。手机端要长期可靠，建议把托管在同一 CF 账号的
**自定义域名**绑给 Worker：CF 边缘上的普通自定义域名大陆通常直连可达，手机
免代理。示例见 `workers/relay/wrangler.toml`。

## 诊断

两端都会告诉你为什么连不上 / 为什么断了，不再静默失败。默认开启——agent CLI
无需任何额外参数：

```
[RelayAgent] connect attempt 1 → relay.example.workers.dev (proxy: none)
[RelayAgent] connected to relay server (attempt 1, 812 ms)
[RelayAgent] disconnected after 14.2 min (attempt 1): read ECONNRESET — connection reset mid-path — proxy/firewall cut it; a retry usually recovers — retrying in 1000 ms
[RelayAgent] disconnected after 3.1 min: another agent took this pairing — call reconnect() to reclaim it
```

每次连接尝试都打印目标 host 与实际是否走代理（`proxy: none` 即直连——设置了
`HTTPS_PROXY` 时，靠这行确认它真的被捡起来了）。断线时按关闭码
（PROTOCOL.md §9）或藏在无声 1006 背后的 Node errno（`ECONNREFUSED`、
`ENOTFOUND`、TLS 错误……）给出一句话归因，附带连接存活时长、重试次数与下次
退避。

要结构化消费就传 `onDiag`——只要回调不要 console 输出的话加 `quiet: true`：

```ts
import { RelayAgent, type RelayDiagEvent } from "@hsinsekai-nanami/agent";

const agent = new RelayAgent({
  /* …其余选项同前… */
  onDiag: (e: RelayDiagEvent) => telemetry.log("relay", e),
  quiet: true,
});
```

`RelayTunnelClient`（`@hsinsekai-nanami/client`）带对等的最小实现：`onDiag` +
`[RelayClient]` 前缀日志（同样可用 `quiet` 关闭），覆盖隧道建立失败与异常关闭
——`1011` agent 掉线、`4404` 迟迟无 agent 注册、`1006` 射频掉线、配对码错误
——各配一句 hint。

## 安全与威胁模型

**relay 永远做不到的事**：读取或伪造隧道流量。内容密钥不离开两端；relay 看到
的只有密文 + 路由 token + 时序/尺寸元数据。重放会被接收端的 counter 校验拒绝
（PROTOCOL.md §2.3）。

**relay（或运营它的人）仍然能做的事——设计上接受**：

- **拒绝服务**——随意丢包、延迟、断连。你不控制的 relay 从不保证可用性。
- **流量分析**——消息尺寸与时序可见，无填充、无流量整形。
- **房间枚举很难，但那不是重点**——房间按 `sha256(routingToken)` 定键；没有
  code 找不到房间。即使 routingToken 泄露（等于看到手机侧连接 URL），能做的
 也只有 DoS（如注册假 agent 抢占配对位——抢占语义是新者胜），永远解不了密。
  不过连接 URL 还是当半秘密对待为好。
- **不内置限流与滥用防护**——公开运营的 relay 会被刷房间；为他人运营时请前置
  Cloudflare WAF 规则。

**配对码的性质**：256-bit code 即全部权限（路由 + PAKE）。code 泄露意味着此后
可被 MITM——有疑虑就换新配对码。每个会话用一次性 ECDH 密钥，code 泄露后**过去**
的会话仍然安全。

**诚实声明**：握手方案是从 Alma 客户端沉淀的自制 PAKE 风格协议——设计合理、
transcript 绑定、该常量时间的地方常量时间，但**未经形式化验证、未经审计**。
需要认证级密码学的场景请选经过审计的方案。

漏洞报送见 [SECURITY.md](SECURITY.md)。

## 移植坑记录（测试抓出来的）

1. **`ws.binaryType = "arraybuffer"`**：undici/浏览器 WebSocket 二进制默认给
   Blob，密文帧到达却进不了任何类型分支被静默丢弃——原版客户端有这行，漏了
   就挂。
2. **隧道 WS 的 open 语义**：`readyState=1` 不等于可用，必须等 `wopened` 帧，
   否则应用层首帧早于本地连接建立、被 agent 丢弃。
3. Node ≥ 23 原生跑 TS 不支持 parameter property（`constructor(private x)`），
   全部展开。
4. **Workers 转发 WS 进 DO 必须原样转发 request**：`stub.fetch(new Request(...))`
   构造的新请求不带 `Upgrade` 头，DO 收到的是普通 HTTP → upgrade 断（close
   1006）。要用 `stub.fetch(request)` 让 runtime 保留 upgrade 语义。

## 状态

- [x] 协议沉淀（PROTOCOL.md，与 Alma 原实现逐行对照）
- [x] core / agent / client / Workers server / Node fixture
- [x] 本地端到端测试全绿（HTTP GET/POST、WS 隧道、错码拒绝、双 agent 抢占、fetch 取消）
- [x] 防重放：双端接收侧帧 counter 校验
- [x] 真 Worker 进 CI（`test/workers.mjs` 走 `wrangler dev`）——不再只测 Node fixture
- [x] 部署 CF Workers；真机全链路验证（隧道 → 本地网关 API → 隧道上的完整 Web dashboard）
- [x] WebSocket Hibernation API 迁移——空闲 pairing 时长 ≈ 0，已在生产验证
- [x] MIT 协议
- [x] 已发布 npm：`@hsinsekai-nanami/{core,agent,client}`——编译 ESM + 类型，Node ≥ 18
- [ ] 请求体分块（目前上传为单帧；见 PROTOCOL.md §6 尺寸限制）
- [ ] 配套手机 App（Capacitor 壳 + 隧道上的门户 UI）每天在用这套栈，将另行开源

### 包的消费方式

已发布 npm：[`@hsinsekai-nanami/core`](https://www.npmjs.com/package/@hsinsekai-nanami/core)、
[`@hsinsekai-nanami/agent`](https://www.npmjs.com/package/@hsinsekai-nanami/agent)、
[`@hsinsekai-nanami/client`](https://www.npmjs.com/package/@hsinsekai-nanami/client)
发布物为编译后的
ESM（`dist/`，Node ≥ 18）+ d.ts + TS 源码。仓库内部仍按 TS 源码直接消费
（bundler，或 Node ≥ 23 跑测试套件）。

```bash
npm install @hsinsekai-nanami/client            # 手机/浏览器侧
npx -p @hsinsekai-nanami/agent relay-agent --server https://<relay> --port 3425
```

## 许可

[MIT](LICENSE)
