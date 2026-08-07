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

## 当前剩余风险

- Live Circle Agent Wallet/x402 adapter 仍为 fail-closed 占位，需要真实 Circle credentials、钱包与 x402 service 后完成。
- Live Arc reserve adapter 仍为 fail-closed 占位，需要部署合约、Agent Wallet approve/reserve、receipt/event decoder。
- File-based state store 可满足 demo 持久化；生产应替换为有事务和唯一约束的托管数据库。
- 当前 trusted offer store 是静态 allowlist；动态 seller flow 需要 EIP-712 签名验证。
