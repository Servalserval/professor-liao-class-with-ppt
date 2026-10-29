# incentive-router

把循環貸（loop-farm）的風控框架通用化，用同一套規則管理所有「吃項目方行銷預算」的部位：
循環貸、LP 激勵、跨所 perp 積分、存款補貼。

對應課堂簡報 *Arbitrage_2026* 第 56–59 頁「Marketing purpose」：激勵是項目方付給套利者的服務費。
這個 repo 回答的是「怎麼拿這筆錢，又不變成最後買單的豬」。

完整設計說明（公式、規則優先序、參數對照、限制）在 **[docs/design.md](docs/design.md)**。

> 範例與情境裡的數字都是示意，不是即時市場資料，也不是投資建議。
> 這個 repo 沒有任何鏈上 executor，`run` 只支援 `--paper`。

## 它做什麼

- **統一的機會模型**：每個 source 把自家協議翻譯成 `Opportunity`（收益流、出場容量、壓力訊號、健康度、資金放在哪幾個 venue）。
- **估值**：可實現淨 APR ＝ 每條收益流 × 獎勵幣可實現比例 × 時間權重 − 成本；自己進場造成的稀釋與利率變化都算進去。
- **進場閘門**：通用版 1/10 規則、分 tier 的門檻（無風險利率＋溢價）、venue / chain / token / kind / 單一機會 / 獎勵幣 / 積分預算上限。
- **出場優先序**：通用版 1/5 規則、壓力訊號、流動性被抽乾、出口模擬失敗、獎勵即將結束、利差壓縮（去抖動、分段減倉）、被自己稀釋。
- **配置器**：按邊際淨 APR 做水位填充。
- **獎勵處理**：領了就賣／對沖／持有，崩盤自動賣，單一獎勵幣曝險上限。
- **組合保護**：回撤熔斷、資料源失聯出場、告警去重、Telegram 指令。

## 快速開始

```bash
npm install
npm test                 # 60 個測試，包含兩個情境的整合測試
npm run typecheck

# 用範例機會掃描（--why 顯示沒過的原因）
npx tsx src/cli.ts scan --static examples/static.yaml --tokens examples/tokens.yaml \
  --config config/default.yaml --probe 20000 --why

# 用 Merkl / DefiLlama 的離線樣本掃描（有網路時改用 --live）
npx tsx src/cli.ts scan --merkl-fixture examples/fixtures/merkl-opportunities.json \
  --llama-fixture examples/fixtures/defillama-pools.json --config config/default.yaml --why

# 情境重播：Plasma 式獎勵崩盤、擠兌／出口失效／資料源失聯
npx tsx src/cli.ts sim examples/scenarios/plasma-reward-collapse.yaml
npx tsx src/cli.ts sim examples/scenarios/bank-run.yaml

# Paper 模式持續跑（設定 TG_BOT_TOKEN / TG_CHAT_ID 就會推 Telegram）
npx tsx src/cli.ts run --paper --static examples/static.yaml --tokens examples/tokens.yaml \
  --config config/default.yaml --cycles 3 --interval 5

# 在有網路的機器上確認 Merkl / DefiLlama 的欄位
npx tsx src/cli.ts verify-sources
```

想看「抱著獎勵幣」會怎樣：在 `plasma-reward-collapse.yaml` 的 `config` 加上
`rewards: {tokens: {XPL: {policy: hold, max_hold_usd: 1000000}}}` 再跑一次。

## 結構

```
src/
  types.ts            Opportunity / YieldStream / Leg / Position / Action
  config.ts           設定型別、預設值、驗證
  valuation.ts        淨 APR、獎勵幣折價模型、稀釋、邊際 APR
  tiers.ts            venue 評分與門檻
  exposure.ts         以 leg 為單位的曝險與上限
  signals.ts          歷史訊號：流動性被抽乾、指標暴衝、排放被砍、代幣回撤、組合回撤
  gates/entry.ts      進場閘門
  gates/exit.ts       出場優先序
  allocator.ts        邊際 APR 水位填充
  rewards.ts          領取／賣出／對沖
  monitor.ts          Router：每輪的觀察 → 出場 → 出口模擬 → 獎勵 → 配置
  store.ts notify.ts executor.ts scenario.ts cli.ts
  sources/
    loopLending.ts    同資產循環貸（含 IRM、loop-farm MarketState 轉接）
    lpIncentive.ts    LP 激勵（稀釋、LVR、對沖）
    perpHedge.ts      跨所 delta-neutral perp（拒絕同所對沖）
    merkl.ts          Merkl 掃描（探索用）
    defillama.ts      DefiLlama yields 掃描（探索用）
    static.ts         手寫 YAML 機會（也驅動情境模擬）
config/default.yaml   預設參數（附 loop-farm 對照註解）
examples/             範例機會、代幣資料、離線樣本、情境
test/                 node:test 測試
docs/design.md        設計說明
```

## 接上真實協議

1. 寫一個 `Source`：回傳 `Opportunity[]`。循環貸可以直接用 `LoopLendingSource` 包 loop-farm 的 market provider（見 `fromLoopFarmMarket`）。
2. 寫一個 `Executor`：`enter / exit / rebalance / simulateExit / claim / sell / hedge`，全部以 USD 為介面。
3. 在 `Router` 的 `executors` 用 `sourceId` 對應起來。沒有 executor 的 source 只會出現在掃描報告。
