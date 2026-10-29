# Brief for parallel implementation agents

Read this first. Several agents work in this repo at the same time; these rules keep you from breaking each other.

## Repo layout (npm workspaces)

```
packages/core            chain-agnostic risk framework (router, gates, allocator, xchain). TS run via tsx.
packages/live-common     SDK-free contracts: AssetRef, LiveContext, LendingAdapter, SwapAdapter, BridgeAdapter, RewardClaimer, keys, money utils
packages/live-evm-base   viem env + sendTx (simulate -> gas cap -> dry-run stop -> send -> receipt), ERC20 helpers
packages/live-evm        EVM lending adapters, EVM swaps, Merkl / Aave reward claims
packages/live-sui        Sui adapters (Navi, Suilend, Scallop, ...) + Cetus swaps; shared src/common.ts (SuiEnv, executePtb, PtbSwapper)
packages/live-bridges    CCTP / USDT0 / other bridge adapters + core BridgeExecutor glue
```

Core types to know: `LoopPair`, `LoopLeg` (packages/core/src/sources/loopPair.ts), `RouteSpec`, `BridgeExecutor` (packages/core/src/xchain/types.ts), `Executor` (packages/core/src/executor.ts). Live contracts: packages/live-common/src/index.ts.

## Hard rules

1. **Only touch the files/directories your task assigns to you.** Do not edit any `package.json`, `package-lock.json`, any `index.ts` of a package, `tsconfig*.json`, or files owned by another agent. Export your public API from your own module's `index.ts` (e.g. `packages/live-sui/src/navi/index.ts`); the orchestrator wires package indexes.
2. **Never run `npm install` / `npm i` / `npx <pkg>` that installs.** All dependencies are pre-installed (see each package.json). If you truly need another dependency, stop and say so in your report.
3. **Never commit, push, or change git state.** The orchestrator commits.
4. **No secrets anywhere.** Keys come from env via `loadSecret` (live-common). Never log keys; use `redact`.
5. **Dry-run first.** Every write path builds the transaction, simulates it (EVM: `sendTx`; Sui: `executePtb`), and stops if `ctx.dryRun`. Never bypass these helpers.
6. **Addresses are never typed from memory.** Take them from an SDK constant / official address book package installed in node_modules, or from config with a `verify` check that reads them back on-chain. If you must put a constant in code, add a `// SOURCE: <url or package path>` comment and include it in your module's `verifyConfig()` so it is checked on-chain before live use.
7. **Read the installed SDK's `.d.ts` files** (node_modules/...) to get exact function names and signatures. Do not guess APIs. If an SDK lacks something, build the Move call / contract call yourself from the protocol's ABI and say so.
8. **Units:** token amounts are `bigint` base units; USD is `number`; APRs are yearly fractions (0.05 = 5%). Convert APY to APR (daily compounding) if a source reports APY.
9. **Tests:** put `node:test` tests in your package's `test/` dir, named after your module (e.g. `test/navi.test.ts`). They must run offline — mock RPC / SDK clients. Run them with:
   `cd /home/claude/professor-liao-class-with-ppt && node --import tsx --test packages/<pkg>/test/<file>.test.ts`
10. **Typecheck before you finish:** `cd /home/claude/professor-liao-class-with-ppt && npm run typecheck -w @incentive-router/<pkg>` must pass. (Other agents' unfinished files may make it fail; if the errors are only in files you do not own, say so.)
11. This sandbox cannot reach chain RPCs or most APIs (only npm + GitHub). Code must be correct by construction against the SDK types; anything you could not verify live goes into a `VERIFY_LIVE.md` checklist section of your report.

## Report format (your final message)

- Files created/changed (paths).
- Public API (exported names + one-line purpose).
- What is verified (typecheck, tests) vs what must be verified live (exact checks).
- Open risks / TODOs, ranked.
Keep it under ~600 words.
