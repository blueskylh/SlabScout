# Dependency Risk Review

## Scope

This review records the dependency-audit decision for the Arc Agentic Economy MVP branch. It is intentionally a review note, not an `npm audit fix` output, because automatic fix can rewrite unrelated dependency trees and destabilize the demo.

## Backend audit exception

`npm --prefix backend audit --json` currently reports:

```text
2 high, 6 moderate
```

High-severity findings are reachable through the transitive chain:

```text
@surf-ai/sdk -> drizzle-orm
```

Assessment:

- SlabScout does not expose arbitrary SQL or user-controlled database query construction through `@surf-ai/sdk`.
- Live fund movement is gated by deterministic offer/authorization checks, operator token, idempotency, payment/proof verification, and Arc Testnet-only runtime validation.
- The affected dependency is transitive and has no direct application usage path in the SlabScout execution flow reviewed here.
- No compatible upstream fix is applied in this branch context; do not force a broad `npm audit fix` until the upstream dependency publishes a compatible patched release.

Moderate backend findings include dev/build-chain packages and `express -> qs`. They are tracked for follow-up but are not used to justify changing live spend boundaries.

Decision:

- Accept as a time-boxed MVP exception.
- Keep `npm audit` findings visible in review notes.
- Re-evaluate before production deployment or when `@surf-ai/sdk` ships a patched dependency tree.

## Frontend cleanup

The frontend previously listed `echarts` and `echarts-for-react`, but the application has no chart rendering code and no imports of either package. They were removed to eliminate unused moderate-severity frontend dependency surface.

After removal, `npm --prefix frontend audit --json` reports one remaining high advisory on the Vite dev/build toolchain. It is not a runtime browser dependency in the built MVP, but should be upgraded before production hardening once a compatible Vite patch is selected.

Decision:

- Removed `echarts` and `echarts-for-react` from `frontend/package.json` and lockfile.
- Do not reintroduce charting dependencies unless a concrete chart component is added.
- Track Vite upgrade separately; do not run broad `npm audit fix` in this branch.
