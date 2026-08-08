# SlabScout Threat Model

## 资产与安全目标

保护对象：

- Renaiss API credentials
- Circle Agent Wallet / payment credentials
- Arc Testnet USDC balance
- MarketProof signing secret
- PolicyProof signing secret
- Authorization budget
- Escrow contract state
- Audit trail

资金边界：MarketProof 最多 `0.001 USDC`，escrow deposit 最多 `0.10 USDC`，只允许 Arc Testnet。

## 威胁与控制

| Threat | Risk | Control |
|---|---:|---|
| Forged client offer | 攻击者替换 sellerAddress 后进入 RESERVE | 公共 API 拒绝 `body.offer`，只接受服务端 allowlist `offerId` |
| Target identity spoofing | 文本名称相似但不是同一张卡 | 使用 cert-first Renaiss lookup，校验 itemId/href/cert/company/grade/targetCard |
| Fake proof hash | 调用方提供随机 32-byte hash + `verified:true` | 安全边界重新计算 canonical hash 与 HMAC，不信任展示字段 |
| Tampered proof payload | 修改 ask/offer/cert/payment 后复用旧签名 | canonical payload hash mismatch 与签名 mismatch 均拒绝 |
| Live proof downgraded to replay | 把 `dataMode` 改成 replay 并用默认 secret 签 | verifier 绑定 expected mode；live 证明必须使用非默认 live secret |
| Payment string spoofing | `status=paid` 但 `confirmed=false` | payment verifier 不看 paid 字符串，要求 provider confirmation、receipt/tx 和字段绑定 |
| Payment replay | 一个 receipt 被多个 run/offer 使用 | state store 记录 receiptId/provider ID，跨 run/offer 重放拒绝 |
| Duplicate payment | 同一 idempotencyKey 重试导致多次支付 | idempotency store 返回原结果或拒绝 in-progress run |
| Budget race | 并发请求突破 daily budget | 执行前在服务端 state transaction/queue 中保留预算，失败释放 |
| Wrong chain / wrong asset | 主网或错误 token 发生支付 | runtime config 强制 chainId `5042002` 和 Arc Testnet USDC address |
| Fallback execution | Live Renaiss 5xx fallback 后仍支付 | `REPLAY_FALLBACK` 是 policy hard fail，payment/escrow 禁止 |
| Replay masquerades as live | demo receipt 被显示为 paid/reserved | Replay uses `simulated/replayAccepted`, `confirmed=false`, `chainConfirmed=false`, no tx/explorer |
| Secret leakage | API key/private key 进入源码、日志或前端 | `.gitignore`、env examples placeholders、secret scan、backend-only Renaiss client |
| Dangerous MarketProof API | 客户端传 signal 让服务端签假数据 | `/api/market-proof/prove` 拒绝 client signal，只按 offerId 服务端重抓数据 |
| Unauthorized live execution | 任意用户触发 Circle/Arc | Live `/api/scout/run` 需要 operator token，timing-safe comparison |
| Mode bypass | 用 `live-cache`、默认 live 或大小写变体绕过 operator gate | 统一 `resolveEffectiveMode`，公开 mode 只允许 `replay/live`；effective live 一律先鉴权 |
| Wrong x402 chain | 在非 Arc Testnet Gateway 网络付款后骗 proof | seller middleware restricts `eip155:5042002`，receipt verifier 绑定 Arc Testnet、chainId、USDC address、payer/payee |
| Concurrent payment intent | 并发 live run 对同一 offer 重复支付 MarketProof | state store 先 claim payment intent；同一 offer 的 active live intent/paid record 阻断第二笔 |
| Unknown Circle tx state | CLI 超时或返回不可解析时自动重试导致双花 | 返回 `reconciliation_required`，禁止自动重付，要求 operator 先外部对账 |
| Duplicate escrow reserve | 同一 offerHash 重复 reserve | reserve 前查询合约 reservation，已存在则进入 reconciliation，不发第二笔 tx |

## 当前剩余风险

- Live Circle Agent Wallet/x402 path 已接入 Circle CLI 与 x402 seller middleware，但仍需要真实 CLI 登录、Agent Wallet、Testnet USDC、service URL、seller address 和外部对账流程。
- Live Arc reserve path 已接入 approve/reserve/receipt/event verification，但仍需要已部署 escrow 合约、funded Agent Wallet 和真实 Arc RPC。
- File-based state store 可满足单实例 demo 持久化；生产应替换为有事务和唯一约束的托管数据库，避免多实例并发写。
- 当前 trusted offer store 是静态 allowlist；动态 seller flow 需要 EIP-712 签名验证。
