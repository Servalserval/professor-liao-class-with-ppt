# 穩定幣循環貸市場盤點與起始配置（2026-10-29）

> 範圍：穩定幣「同幣循環」與「穩定幣對循環」（存 A、借 B、B 換回 A 再存）。
> 鏈：研究找到的所有鏈（Sui + 主要 EVM）。資金規模假設約 $300k。
> 數字來源是 2026-10-29 當天的 Aavescan、Merkl v4 API、DefiLlama、各協議文件與二手快照，每列都附來源。
> **bot 上線時一律以鏈上／SDK 即時讀數為準**，這份文件只用來決定「先開哪些市場、各給多少上限」。

---

## 0. 結論

1. **EVM 上能跑的循環，幾乎只剩 Ethena「Liquid Leverage」這一類。**
   規則是：存 USDe、借「非 USDe」的穩定幣，健康因子（HF）≤ 2。獎勵由 Merkl 每週發放，年化上限大約 5–5.75%。
2. **2026 年大多數 Aave／Merkl 穩定幣補貼都是 NET_LENDING／NET_BORROWING 型。**
   這種補貼按「存款扣掉借款」計算，等於刻意讓循環拿不到。同幣循環和多數穩定幣對循環因此失效。
   程式已經處理這點：`RewardRate.netOf` 讓淨額型補貼在循環裡自動歸零或降為 1 倍。
3. **Sui 上的機會都偏薄，而且有規則風險。**
   - Suilend 對同幣與穩定幣對的循環會取消獎勵。
   - NAVI 的 USDsui 池子太小。
   - Scallop 要靠 veSCA 加成，而且整體 TVL 只有 $9.5M。
   - Sui 先以影子模式驗證，資金只放少量。
4. **跨鏈搬錢很便宜，「一次搬運成本 ≤ 目的地一天收益」這條規則很容易守住。**
   - 主要路由是 CCTP V2 Standard（免費）和 USDT0（0 bps，只付 LayerZero 手續費和 gas）。
   - 真正會吃掉預算的是目的鏈上把 USDT0／USDC 換成 USDe 的滑價。
   - 這筆滑價算在搬運成本裡，由 planner 在執行前即時報價檢查。

---

## 1. 什麼叫「可以這樣跑」

一個市場要同時過下面四關，router 才會進場（對應程式在 `packages/core`）：

| 關卡 | 內容 | 程式位置 |
|---|---|---|
| 收益 | 槓桿後淨 APR（扣掉獎勵折價 haircut、稀釋、進出場成本攤提）高於門檻，且進場成本能在 payback 天數內回本 | `valuation.ts`、`gates/entry.ts` |
| 補貼規則 | 獎勵在循環下仍然有效：不是淨額型（`netOf`），HF 在 `maxHealthFactor` 以內，沒有超過每人上限（`perUserCapUsd`） | `sources/loopPair.ts` |
| 流動性 | 進場 ≤ 可提領流動性的 1/10；出場要能在 1/5 規則內退出；兩邊資產換匯深度足夠 | `gates/entry.ts`、`gates/exit.ts` |
| 風險 | 協議等級（tier）、脫鉤訊號（警告 0.3%／退出 1%）、利用率突升、暫停／凍結旗標、資料過期 | `signals.ts`、`gates/exit.ts`、`validate.ts` |

---

## 2. EVM

### 2.1 現在可以跑（Liquid Leverage 類）

槓桿假設：4x（借款／存款 75%）。在 LT 93% 下 HF ≈ 1.24，符合 HF ≤ 2。
淨報酬算法：s + 3(s − b)，s 是含獎勵的存款 APR，b 是借款淨成本，還沒扣換匯成本與脫鉤風險。

| 優先序 | 市場 | 組合 | s | b（淨） | @4x | 狀態 | 程式支援 |
|---|---|---|---|---|---|---|---|
| 1 | Aave V3 **Plasma** | USDe → GHO | 4.95% | 3.58% | **≈9.1%** | 可跑；Liquid Leverage 最深的池（約 $615M） | `live-evm/aave`（v3 adapter，需填市場地址） |
| 1 | Aave V3 **Plasma** | USDe → USDT0 | 4.95% | 4.05% | ≈7.7% | 可跑；USDT0 利用率 93.7%，要盯 | 同上 |
| 2 | Aave V3 **Monad** | USDe → USDT0 | ≈6.0%（含 1% WMON） | 4.32% | **≈11.0%** | 可跑；約 $14M USDT0 可借；WMON 價格和換匯深度是風險；e-mode 待驗 | 同上（已加 `monad` 鏈） |
| 3 | Aave **V4 Avalanche**（Core Hub／Ethena Spoke） | USDe → USDt | 5.75% | 2.38% | **≈15.9%（標題值）** | **待驗證**：活動 10-28 才開始，USDt 是否能對 USDe 借出還沒確認；可借 USDt 只有約 $3.5M；V4 另有風險溢價 | `live-aave-v4`（開發中） |
| 4 | Aave **V4 Ethereum Plus Hub** | USDe → USDT／USDC | ≈5.65% | 4.35% + 溢價 | ≈9.5% − 溢價 | 可跑但上限小 | `live-aave-v4` |
| 5 | Aave V3 **X Layer** | USDe → USDT0 | 5.25% | 3.39% | ≈10.8% | TVL 只有 $2.7M；**沒有 CCTP／USDT0 路由**，入金路徑未驗 | v3 adapter（已加 `xlayer` 鏈） |
| 6 | Aave V3 **Ethereum Core** | USDe → USDC | 5.00% | 4.64% | ≈6.1% | 最穩的備援；USDC 利用率 94%，利差薄 | v3 adapter（address book 內建） |
| 7 | Aave V3 **Mantle** | USDe → USDT0 | 4.28% | 3.68% | ≈6.1% | 可跑，偏薄 | v3 adapter |
| 8 | Fluid GHO smart vault（Plasma GHO-USDT0／ETH GHO-USDC） | 智慧抵押／債務 | 存 5.03–5.67% | 借款端有 1.35–1.61% GHO 補貼，原生借款利率未驗 | — | 有補貼時可跑 | **尚未實作** |

這一類的共同風險：
- 獎勵每週重設。
- HF ≤ 2 規則：去槓桿太多反而會失去獎勵。程式用 `maxHealthFactor` 處理，`loopPair.ts` 會在 HF 超過時把該獎勵歸零。
- USDe 脫鉤或預言機風險：Aave 的 USDe 預言機不一定跟市價走。bot 的脫鉤訊號用 DefiLlama 市價，不用協議預言機。
- 出場流動性：要換回 USDe 來還債，滑價會吃掉利差。
- 獎勵以 aUSDe／USDe 支付，由 Merkl 發放：Distributor `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`，大約每 2 小時更新一次。

### 2.2 有條件、先不開

| 市場 | 原因 |
|---|---|
| Morpho Base USDe/USDC 91.5% | 抵押端有補貼，但推估借款約 4.9% ≥ 存款 4.75%，利差 ≤ 0。adapter 已經寫好，等利差出現再開 |
| Euler v2 Monad AUSD | 7.5–10.5%，但是**單邊放貸**，不是循環；可以當閒置資金去處（尚未實作 adapter） |
| Aave V4 Core USDC 存款 6% | NET_LENDING，前 $100k 有效，循環無效；只適合單邊放 |
| Monad USDC／USDT0／mUSD、V4 USDG／frxUSD、Avalanche V4 USDt 存款 | 都是淨額型補貼，循環會歸零 |

### 2.3 不能跑

| 協議 | 原因 |
|---|---|
| SparkLend | 沒有 Merkl 活動；SSR 設計上約等於借款利率 |
| Compound v3 | 基礎資產是淨額制，不能同幣循環 |
| Venus | 2026-03-15 THE 操縱攻擊，$2.15M 壞帳；10-23 退出 opBNB／OP／Unichain |
| Moonwell | 2026-08-27 Base MAMO 攻擊（約 $8.7–9.1M），借款上限被設為 1 wei，USDC 存款人被卡住 |
| ZeroLend | 2026-02 關閉，LTV 設為 0 |
| Silo v2、Dolomite | 規模太小（$5.6M、$36.9M） |
| HyperLend（穩定幣） | 沒有 Merkl 活動，只有 HPL 質押的借款回饋 |
| Aave V3 Sonic／Linea／MegaETH | 規模太小，或利率異常（Sonic USDC.e 借款 21%） |

---

## 3. Sui

| 協議／組合 | 判定 | 說明 |
|---|---|---|
| Suilend USDsui 抵押 → 借 USDC（官方 strategy，最高 4x） | **有補貼時可跑，先影子驗證** | USDsui 存款獎勵（7 月曾到 9.69%）要高於 USDC 約 5.2% 的淨借款成本。**Suilend 文件說穩定幣對循環會失去獎勵**，鏈上是否真的會歸零沒有驗證到，必須先用影子模式確認 obligation 仍有獎勵資格 |
| Suilend USDC→USDC、USDsui→USDsui | 不能跑 | 同幣循環會失去獎勵，基礎利差也是負的 |
| Suilend sSUI/SUI | 可跑但薄，**不在穩定幣範圍** | SUI 借款獎勵剛好抵掉借款利率 |
| NAVI USDsui | 有補貼時可跑（目前邊際） | 存 7.04% 對借 5.29%，但池子只有約 $1M，數據沒有日期 |
| NAVI USDC／suiUSDT | 不能跑 | 借款利率高於存款利率 |
| Scallop USDC 抵押 → 借 USDsui | 有 veSCA 加成才可跑 | 借款獎勵 20–24% 可能是 4x 加成後的數字；借款費 0.3%；TVL 只有 $9.5M |
| AlphaLend | 不能跑 | 2026-09 宣布清盤，只開放提領 |
| Bucket、DeepBook Margin、Current | 不適用 | 分別是 CDP、只能放貸、獎勵是 points 而且沒有 SDK |

全鏈風險：2026-05-28 到 05-29 Sui 停擺 6 小時 44 分，期間無法清算。
程式支援：`live-sui` 的 Navi、Suilend、Scallop adapter，加上 Cetus 聚合器換匯，循環都用單一 PTB 完成，靠 flash loan 或 strategy helper。

---

## 4. 跨鏈資金配置與磨損控制

### 4.1 規則（`packages/core/src/xchain`，設定在 `config/default.yaml` 的 `xchain`）

| 規則 | 預設 | 意義 |
|---|---|---|
| `max_cost_days_of_yield` | 1 | **單次搬運的全部成本**（橋費、兩端 gas、目的地換匯滑價）≤ 金額 × 目的地淨 APR ÷ 365 |
| `book_daily_budget_days` | 1 | 過去 24 小時所有搬運成本合計 ≤ 整本資金一天的收益 |
| `payback_days` | 14 | 換到新市場的增量收益要在 14 天內賺回搬運加進出場成本，相對 `idle_apr` 計算 |
| `min_move_usd` | 1000 | 太小的搬運不做，避免固定成本吃掉收益 |
| `max_in_flight_frac` | 0.5 | 在途資金最多占整本的一半 |
| `stuck_eta_multiple`／`stuck_min_minutes` | 4／60 | 超過預估時間 4 倍而且超過 60 分鐘就告警，視為卡住 |

在途資金照樣算進淨值，不會被當成虧損觸發 kill switch。路由用 Dijkstra 在 `chain:asset` 圖上找成本最低的路徑。
同一條規則的換算：一天收益等於 APR ÷ 365。$100k 在 6%、9%、11%、15.9% 時，預算分別是 **$16.4、$24.7、$30.1、$43.6**。

### 4.2 路由（費用以執行當下報價為準）

| 路由 | 費用 | 時間 | 備註 |
|---|---|---|---|
| CCTP V2 Standard（USDC） | 0 bps + 兩端 gas（L2 < $0.10） | 從 Eth／L2 出發約 15–19 分；從 Sui、Plasma、HyperEVM、Monad 出發 ≤ 5 秒；從 Avalanche／Sonic 約 8 秒 | **Sui 2026-10-08 起支援 V2（domain 8）**；V1 從 10-31 開始棄用，12-01 完成，程式只用 V2 |
| CCTP V2 Fast | Eth 1 bps、Arb 1.4、Base／OP 1.3 | 8–20 秒 | 只有 Eth／L2 出發才有意義；用 `/v2/burn/USDC/fees` 報價，`maxFee` 加 10–20% |
| USDT0（LayerZero OFT） | 0 bps + LZ 手續費約 $0.3–1 | 30 秒–3 分 | Eth、Arb、OP、Plasma、HyperEVM、Monad、Mantle 等有部署；**Base、Sui、Sonic、BNB、Avalanche 沒有** |
| Across | 約 2–8 bps（$10k） | 2–15 秒 | 不支援 Sui；大額 USDC 底層走 CCTP，作為備援 |
| Stargate 6 bps、deBridge 4 bps + 固定費 | — | — | 在 15% APR 下已經碰到一天收益上限，預設不啟用 |
| CEX（Binance／OKX） | USDT 提領 $0.01–0.4 | 分鐘級 | 只在沒有鏈上路徑時使用（例如 BNB、X Layer）；有帳戶與凍結風險，**bot 不自動走 CEX** |

### 4.3 主要搬運例子（$100k）

| 從 → 到 | 路徑 | 成本估計 | 一天預算（目的地 APR） | 是否通過 |
|---|---|---|---|---|
| Arbitrum USDT0 → Plasma USDe | USDT0 OFT + Plasma 上換 USDe | 約 $1 + 換匯（2 bps 時 $20） | $24.7（9%） | 通過，但換匯滑價必須 ≤ 約 2.3 bps |
| Arbitrum USDT0 → Monad USDe | USDT0 OFT + 換匯 | 約 $1 + 換匯 | $30.1（11%） | 換匯 ≤ 約 2.9 bps 才通過 |
| Sui USDC → Arbitrum USDC | CCTP V2 Standard | < $0.10，< 1 分鐘 | — | 通過 |
| Arbitrum USDC → Sui USDC | CCTP V2 Standard | < $0.10，15–19 分 | — | 通過 |
| Arbitrum USDC → Avalanche USDe | CCTP Standard + 換匯 | < $0.10 + 換匯（Avalanche 上 USDe 深度未驗） | $43.6（15.9%） | 待驗 |
| 任何地方 → X Layer | 沒有 CCTP／USDT0 | — | — | **先不開** |

換匯滑價是唯一可能超標的項目。planner 在每次搬運前，會用目的鏈 swapper 的即時報價把換匯成本算進 `FundingQuote.costUsd`。超過預算就不搬，錢留在原地。

---

## 5. $300k 起始配置建議

**原則：**先全部跑影子模式（鏈上模擬、不廣播）至少 3–7 天，確認交易、獎勵資格和數字都對，再用 canary 上限逐步放大。
**下表是「上限」，不是目標。**實際分配由 router 依淨 APR、1/10 進場規則和磨損規則自動決定。

| 階段 | 市場 | 單一部位上限 | 備註 |
|---|---|---|---|
| A. 影子（全部） | 2.1 表第 1–7 列 + Sui 三家 | — | `mode: shadow`，驗證每一步都能模擬成功、獎勵讀數正確 |
| B. Canary（第 1–2 週） | Plasma USDe→GHO／USDT0、ETH Core USDe→USDC | $2k，總部署 $10k（`canary` 預設） | 用小額驗證進場、出場、領獎與 Merkl 歸屬 |
| C. 放大 | Plasma（兩組合計） | $120k | 最深的池；USDT0 利用率 > 95% 時 router 自動降權 |
| C. 放大 | Monad USDe→USDT0 | $60k | e-mode 與換匯深度實測後再放滿 |
| C. 放大 | Aave V4 Avalanche USDe→USDt | $40k | **只在 verify 確認可借 USDt，且風險溢價後利差仍為正時開** |
| C. 放大 | ETH Core USDe→USDC／Mantle | $40k | 備援，利差薄時 router 不會進 |
| C. 放大 | Sui（Suilend USDsui/USDC、NAVI USDsui） | $20k | 確認穩定幣對 obligation 仍有獎勵後才開 |
| — | 閒置／緩衝 | ≥ $20k | 留給 gas、在途資金、出場時的換匯 |

預期：如果第 1–3 列都滿倉，加權約 8.5–10% APR，還沒扣換匯成本與獎勵折價。實際以 router 的 `plan` 輸出為準。

---

### 5.1 程式層面已知的限制

- **EVM 循環是逐筆交易，不是原子操作。** repo 不部署自訂合約，所以沒有 flash loan 一筆完成的路徑。
  - 目標 LTV 0.7、10 輪大約能做到 3.27x（目標是 3.33x）。
  - 每輪約 5 筆交易，gas 成本已經用 `txs_per_entry`／`txs_per_exit` 算進進出場成本。
  - 沒有到達目標時，adapter 會在結果裡寫出實際槓桿。
- **一個錢包在一個 Aave 市場只有一個帳戶。** 同一市場的多個組合共用 e-mode 和健康因子；不同 spoke 或市場建議用不同錢包。
- **Suilend 的獎勵資格。** 從 Move 原始碼看，同一個 obligation 存借同一資產，鏈上會把整個 obligation 的獎勵份額歸零。文件另外寫「穩定幣存、穩定幣借」也不符資格，但 v8 原始碼沒有公開，無法確認。
  - adapter 預設把這類組合的獎勵視為 0（`assumeRewardsEligible: false`）。
  - **如果你手上還有 Suilend 主市場「USDC 抵押、借 USDsui」的部位，它可能已經沒有在領獎勵**，請在 Suilend UI 確認。
- **Scallop 的抵押品不生息**，循環只能靠借款獎勵。出場需要債務池有足夠現金做 flash loan，這已經算進出場容量。
- **Aave V4 的地址還沒取得。** 沙箱連不到 AaveKit API，Avalanche spoke／hub 地址要從 AaveKit 或官方 dashboard 取得，再用 verify 確認。

## 6. 上線前必須現場確認（`verify` 會做的事 + 人工確認）

1. 每個市場的合約地址從 address book 或 AaveKit 讀出，並用鏈上反查核對（`verifyConfig()`）。Plasma、Monad、X Layer、Mantle 的 Aave V3 地址可能不在 address book 4.44.22 裡，要從官方地址頁填進 `config/live.yaml`，再由 verify 檢查。
2. USDe 抵押的 e-mode（V3）或 spoke 抵押因子（V4）實際數值；HF ≤ 2 的活動規則仍然有效。
3. Merkl 活動的 `type`（AAVE_SUPPLY 或 NET_*）與 net-of 清單；Liquid Leverage 的週期與 APR 上限。
4. Suilend 的穩定幣對 obligation 在鏈上是否真的會被取消獎勵。
5. 目的鏈上 USDT0／USDC → USDe 的換匯深度（Plasma、Monad、Avalanche）。
6. CCTP Fast 是否能轉入 Sui、Fast 額度還剩多少（`/v2/fastBurn/USDC/allowance`）。
7. RPC 用付費節點，公開 RPC 不可靠，也不安全。

---

## 資料來源

- Aave V3／V4 各市場：<https://aavescan.com/>、<https://aavescan.com/stablecoins>、<https://aavescan.com/plasma-v3>（2026-10-29）
- Merkl：Liquid Leverage（Plasma）<https://api.merkl.xyz/v4/opportunities/8495869860536674397>、NET_LENDING 例子 <https://api.merkl.xyz/v4/opportunities/13158230964923482281>、USDe 搜尋 <https://api.merkl.xyz/v4/opportunities?search=USDe&status=LIVE&items=40&sort=tvl&order=desc>、Avalanche <https://api.merkl.xyz/v4/opportunities?search=Avalanche&chainId=43114&status=LIVE&items=20>、領取 <https://developers.merkl.xyz/integrate-merkl/user-rewards>
- USDe 借款利率調整：<https://kitchen.steakhouse.financial/p/defi-markets-update-2026-10-19>
- USDe e-mode：<https://governance.aave.com/t/direct-to-aip-remove-usde-debt-ceiling-and-introduce-usde-stablecoins-e-mode/21876>；Plasma PT-sUSDe e-mode：<https://governance.aave.com/t/direct-to-aip-onboard-pt-susde-22oct2026-to-aave-v3-plasma/25129>
- Aave V4 position managers：<https://aave.com/docs/aave-v4/positions/managers.md>；V4 指南：<https://blog.defisaver.com/defi-saver-guide-to-mastering-aave-v4/>
- 事件：CAPO <https://www.theblock.co/post/393121>、Kelp rsETH <https://forklog.com/en/investors-pull-more-than-8-6bn-from-aave-after-kelp-hack/>、Venus <https://coin360.com/news/venus-protocol-exploit-the-token-price-manipulation-bnb-chain>、Moonwell <https://forklog.com/en/moonwell-suffers-8-7-million-hack/>、ZeroLend <https://www.theblock.co/news/ecosystems/2026-02-17-zerolend-to-shut-down-390119>
- 協議 TVL：<https://defillama.com/protocol/sparklend>、<https://defillama.com/protocol/euler-v2>、<https://defillama.com/protocol/fluid>、<https://defillama.com/protocol/silo-v2>、<https://defillama.com/protocol/dolomite>、<https://defillama.com/protocol/hyperlend>
- Sui：<https://defillama.com/protocols/lending/sui>、Suilend 循環規則 <https://docs.suilend.fi/faq/why-am-i-not-receiving-rewards>、AlphaLend 清盤 <https://pro.edgex.exchange/en-US/news/article/alphafi-alphalend-shutdown-sui-oracle-bad-debt>、Scallop 事件 <https://cryptonews.net/news/security/32774247/>、Sui 停擺 <https://www.kucoin.com/blog/sui-mainnet-outage-gas-logic-bug-1b-assets-2026>、利率快照 <https://www.jewelswap.io/blog/how-to-use-suilend>、<https://www.diadata.org/map/defi-vaults-lending/protocol/navi-lending/>
- CCTP：<https://developers.circle.com/cctp/migration-from-v1-to-v2.md>、<https://developers.circle.com/release-notes/cctp-2026>、<https://developers.circle.com/cctp/concepts/supported-chains-and-domains>、<https://developers.circle.com/cctp/concepts/fees.md>、<https://developers.circle.com/cctp/concepts/finality-and-block-confirmations.md>、<https://developers.circle.com/cctp/references/sui-packages.md>
- USDT0：<https://docs.usdt0.to/technical-documentation/deployments/>、<https://docs.usdt0.to/technical-documentation/developer/>
- Across：<https://docs.across.to/chains-and-contracts>；deBridge：<https://docs.debridge.com/dln-details/overview/fees-supported-chains.md>
