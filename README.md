# incentive-router

這個 repo 把循環貸（loop-farm）的風控框架通用化，用同一套規則管理所有「吃項目方行銷預算」的部位：循環貸、LP 激勵、跨所 perp 積分、存款補貼。
它還加上跨鏈資金配置，並接上 Sui 與 EVM 的實盤 adapter。

對應課堂簡報 *Arbitrage_2026* 第 56–59 頁「Marketing purpose」：激勵是項目方付給套利者的服務費。
這個 repo 回答的是「怎麼拿這筆錢，又不變成最後買單的豬」。

| 文件 | 內容 |
|---|---|
| [docs/lending-landscape.md](docs/lending-landscape.md) | **哪些借貸市場現在能這樣跑**（2026-10-29 盤點）、跨鏈路由與成本、$300k 起始配置 |
| [docs/runbook.md](docs/runbook.md) | **上實盤的步驟**：verify → shadow → canary → 放大、Telegram 指令、緊急處理、systemd |
| [docs/design.md](docs/design.md) | 風控框架設計：公式、規則優先序、參數對照、限制 |

> 範例與情境裡的數字只是示意，不是即時市場資料，也不是投資建議。
> 實盤 adapter 只在 mock 上測過，還沒對真鏈跑過。每個模組的 VERIFY_LIVE 項目必須在 staging 機器上用 `verify` 和 shadow 模式逐一確認。

## 它做什麼

- **統一的機會模型**：每個 source 把自家協議翻譯成 `Opportunity`，內容包括收益流、出場容量、壓力訊號、健康度，以及資金放在哪幾個 venue。
- **估值**：可實現淨 APR ＝ 每條收益流 × 獎勵幣可實現比例 × 時間權重 − 成本。自己進場造成的稀釋與利率變化都算進去。
- **穩定幣對循環**：支援「存 A 借 B」，兩邊各用自己的利率模型，並納入換匯成本與深度、脫鉤訊號（用市價，不用協議預言機）。
  獎勵規則看得懂淨額型補貼（`netOf`）、每人上限、HF 上限（Ethena Liquid Leverage 的 HF ≤ 2），以及「借了某幣就失格」的規則。
- **單純放貸（只存不借）**：Aave V3／V4、NAVI、Suilend、Scallop、ERC-4626 vault（Euler、MetaMorpho、Fluid）。
  - 和循環貸用同一把尺比較：net = raw − 獎勵折價 − 脫鉤預期損失 − 成本 − 搬運。
  - 穩定幣分三級，各有預期脫鉤損失與警告／出場水位；第 3 級（USDe 等）不單純存。
  - 選倉邏輯、門檻與 2026-10-29 情境：[docs/selection.md](docs/selection.md)。
- **進場閘門**：
  - 通用版 1/10 規則。
  - 分 tier 的門檻（無風險利率＋溢價）。
  - venue／chain／token／kind／單一機會／獎勵幣／積分預算的上限。
- **出場優先序**：
  - 通用版 1/5 規則與壓力訊號。
  - 流動性被抽乾、出口模擬失敗。
  - 獎勵即將結束、利差壓縮（去抖動、分段減倉）。
  - 被自己稀釋。
- **跨鏈資金配置**：閒置資金按 `chain:asset` 分桶。
  - 只有通過全部規則才搬錢：單次搬運成本 ≤ 目的地一天收益、過去 24 小時總磨損 ≤ 整本一天收益、14 天回本、最小金額、在途上限。
  - 在途資金計入淨值，卡住會告警，不會自動重送。
- **組合保護**：
  - 回撤熔斷、資料驗證與過期判定、資料源失聯出場。
  - 全退鎖存重試、告警去重、Telegram 指令。
- **實盤**：
  - 每一筆交易都先在鏈上模擬才送出，並受 gas 上限約束。
  - 影子模式（shadow）只模擬、不廣播。
  - 要 live 必須通過 live gate：近 7 天內 verify 過、config hash 相符、零問題，還要設 `LIVE_CONFIRM=yes`。
  - canary 硬上限、單一實例鎖。

## 結構（npm workspaces）

```
packages/core            風控框架：估值、閘門、配置器、Router、跨鏈 planner（xchain/）、情境模擬、CLI
packages/live-common     SDK-free 介面：LendingAdapter / SwapAdapter / BridgeAdapter、金鑰、單位換算、鏈表
packages/live-evm-base   viem：sendTx（模擬 → gas 上限 → dry-run 停止 → 送出 → 收據）、ERC20 工具
packages/live-evm        Aave v3 家族、Morpho Blue（含 Lista）、KyberSwap/Odos 聚合器、Merkl 領取與獎勵率
packages/live-aave-v4    Aave V4（hub & spoke），spoke 呼叫自行編碼並做 guard 檢查
packages/live-sui        Navi、Suilend、Scallop、Cetus 聚合器；executePtb（模擬 → gas 上限 → 送出）
packages/live-bridges    CCTP V2（EVM + Sui）、USDT0（LayerZero OFT）、core BridgeExecutor glue、鏈上驗證
packages/live-runner     把以上接進 Router：shadow／live 模式、verify stamp 與 live gate、錢包分桶、獎勵 keeper、CLI
config/default.yaml      Router 預設參數（含註解）
config/live-router.yaml  實盤用 Router 參數與跨鏈路由
config/live.example.yaml 實盤設定範本（地址、鏈、上限；不含秘密）
deploy/                  systemd unit、環境變數範本
examples/                範例機會、代幣資料、離線樣本、情境（含 cross-chain.yaml）
```

## 快速開始

```bash
npm ci
npm test                 # 全部離線測試
npm run typecheck

# 情境重播：Plasma 式獎勵崩盤、擠兌、跨鏈搬運（一天收益規則）
npx tsx packages/core/src/cli.ts sim examples/scenarios/plasma-reward-collapse.yaml
npx tsx packages/core/src/cli.ts sim examples/scenarios/bank-run.yaml
npx tsx packages/core/src/cli.ts sim examples/scenarios/cross-chain.yaml

# 選倉：循環 vs 單純放貸，live 設定 + 10-29 研究數字（--why 印出每個候選的 net 拆解與原因）
npx tsx packages/core/src/cli.ts sim examples/scenarios/selection-2026-10-29.yaml --why
npx tsx packages/core/src/cli.ts sim examples/scenarios/selection-2026-10-29-whatif-renewal.yaml --why

# 用範例機會掃描（--why 顯示沒過的原因）
npx tsx packages/core/src/cli.ts scan --static examples/static.yaml --tokens examples/tokens.yaml --probe 20000 --why
```

## 實盤（詳見 runbook）

```bash
cp config/live.example.yaml config/live.yaml     # 改市場、上限
set -a; . /etc/incentive-router/env; set +a       # RPC、金鑰檔路徑、Telegram

npm run live -- verify      # 到鏈上讀回所有地址、資產、市場、橋、swap router；寫 stamp
npm run live -- markets --why
npm run live -- balances
npm run live -- plan --why  # 模擬一輪：會進哪些、要不要跨鏈搬（印出選倉表）
npm run live -- run         # mode: shadow → 只模擬；mode: live + LIVE_CONFIRM=yes → 實盤
npm run live -- status
```

## 接上新協議

- 單純放貸：實作 `SupplyAdapter`（`supplyMarkets / supplyPosition / deposit / withdraw / simulateWithdraw / claimRewards / walletBalance`）。一個 adapter 可以同時實作兩個介面，runner 會建立 `<id>#supply` 這個 source。

1. 實作 `LendingAdapter`（`packages/live-common`）：`markets()` 回傳 `LoopPair[]`，另外實作 `position / open / close / deleverage / simulateClose / claimRewards / walletBalance`。每一筆寫入都走 `sendTx` 或 `executePtb`，並提供 `verifyConfig()`。
2. 在 `packages/live-runner/src/build.ts` 的 `makeLendingAdapter` 加一個 `type`。
3. 在 `config/live-router.yaml` 的 `venues` 給它 tier。

非循環類（LP、perp）沿用 core 的 `Source` + `Executor` 介面，見 `docs/design.md`。
