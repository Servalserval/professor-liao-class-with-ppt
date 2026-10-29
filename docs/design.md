# 激勵預算路由器：把循環貸風控框架通用化

> 對應簡報第 56–59 頁「Marketing purpose」：激勵＝項目方的行銷預算，套利者拿到的是「服務費」。
> 這份文件說明怎麼把原本只服務循環貸的那套風控（loop-farm core），改寫成能同時管理
> 循環貸、LP 激勵、跨所 perp 積分、單純存款補貼的一個通用框架，以及這個 repo 實作了哪些部分。
>
> 所有數字範例都是示意，不是即時市場資料，也不是投資建議。

---

## 1. 為什麼要通用化

原本的 loop-farm 規則（1/10 進場、1/5 全退、利用率退場、獎勵打五折、各種上限、遲滯、冷卻）
其實沒有一條是「借貸專屬」的。它們回答的都是同三個問題：

1. **這筆錢實際能賺多少？**（扣掉獎勵幣折價、成本、自己進場造成的稀釋）
2. **出不出得去？**（流動性夠不夠、出口路徑是不是活的）
3. **一次最多可以壓多少？**（單一協議／鏈／代幣／獎勵幣的集中度）

Aqua 的 LP 激勵、perp DEX 的積分、Plasma 那種存款補貼，問的也是同樣三個問題，只是「流動性」
「健康度」「稀釋」各自的定義不同。所以做法是：

- **把協議差異關在 adapter（source）裡**：每個 source 只負責把自家狀態翻譯成統一的 `Opportunity`。
- **所有規則只看 `Opportunity` + `Position`**：一套進場閘門、一套出場優先序、一個配置器、一套獎勵處理。

這樣新增一種激勵農場＝寫一個 source＋一個 executor，風控不用重寫。

## 2. 什麼可以通用、什麼要各自定義

| 概念 | 通用形式 | 循環貸 | LP 激勵 | 跨所 perp | 存款補貼 |
|---|---|---|---|---|---|
| 收益 | `YieldStream[]`，每條都是 `aprAt(我的總部位)` | L×supply − (L−1)×borrow ＋獎勵 | 手續費＋獎勵 | 兩邊費率差 × 名目/權益 | 基礎＋獎勵 |
| 稀釋 | 固定排放按池子比例分 | 獎勵依供給池稀釋、利率走 IRM | 依在範圍內 TVL 稀釋，我的錢算 c 倍 | 無（費率不受我影響） | 依池子稀釋 |
| 「可提現流動性」 | `exitCapacityUsd` | 可借出流動性 S−B | 波動側在衝擊預算內能賣掉的深度 | 兩所訂單簿深度取小 | 可提領量（掃描資料是估計值） |
| 出場佔用 | `footprintPerEquity` | 毛供給 L（保守）或 1（flashloan） | 0.5（要賣掉一半波動資產） | 名目/權益 = 槓桿/2 | 1 |
| 壓力訊號 | `StressSignal`（warn / exit 兩檔） | 利用率 90% / 95% | 價格偏離（脫鉤） | 兩所價差 bps | 視來源 |
| 健康度 | `HealthView` | LTV（先去槓桿、再全退） | — | 離強平距離 | — |
| 持續成本 | `costs.ongoingApr` | 0 | LVR ≈ σ²/8 × c ＋對沖成本 | 刷量手續費 | 0 |

## 3. 資料模型（`src/types.ts`）

- **Opportunity**：一個可以放錢的地方。重點欄位：
  - `legs`：錢實際放在哪些 venue / chain / token，`equityFrac` 加總約為 1。上限都按 leg 算，
    所以跨所對沖會同時佔用兩個 venue 的額度。
  - `streams`：收益流，種類有 `base / fee / borrow_cost / reward / funding / points`。
  - `liquidity`：`exitCapacityUsd` 與 `footprintPerEquity`，`estimated: true` 代表是猜的。
  - `signals` / `projectedSignals(E)`：目前與「我進場後」的壓力訊號。
  - `flags`：離散狀態（暫停、脫鉤、流動性被抽乾……），分 `warn` / `exit`。
  - `metrics`：要追蹤時間序列的原始數字（`borrow_apr`、`tvl_usd`……），給 spike 規則用。
  - `maxEquityUsd`：協議端的上限（supply / borrow cap 剩餘額度）。
  - `speculative`：收益主要來自積分，走另一套預算與規則。
  - `discoveryOnly`：只報告、不配置（沒有接 executor 的掃描結果）。
- **Position**：持倉，記住 legs、獎勵狀態（未領／已領／已對沖）、出口模擬結果、去抖動計數、資料源失聯次數。

## 4. 估值（`src/valuation.ts`）

### 4.1 淨 APR

```
netApr(E) = Σ_streams  raw_i(E) × realizable_i × timeWeight_i   −   costApr(E)
```

- **成本不打折**：負的收益流（借款利息、付出去的 funding）全額計入。
- **積分不計入** `netApr`，另外放在 `speculativeApr` 顯示。
- **timeWeight**：會結束的收益流，按「剩餘天數 / 持有期間」加權（預設持有期 21 天）。
  剩 7 天的活動只算 1/3，已結束的算 0，所以快結束的活動自然排不上去。
- **costApr**：進場時 `ongoing + (進出場比例費用 + 固定 gas / 部位) × 365 / 持有天數`；
  持有中的部位只算 `ongoing`（進場成本已沉沒，出場成本早晚都要付）。

### 4.2 稀釋（自己的錢會攤薄收益）

固定排放按比例分給池子：

```
emission = aprNow × pool
apr(E)   = emission / (pool_exMe + g × E) × g
```

`g` 是我每一塊權益在池子裡算幾塊（循環貸的供給獎勵 g = L，借款獎勵 g = L−1，集中流動性 g = c）。
`pool_exMe` 會先把我現有的部位扣掉，所以持倉中的部位不會被重複計算。

### 4.3 循環貸（`src/sources/loopLending.ts`）

槓桿 `L = 1 / (1 − ltv)`，`ltv = min(target_ltv, openLtv × max_ltv_frac_of_open)`。

```
APR on equity = L × supplyApr(u) − (L−1) × borrowApr(u) + 獎勵
u(E)          = (B_exMe + (L−1)E) / (S_exMe + L E)        ← 我進場「之後」的利用率
```

- 有 IRM（分段線性）時，借貸利率都用進場後的利用率去算；`projectedSignals` 也用它檢查進場後會不會踩到 90%。
- 一個重要的直覺：**以 70% LTV 循環時，我加進去的借/供比是 0.7**。如果池子現在利用率是 0.8，
  我進場反而會把利用率往下拉；以 90% LTV 循環才會往上推。測試裡有這個案例。
- 沒有 IRM 時：借款 APR 會隨「我新增的毛佔用 / (10% 可用流動性)」線性放大到 `rate_uncertainty_mult`（1.3）。
  loop-farm 原本是整段乘 1.3，改成隨部位大小漸進，加碼時的邊際計算才不會跳一階。

### 4.4 獎勵幣折價：從固定 50% 改成可量測的模型

```
realizable = 1 − slippage − drift          （再夾在 [min, max] 之間）
slippage   = 2% × 每次領取金額 / 2% 深度         （線性衝擊，上限 50%）
drift      = sell_on_claim：max(0, −trend) × t + k × vol × √t     t = 領取間隔（年）
           = hedge（有 perp）：對沖成本 × t
           = hold：同 sell_on_claim，但 t = 整個持有期
```

- 不認識的代幣仍然用 `default_realizable = 0.5`（跟 loop-farm 一樣）。
- **Plasma／XPL 的教訓就是 `trend` 和 `t` 這兩項**：以年化趨勢 −90%、波動 120% 的代幣為例，
  每天領每天賣時，可實現比例約 0.93（趨勢只吃 0.25%，其餘是一天的波動懲罰）；
  改成抱滿 3 週，趨勢項就吃掉約 5%，加上 3 週的波動懲罰，可實現比例掉到約 0.66。
  賺到行銷預算的是領了就賣的人。

### 4.5 Funding 與積分

- 正的 funding 只算 `funding.realizable = 70%`（費率會翻轉）；負的全額計入。
- 積分永遠不進淨 APR。積分型部位的條件是「為了積分每年最多付 `points.max_cost_apr`（3%）」，
  而且總部位不超過 `points.budget_frac`（10%）。

### 4.6 邊際 APR

```
marginal(from → to) = [ net_hold(to)×to − net_hold(from)×from − 新錢的一次性成本 ] / (to − from)
```

因為稀釋，第 5 筆錢一定比第 1 筆賺得少。配置器用邊際 APR 排序，出場規則用它來判斷「部位是不是太大」。

## 5. 進場閘門（`src/gates/entry.ts`）

**跟部位大小無關**（任何一條不過就不用算大小）：

- router 暫停中、只供探索（沒 executor）、venue 停用
- `delta_neutral_perp` 的兩隻腳在同一個 venue → **直接拒絕**（自成交／洗量，積分活動會取消資格）
- 冷卻期內（一般 6h，緊急出場後 48h）
- 有任何 flag（包括 warn；**歷史推導出的 flag 也算**，例如這一輪剛被抽走 30% 流動性的市場）、任何 signal 達到 warn
- 出場容量 < `min_capacity_usd`
- **對已持有部位加碼**：部位正在出場（鎖存中）、有出場規則在確認期、出場模擬失敗過、健康度已過 rebalance 線，都不加碼

**跟部位大小有關**：

- 最小／最大部位、協議端上限
- **通用版 1/10 規則**：`部位 × footprint ≤ 10% × 出場容量`（估計值先打五折）
- 進場後的 projected signals 不能到 warn（例如進場後利用率）
- 上限：venue（依 tier）、chain、token、kind、單一機會、同時部位數、積分預算、保留閒置資金
- 經濟面：平均淨 APR 與邊際淨 APR 都要 ≥ `baseline_apr + entry_premium[tier]`；估值不是有限數字就拒絕

門檻改成「無風險利率＋風險溢價」：tier 1 要多 3%、tier 2 多 6%、tier 3 多 12%。
這對應簡報的結論——大部分套利已經被壓到無風險利率附近，新協議要給得起溢價才值得碰。

### Tier 評分（`src/tiers.ts`）

手動指定優先；沒指定就用公開事實評分（滿分 8）：稽核數、上線天數、TVL、多簽、timelock、
可升級但沒 timelock 扣分、曾經出事扣 2 分。≥7 → tier 1，≥4 → tier 2，其餘 tier 3。
**掃描器新發現的 venue 預設是 tier 3**（上限 5%、門檻最高），直到你補資料或手動指定。

## 6. 出場優先序（`src/gates/exit.ts`）

| 順序 | 規則 | 動作 | 去抖動 |
|---|---|---|---|
| F | 之前決定的全退還沒成功（鎖存） | 每輪重試，直到部位消失 | — |
| 5 | 出場模擬連續失敗（放在失聯判斷**之前**） | **緊急全退**（趁出口還活著） | 2 次 |
| 0 | 資料源連續 N 輪沒回報（或資料被拒絕、過期） | 3 輪告警、10 輪全退 | — |
| 1 | 任何 exit 級 flag（暫停、脫鉤、流動性被抽乾、指標暴衝） | **緊急全退** | 不去抖 |
| 2 | **通用版 1/5 規則**：部位 × footprint ≥ 20% × 出場容量 | **緊急全退** | 不去抖 |
| 3 | 任何 signal 達到 exit（利用率 95%、兩所價差 100bps…） | **緊急全退** | 不去抖 |
| 4 | 健康度：過 critical 全退；過 rebalance 先去槓桿；有槓桿卻沒有健康度資料 → 告警（可設成全退） | 全退／再平衡 | — |
| 6 | 快結束的收益流拿掉之後，淨 APR < 出場門檻 | 全退（非緊急） | 不需要 |
| 7 | 持有淨 APR（收益流用目前利率，不做時間加權）< 出場門檻 | 先砍一半；低於地板或剩太小就全退 | 2 輪且 ≥ 10 分鐘 |
| 8 | 已持有的最後一塊錢邊際 APR < 出場門檻（被自己稀釋；不再重算進場成本） | 砍一個 chunk | 2 輪且 ≥ 10 分鐘 |

流動性和壓力類永遠一次全跑：擠兌的時候先跑的人才拿得到錢。利差壓縮則可以分段減倉。
出場門檻比進場低（遲滯），避免在門檻附近反覆進出。

**任何全退都會鎖存**（`Position.forcedExit`）：決定之後先記下來再去執行，失敗就每輪重試，
不會因為觸發條件只存在一輪（指標暴衝、熔斷、手動 `/exit`）就被忘掉。
砍倉後如果剩下的部位小於 `min_position_usd` 的一半，會把剩下的也真的平掉，而不是在帳上當成現金。

### 從歷史資料算出來的訊號（`src/signals.ts`）

- **流動性被抽乾**：出場容量比 60 分鐘內高點少 30% → exit flag（`capacity_drop`）
- **指標暴衝**：`spike_rules` 裡的任何指標比 60 分鐘視窗內的最低點高太多 → exit flag（預設 `borrow_apr` +10pp）。
  跟視窗最低點比，所以分好幾步慢慢爬上去也抓得到
- **排放被砍**：池子獎勵 APR（不含我）比 24h 內高點少一半 → warn flag
- **獎勵幣崩盤**：24h 從高點跌 25% → 觸發領取並全部賣掉

## 7. 參數對照：loop-farm → incentive-router

| loop-farm `config/default.yaml` | 這裡 | 變化 |
|---|---|---|
| `liquidity.entry_max_frac_of_available: 0.10` | `liquidity.entry_max_frac_of_capacity` | 「可借流動性」換成各 source 定義的出場容量 |
| `liquidity.exit_frac_of_available: 0.20` | `liquidity.exit_frac_of_capacity` | 同上 |
| `liquidity.min_available_usd` | `liquidity.min_capacity_usd` | |
| `liquidity.utilization_warn/exit` | `sources.lending_loop.utilization_warn/exit` | 變成 source 層的 StressSignal；LP、perp 有各自的訊號 |
| `spread.entry_min_net_apr: 0.05` | `baseline_apr + thresholds.entry_premium_by_tier[tier]` | 改成無風險利率＋分 tier 溢價 |
| `spread.exit_min_net_apr: 0.015` | `baseline_apr + thresholds.exit_premium_by_tier[tier]` | 同上，維持遲滯 |
| `spread.reward_haircut: 0.50` | `rewards.default_realizable` ＋ 折價模型 | 只有不認識的代幣才用 50% |
| `spread.expected_hold_days: 21` | `hold_horizon_days` | 也用在獎勵的時間加權 |
| `spread.borrow_apr_spike_abs: 0.10` | `spike_rules.borrow_apr` | 任何指標都能設 |
| `spread.reward_ending_hours: 12` | `rewards.ending_hours` | |
| `spread.navi_rate_uncertainty_mult: 1.30` | `sources.lending_loop.rate_uncertainty_mult` | 隨部位大小漸進 |
| `caps.per_protocol_frac.tier1/tier2` | `caps.per_venue_frac_by_tier` | 多了 tier 3 與自動評分 |
| `caps.per_token_frac / per_chain_frac` | 同名 | chain 可以逐條設定 |
| `caps.max_concurrent_positions / min,max_position_usd / reentry_cooldown_hours` | 同名 | 另有緊急出場後的冷卻 |
| `leverage.*` | `sources.lending_loop.*` | 健康度改成通用的 `HealthView` |
| `sim_close_every_n_cycles` | `exit_probe.max_age_minutes / max_consecutive_failures` | |
| `claim_interval_hours` | `rewards.default_token.claim_interval_hours`（可逐幣） | |
| `gas.min_sui_balance` | （尚未移植，屬 executor 的責任） | 見 §13 |

**新增、loop-farm 沒有的**：單一獎勵幣曝險上限、kind 上限、單一機會上限、保留閒置資金、積分預算、
流動性被抽乾的訊號、排放被砍告警、獎勵幣崩盤自動賣、組合回撤熔斷、資料源失聯出場、
水位填充配置、被自己稀釋時砍部位、tier 自動評分、拒絕同所對沖、緊急出場後暫停配置一輪、告警去重。

## 8. 配置器（`src/allocator.ts`）

loop-farm 是「每個市場算一個部位大小，再按預估 APR 排序」。農場一多、而且收益會被自己稀釋時，
這樣不夠好，所以改成**水位填充**：

0. 可配置金額 = min(總權益 × (1 − 閒置比例) − 已配置, **閒置現金** − 閒置緩衝)。獎勵幣算在權益裡（給上限和回撤用），但不是現金。
1. 每次發一個 chunk（權益的 2%，至少 $500；新部位第一筆至少 `min_position_usd`）。
2. 給「邊際淨 APR 最高、而且加上這筆之後所有閘門都過」的機會。
3. 重複直到沒錢、或沒有任何機會過得了閘門。
4. 非積分型永遠排在積分型前面；每輪最多開 `max_new_positions_per_cycle` 個新部位；
   對既有部位加碼小於 `min_rebalance_usd` 就不做。

報酬是凹函數時，貪婪法就是最佳解。測試案例：一個在 $100k 池子裡年排放 $50k 的農場，
單獨存在時會停在約 $15 萬（邊際 APR 降到 7.5% 門檻：E·P/(P+x)² = 7.5% → x ≈ 158k）；
旁邊有一個 9% 的穩定選項時，它只會拿到邊際 APR 還贏 9% 的那一段，剩下的錢去穩定選項，
最後被 USDC 80% 的單一代幣上限擋住。

## 9. 獎勵處理（`src/rewards.ts`）

每個獎勵幣一個政策：

- `sell_on_claim`（預設）：照排程領，領了就賣。
- `hedge`：維持空單 = 未領 + 已持有；沒有 perp 可對沖就退回「領了就賣」。
- `hold`：只賣超過 `max_hold_usd` 的部分。

所有政策都會被以下規則覆蓋：

- 24h 從高點跌 ≥ 25% → 不等排程，只要金額 ≥ 5× gas、而且離上次領取 ≥ 6 小時就領，然後全部賣掉。
- 整個帳本對單一獎勵幣的曝險（未領＋持有−對沖）> 權益的 5% → 領並賣到上限以下（同樣的間隔限制）。
- 已經沒有曝險的對沖（最後一個部位關掉、perp 下架、政策改了）會被平掉，不會留下孤兒空單。
- 平常領取金額必須 ≥ max(`claim_min_usd`, 5× gas)。

## 10. 積分與洗量的界線

- 積分型部位用自己的預算（10%）和成本上限（每年 3%），淨 APR 不把積分算進去。
- **同一個 venue 兩隻腳對沖 = 自己跟自己成交**：source 直接 throw，進場閘門也會擋。
  跨所對沖的每一隻腳都是跟市場上其他人成交，這是可以做的；同所自己對敲不行。

## 11. 組合層保護（`src/monitor.ts`）

- **熔斷**：總權益在 24h 內從高點回撤 5% → 全部緊急出場（鎖存，失敗會重試）、暫停進場；
  `/resume` 會重設回撤視窗，不然下一輪又會被舊的高點觸發。
  實盤時 executor 要實作 `markToMarket`，每輪用鏈上真實價值取代帳面值，被駭、壞帳、IL、perp 損益才看得到。
- **資料驗證**：所有數字欄位進來時檢查是不是有限數字（NaN 會讓所有比較都是 false，等於所有閘門失效）；
  `dataAsOfMs` 超過 10 分鐘視為過期。不合格的資料一律當成「沒回報」，持倉就進入失聯流程。
- **每個外部呼叫都包 try/catch，每執行一個動作就存一次狀態**：某個 adapter 丟例外不會讓整輪中斷、也不會讓已經做完的出場被忘掉而重做。
- **資料源失聯**：持倉的機會連續 3 輪沒回報 → critical 告警；10 輪 → 全退。看不到風險就不要留著。
- **單一資料源壞掉不影響其他**：`Promise.allSettled`，錯誤變成去重後的告警。
- **有緊急出場在進行（決定了、成功或失敗）的那一輪不配置**：市場可能正在傳染，讓它過一輪再說。
- **告警去重**：狀態告警帶明確的 key（部位 id ＋規則），同一個 key 6 小時內只發一次；進出場、失敗這類事件不去重。
- **Telegram**：沿用 loop-farm 的 chat id 白名單；指令 `/status /pause /resume /exit <id> /exitall`。

## 12. 情境模擬（`examples/scenarios/`）

用真的 router ＋ paper executor 重播一段腳本化的市場時間線，也拿來當整合測試：

```bash
npx tsx src/cli.ts sim examples/scenarios/plasma-reward-collapse.yaml
npx tsx src/cli.ts sim examples/scenarios/bank-run.yaml
```

**Plasma 式獎勵崩盤**（每步 1 小時）：

- 第 0 步：分別放 $30k 到 Plasma 存款補貼（tier 2）與 Suilend 循環貸（tier 1）。
- 第 20 步：XPL 一天跌 35% → 觸發崩盤規則，把未領獎勵領出來賣掉；24 小時的崩盤視窗內每 6 小時領賣一次。
- 第 40 步：排放砍到三分之一 → 只發 `emission_drop` 告警。剩下的淨 APR 還高於出場門檻，所以**不**出場。
- 第 60 步：宣布第 68 步結束活動 → 「拿掉 12 小時內會結束的獎勵之後只剩 4%」< 6.5% → 非緊急全退。

**擠兌／出口失效／資料源失聯**：

- 第 12 步：NewLend 一小時內被抽走 45% 流動性 → `capacity_drop` 緊急全退，該輪暫停配置。
- 第 30–32 步：Suilend 的出場模擬連續失敗 2 次 → 第 32 步趁還能出去時緊急全退。
- 第 45 步起：Navi 的資料源消失 → 第 47 步 critical 告警，第 54 步（失聯 10 輪）全退。
- 第 60 步：NewLend 的 48 小時緊急冷卻結束，條件又符合，重新進場——如果你希望出過事的 venue
  隔離更久，把 `urgent_reentry_cooldown_hours` 調大，或直接把它的 tier 降下來。

## 13. 跟現有 repo 怎麼接

- **loop-farm（Navi / Suilend）**：`fromLoopFarmMarket(marketState, "sui", rewardSymbol, myLtv)` 把
  `MarketState`（bigint 單位）轉成 `LoopMarket`，用 `LoopLendingSource` 包起來即可。
  **`myLtv` 一定要給**（loop-farm 的部位健康度），否則健康度規則跑不到，每輪會告警。
  adapter 也應該設 `dataAsOfMs`（鏈上時間），快取住的舊資料才會被判定過期。
  loop-farm 的 executor 對應關係：一鍵循環 PTB → `enter`、單筆 tx 平倉 → `exit`
  （`fraction < 1` = 去槓桿）、去槓桿到目標 LTV → `rebalance`、devInspect 平倉 → `simulateExit`。
  IRM 只在 loop-farm 已經用目前借款利率自我驗證過的情況下才傳進來（驗證失敗就不給，這裡會改用漸進乘數）。
- **Aqua / LP 激勵**：用 `lpIncentiveOpportunity`。`concentration` 填你的區間相對全區間的資金效率，
  `exitCapacityUsd` 填非穩定幣那一側在衝擊預算內能賣掉的量。
- **跨所 perp**：`perpHedgeOpportunity`，費率請給「回看平均」而不是瞬時值。
- **Merkl / DefiLlama 掃描器**：只做探索。它們告訴你行銷預算現在花在哪裡；要真的下單，還是要先寫 adapter。
- **測試機流程**：建議先在測試機上跑 `run --paper` 加上真的 source（只讀），確認訊號和告警合理，再接 executor。

## 14. 還沒驗證的部分與限制

- **Merkl 欄位**：Merkl 官方的完整 schema 沒有靜態頁面。這裡用到的欄位（`apr`、`tvl`、`dailyRewards`、
  `status`、`latestCampaignEnd`、`chain.name`、`protocol.id`、`rewardsRecord.breakdowns`）來自官方文件片段
  和公開整合，所以全部防禦式讀取；請在有網路的機器上跑 `verify-sources` 確認。
- **DefiLlama**：`apy*` 是 APY，進來時一律換算成 APR（每日複利）。借款欄位看起來是由獨立的
  `/lendBorrow` 提供（以 `pool` 對應），source 會兩個都抓再合併；這點還沒在線上確認，請跑 `verify-sources`。
  `rewardTokens` 是地址不是代號，需要自己對照；DefiLlama 沒有 IRM、cap、暫停狀態，
  所以它產生的循環貸候選只能當探索用。
- **LVR** 用的是全區間 CPMM 的 σ²/8，再乘集中倍數，對窄區間只是近似。
- **Paper 帳務**是簡化的：獎勵依當前估值累積、出場時未領獎勵按 `default_realizable` 計價。
  它的用途是驗證決策邏輯，不是回測報酬。
- 這個 repo **沒有任何鏈上 executor**；`run` 只接受 `--paper`。
- gas 餘額檢查（loop-farm 的 `gas.min_sui_balance`）屬於 executor 的責任，還沒移植。
- `cycle()` 與 `handleCommand()` 都會讀寫整份狀態，必須在同一個迴圈裡依序呼叫（CLI 就是這樣），不能並行。
- 從錢包提領的資金如果透過 `idleUsd` 回報，看起來會像回撤；提領前先 `/pause`，提領後 `/resume` 重設視窗。

### 獨立審查

寫完之後另外跑了一次獨立的風控審查（不看撰寫過程、只看程式碼和這份文件），找到 6 個高、7 個中、6 個低嚴重度的問題，
主要是：歷史推導的 flag 沒有擋進場、緊急出場失敗後不會重試、單一 adapter 丟例外會讓整輪狀態遺失、
NaN 可以通過所有閘門、「部位太大」規則重複收進場成本、孤兒對沖、獎勵幣被當成可配置現金等。
全部已修正，每一項都有對應的回歸測試（`test/regressions.test.ts`）。

## 15. 下一步建議

1. 在測試機上把 loop-farm 的 Navi／Suilend market provider 接進 `LoopLendingSource`，跑 `run --paper`
   一兩週，比對告警與實際狀況。
2. 補一個代幣資料 feed（價格、2% 深度、30 日波動與趨勢），讓獎勵折價模型吃真的數字。
3. 依序加 executor：先循環貸（現成）、再 Aqua LP、最後跨所 perp。
4. 把 `scan --live` 放進每天的排程，看行銷預算往哪裡流。
