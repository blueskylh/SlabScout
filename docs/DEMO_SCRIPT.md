# SlabScout 3-Minute Demo Script

## 中文脚本

**0:00–0:25 问题**

收藏卡交易里，AI agent 不能只看卖家一句话就花钱。它需要付费情报、确定性授权和可审计资金执行。SlabScout 解决的是：让一个 USDC agent 在 Arc Testnet 上只用小额资金完成“先验证、再锁订金”的流程。

**0:25–0:50 用户授权**

展示 Authorization 面板：目标卡是 Reshiram & Charizard-GX，PSA cert `80396943`，itemId 和 Renaiss href 都是只读结构化身份。用户只授权三件事：MarketProof 最多 `0.001 USDC`，escrow deposit 最多 `0.10 USDC`，并设置日预算和价格/置信度门槛。

**0:50–1:20 Renaiss 信号**

点击 Seller A。Agent 先从 Renaiss cert lookup 开始，确认 cert、itemId、href、company、grade 都匹配，然后读取 card detail、FMV、trades。listing 被排除；MarketProof sample 只使用 transaction row，或者明确标记 aggregate-only。

**1:20–1:50 Agent 自主支付 MarketProof**

初判是 INVESTIGATE，因为授权要求 MarketProof。Agent 读取 payment requirements，检查金额、Arc Testnet、USDC address 和 idempotencyKey。Replay 中显示 simulated，不会伪装成 paid；live 只有真实 Circle receipt 才能进入下一步。付款后 Agent 重新拉取 Renaiss 数据并生成 MarketProof，随后 verifier 自检 hash、signature、offer、cert、payment 和 TTL。

**1:50–2:20 Arc escrow**

证明通过后，policy 复判为 RESERVE。Replay 显示 `replay-escrow-simulated`，不会显示 tx hash 或 chainConfirmed。Live 版本只有在 Agent Wallet approve + reserve 成功、receipt 存在、Reserved event 匹配时才显示 chain-confirmed。

**2:20–2:45 拒绝分支**

切换 Seller B：报价超出授权，REJECT，零支付。切换 Seller C：低质量/身份风险，REJECT，零支付。展示审计记录，证明 agent 会花钱，也会拒绝。

**2:45–3:00 项目价值与下一步**

SlabScout 展示了 agentic economy 的关键模式：agent 可以在用户授权内购买情报、验证证明、再把小额 USDC 锁进 Arc escrow。下一步是配置真实 Circle CLI 登录态、Circle Agent Wallet、x402 MarketProof service、seller address、Arc Testnet 合约地址与可写 state file，然后运行手动 live E2E 捕获真实 payment/tx 证据。

## English Script

**0:00–0:25 Problem**

Trading graded collectibles is a bad environment for blind agents. A wallet agent should not pay just because a seller says a card is cheap. It needs paid intelligence, bounded authorization, deterministic policy, and auditable execution.

**0:25–0:50 User authorization**

Show the Authorization panel. The target is Reshiram & Charizard-GX, PSA cert `80396943`, with read-only itemId and Renaiss href. The user authorizes only two small Arc Testnet spends: up to `0.001 USDC` for MarketProof and up to `0.10 USDC` for a refundable escrow deposit.

**0:50–1:20 Renaiss signal**

Run Seller A. The agent starts with Renaiss `/v1/graded/{cert}`, then loads card detail, FMV, and grade-scoped trades. Listings are excluded from transaction samples, and aggregate-only samples are labelled explicitly.

**1:20–1:50 Autonomous MarketProof payment**

The first policy decision is INVESTIGATE because the authorization requires MarketProof. The agent checks payment amount, chain, USDC address, payee, and idempotency before paying. Replay is simulated and never shown as paid; live requires a real Circle confirmation.

**1:50–2:20 Arc escrow**

After payment, the backend refetches Renaiss data, builds a MarketProof, and immediately verifies canonical hash, HMAC, offer/cert/payment bindings, and TTL. If policy passes, the agent moves to escrow. Replay is labelled simulated; live requires a real Arc tx and Reserved event.

**2:20–2:45 Rejection branches**

Seller B is overpriced and rejected with zero payment. Seller C is low quality and rejected with zero payment. This proves the agent is autonomous but bounded.

**2:45–3:00 Value and next step**

SlabScout shows how paid intelligence and programmable money combine: an agent can buy data, verify it, and lock USDC under strict user limits. The remaining live step is configuring Circle CLI login, Agent Wallet funding, the x402 MarketProof seller address/service URL, writable backend state, and the deployed Arc Testnet escrow contract, then running the manual live E2E to capture real evidence.
