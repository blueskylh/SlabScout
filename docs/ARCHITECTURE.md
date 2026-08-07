# SlabScout Architecture

SlabScout 是 Arc Agentic Economy Track 的自主 USDC 代理。它只处理两类小额 Testnet 资金：`0.001 USDC` MarketProof fee 和 `0.10 USDC` refundable escrow deposit；不会购买实体卡，也不会支付完整卡价。

## 端到端流程

```text
Authorization
  -> Trusted offer allowlist
  -> Renaiss cert-first lookup
  -> Renaiss card detail / FMV / trades
  -> Deterministic policy
  -> Circle/x402 MarketProof payment when required
  -> MarketProof generation + self verification
  -> Arc Testnet ReservationEscrow reserve
  -> Persistent run/payment/proof/reservation/audit state
```

## 1. Authorization

用户授权包含预算和结构化目标身份：

- `targetItemId`
- `targetHref`
- `certNumber`
- `company`
- `gradeLabel`
- `targetCard` / `displayLabel`
- `maxIntelFeeUsdc <= 0.001`
- `maxDepositUsdc <= 0.10`
- `dailyBudgetUsdc`
- `requireMarketProof`

服务端忽略客户端提交的 `spentTodayUsdc`；真实执行时预算由服务端持久状态计算。

## 2. Trusted offer store

公共 `/api/scout/run` 只接受 `offerId`。`body.offer` 被拒绝，避免客户端把 `sellerAddress` 换成攻击者地址。

当前 MVP 使用服务端 allowlist：

- `offer-reshizard-95`：合规折扣报价，演示主路径。
- `offer-reshizard-120`：超价拒绝路径。
- `offer-low-confidence`：低质量拒绝路径。

动态 Seller Agent offer 还未启用；如果后续加入，需要 EIP-712 签名、nonce、expiry、sellerAddress 和完整 payload 验证。

## 3. Renaiss integration

Live mode 必须 cert-first：

1. `GET /v1/graded/{cert}`
2. 使用返回的 `itemId` 与 `card.href` 作为身份真相。
3. 再请求 card detail、FMV series、grade scoped trades。

`400 / 401 / 404` cert 错误是硬拒绝，不 fallback。网络超时或 5xx 可以显示 `REPLAY_FALLBACK`，但该状态会禁止 payment、proof 和 escrow。

MarketProof sample 只允许 `kind=transaction`；listing 被排除并单独计数。如果没有 transaction row，proof 标记为 `aggregate-only`，不会称为 completed sales。

## 4. Policy engine

Policy 是纯确定性规则：

- 结构化身份必须匹配 authorization / offer / cert / card detail。
- Renaiss confidence、source count、observation count、freshness 必须达到授权门槛。
- ask 必须小于用户 max price 与 median 折扣阈值的较小值。
- mean / VWAP 与 median 偏差受限。
- proof fee、deposit、daily budget 必须在服务端预算内。
- `REPLAY_FALLBACK` 是硬拒绝。

Policy 输出 `RESERVE`、`INVESTIGATE` 或 `REJECT`。UI 单独展示 Policy Decision 与 Execution Status。

## 5. Circle/x402 payment boundary

Replay payment 使用：

- `status = replay-payment-simulated`
- `confirmed = false`
- `simulated = true`
- `replayAccepted = true`
- 无 tx hash / explorer URL

Live payment 已接入 Circle CLI buyer flow 与 x402 seller endpoint，但默认仍 fail-closed：没有 operator token、可写 state file、Circle CLI 登录、Agent Wallet、seller address、service URL 或可信 receipt/tx 时，只返回 `live-unavailable/*` 或 `reconciliation_required`，不会显示成功。

可信 payment receipt verifier 绑定：runId、idempotencyKey、offerId、targetItemId、targetHref、payer、payee/service/payeeAddress、Arc Testnet、chainId、USDC address、amount、Circle payment ID 或 tx hash、paidAt、providerStatus，并拒绝 replay / 过期 / 金额或资产不一致。x402 seller middleware 仅接受 `eip155:5042002`，且 proof endpoint 会重新拉取 Renaiss 数据，不签客户端提交的数据。

## 6. MarketProof / PolicyProof

`MarketProof` 是付费证明，必须在付款后重新拉取 Renaiss 数据再生成。生成后立即自检：

- canonical payload hash
- HMAC signature
- offer/authorization/card/cert binding
- payment receipt binding
- generatedAt / offer expiry / source TTL
- proof mode 与当前运行 mode 一致

`verified` 仅作为展示字段；安全边界重新调用 verifier，不信任调用方传入的 `verified` 或 `verification.ok`。

`PolicyProof` 只在 `requireMarketProof=false` 时使用，独立于 MarketProof。它绑定 runId、offer、authorization、decision 和 deposit amount，不显示为 MarketProof verified。

## 7. Arc escrow

`ReservationEscrow` 只锁定 refundable deposit。合约检查：

- non-zero offerId/seller/proofHash
- seller != buyer
- amount > 0 且不超过 max
- refundAfter 必须在未来
- offerId 不可重复
- SafeERC20-style false-return 检查

Live escrow 通过 Arc RPC 校验 chainId、查询已有 reservation、检查 USDC allowance，必要时用 Circle CLI approve，然后调用 `reserve(bytes32,address,uint256,bytes32,uint64)`。前端只有在真实 tx hash、block number、matching `Reserved` event 和 chain receipt 都存在时才能显示 `chain-confirmed`。Replay escrow 使用 `replay-escrow-simulated`，`chainConfirmed=false`。

## 8. Persistent state and audit

后端 state store 用于 run/idempotency/paymentIntent/payment/proof/reservation/audit/budget hold。Live 执行缺少可写 `SLABSCOUT_STATE_FILE` 时 fail-closed，不会花钱；`DATABASE_URL` 在本 MVP 中不是已实现持久化。

同一 idempotencyKey 重试返回原结果；同一 receipt、同一 live MarketProof payment intent 或同一 offer reservation 不能被不同 run 重放。预算必须在执行前保留，失败后释放。

## 9. Live mode and operator boundary

公开 mode 只有 `replay` 和 `live`。`live-cache`、大小写变体、空字符串或其他伪模式都会在外部调用前拒绝。只要 effective mode 是 `live`，无论来自请求 body 还是 `SLABSCOUT_DEFAULT_MODE`，都必须先通过 `x-slabscout-operator-token` / Bearer token 鉴权，并且 live run 必须带显式 `idempotencyKey`。
