# 選倉邏輯：循環貸 vs 單純放貸，用同一把尺比較（2026-10-29）

> 這份文件說明 router 怎麼決定「錢放哪裡、放多少、什麼時候走」，
> 以及新加的**單純放貸**（只存不借、不能循環）怎麼和循環貸放在同一個尺度上比較。
> 程式在 `packages/core`；設定在 `config/live-router.yaml`；範例情境在 `examples/scenarios/selection-2026-10-29*.yaml`。
> 數字是 2026-10-29 的研究快照，**不是即時資料，也不是投資建議**。實盤一律以鏈上讀數為準。

---

## 0. 結論（用 live 設定、10-29 的數字）

1. **USDe 循環貸在研究過的脫鉤模型下已經不划算。**
   - USDe 被列為第 3 級穩定幣：合成型、只有白名單能贖回，而且 CEX 上脫鉤過三次。
   - 預期脫鉤損失每年 1.5%，循環 3.33 倍放大成每年約 5%。
   - 所有 Liquid Leverage 循環扣完後淨收益都低於 1%，全部不進場。
2. **單純放貸今天大概 5.5–6%，只比 4.5% 基準多 1–1.5%，而且多數加碼來自「今天就到期」的每週活動。**
3. **router 只選了一個：Ethereum 上的 Fluid fUSDC（5.87%，原生利率，沒有獎勵到期問題）。**
   - 放 $120k，這是單一部位上限。
   - 錢從 Arbitrum 用 CCTP 搬過去，成本約 $5.4，不到一天收益（約 $19）。
   - 其餘 $180k 留在原鏈不動。
4. **其他候選被擋下的原因各不相同：**
   - 利率不夠（NAVI USDC 5.72% < 6.5%）。
   - 利用率太高（Plasma USDT0 93.7%、Sentora RLUSD 98%、Monad USDC 92%）。
   - 每週獎勵今天到期，幾乎不算錢（Aave V4 USDC／USDG、Horizon RLUSD）。
   - 換幣成本超過一天收益（NAVI USDsui、Plasma GHO）。
5. 「每週活動會續」的假設預設關閉，打開後選倉結果也一樣（見 §6）。

---

## 1. 流程

```
資料來源（adapter / 靜態情境）
   │  SupplyMarket（單純放貸）、LoopPair（循環）
   ▼
Opportunity（同一種格式；kind = deposit 或 lending_loop）
   │
   ├─ 進場前的硬性條件（entryBlockers）
   │    協議停用、資料過期、脫鉤／利用率警告、暫停旗標、
   │    穩定幣等級超過 sources.supply.max_risk_tier ……
   │
   ├─ 估值（valueAt）：net = raw − haircut − depeg − costs − move
   │
   ├─ 門檻：baseline + 協議等級溢價 + 種類調整（deposit 比 loop 低）
   │
   ├─ 分配（planAllocation，貪婪注水）
   │    每次給「邊際淨 APR 最高、而且還過得了所有關卡」的那一塊錢。
   │    關卡：上限（每協議／每鏈／每幣／每種類）、1/10 流動性規則、
   │          稀釋後的利率、跨鏈搬運成本 ≤ 一天收益。
   │
   └─ 出場規則（decideExit，每輪都跑）
        資料失明、脫鉤、利用率 ≥ 95%、1/5 流動性、獎勵快到期、利差跌破出場門檻……
```

`sim --why`（情境）和 live runner 的 `plan --why` 都會印出同一張表：每個候選的 net 拆解、門檻和被擋的原因。

---

## 2. 一把尺：net 怎麼算

```
net = raw − haircut − depeg − costs − move        （全部是年化，單位 %/年）
```

| 項目 | 單純放貸（deposit） | 循環貸（loop） |
|---|---|---|
| raw | 存款利率（我的錢會稀釋利率：有 IRM 用 IRM，沒有就按比例稀釋）＋獎勵 | 槓桿後的存款收益 − 借款成本 ＋ 兩邊獎勵 |
| haircut | 獎勵折價：代幣賣出滑價與價格漂移；獎勵到期前的時間加權（見 §5） | 同左 |
| depeg | 該穩定幣的預期脫鉤損失 × 1 | 同幣循環 × 1；兩種幣的循環 × 槓桿 L（抵押品那一邊） |
| costs | gas（2 筆進、1 筆出），按持有期 21 天攤提 | gas（約 40 筆進出）＋ 換匯來回，按 21 天攤提 |
| move | 跨鏈／換幣搬運成本，同樣按 21 天攤提（錢本來就在那條鏈上時為 0） | 同左 |

補充：

- **單純放貸拿得到什麼獎勵：**
  - 淨額型補貼（NET_LENDING）全額拿得到，因為我們沒有借款。
  - 要求「健康因子 ≤ 2」的獎勵（Liquid Leverage）**拿不到**，因為必須借款。
  - 每人上限（例如 Aave V4 USDC 只算前 $100k）照算。
- **Aave／Merkl 的 NET_APR 活動是「把總 APR 補到目標值」。**
  Merkl 的 `apr` 欄位是目標總值，不是額外獎勵。程式用實際發放量計算（每日發放 × 365 ÷ TVL），不會重複計算。
- **用穩定幣發的獎勵**（USDC、GHO、RLUSD 之類）沒有價格漂移，折價只有 5%（`max_realizable` 0.95）。
- **固定成本：** 以太坊上的 gas 在 $6k 的小額試單時很重（約 0.4%/年），放到 $100k 以上就幾乎可以忽略。
  分配器第一次進一個新部位時，會試更大的第一筆（倍增到上限），取最小的、能過所有關卡的那一筆。
  所以以太坊上的好池子不會因為第一塊太小而永遠進不去。

---

## 3. 門檻（`config/live-router.yaml`，baseline 4.5%）

| 協議等級 | 單純放貸：進場 | 單純放貸：出場 | 循環：進場 | 循環：出場 |
|---|---|---|---|---|
| 1（Aave V3、Morpho Blue、Suilend、Fluid） | 5.5% | 4.5% | 7.5% | 4.5% |
| 2（Aave V4、NAVI、Euler、MetaMorpho vault、Aave Horizon） | 6.5% | 5.0% | 10.5% | 6.5% |
| 3（Scallop、一般 ERC-4626） | 8.5% | 6.0% | 16.5% | 9.5% |

- **為什麼放貸門檻比較低：** 放貸沒有清算、沒有換匯來回、曝險只有 1 倍，脫鉤損失也已經另外扣掉了。所以溢價大約只要循環的三分之一。
- 這是政策選擇，可以改：`thresholds.kind_premium_adjust.deposit`，可以填單一數字或依等級分開填。
- 進場和出場之間留有差距（遲滯），避免利率在門檻附近來回時反覆進出。設定檢查會拒絕「出場門檻 ≥ 進場門檻」的設定。
- **其他上限：**
  - 每協議：tier 1 40%、tier 2 15%、tier 3 5%。
  - 單一部位：40%，canary 期間另外有硬上限。
  - 每鏈 60%。
  - 單純放貸合計最多 50%（`caps.per_kind_frac.deposit`）。

---

## 4. 穩定幣脫鉤風險分級（研究 2026-10-29）

### 4.1 分級

| 等級 | 幣 | 預期損失/年 | 警告 | 出場 |
|---|---|---|---|---|
| 1 | USDC（0.05%）、USDT／USDS／DAI（0.10%）、PYUSD、RLUSD、USDG（0.08%） | 約 0.08% | 0.3% | 1.0% |
| 2 | USDC.e（0.20%）、USDT0、GHO、AUSD、USDsui、mUSD、frxUSD、USDtb、USD1、suiUSDT（0.30%） | 約 0.3% | 0.5% | 1.5% |
| 3 | USDe、crvUSD、FDUSD（1.5%）、sUSDe、Sui 上的 Wormhole wUSDC/wUSDT（2.0%） | 1.5–2% | 0.7% | 2.0% |

- **預期損失的算法：** 每年觸發出場的頻率 × 出場時實際的損失，加上永久失錨的機率 × 損失比例。
- **代表性事件：**
  - USDC 2023/3 SVB：跌破 0.88，約 3 天。
  - USDe 2025/10 在 Binance 跌到 0.65，鏈上維持 0.985 以上。
  - FDUSD 2025/4：0.87，約 36 小時。
  - GHO 長期有 0.3–5% 的折價。
  - USDsui 2026/8/22 跌到 0.97。
- **最不確定的判斷：**
  - USDT 列第 1 級：準備金緩衝只有 2.2%，S&P 評為「weak」。
  - DAI／USDS 列第 1 級：只在 PSM 裡還有 USDC 的時候成立。
  - USDG 在我們用的鏈上流動性很薄。
- 不在表上的穩定幣一律當第 3 級（`sources.supply.unknown_stable_tier`）。

### 4.2 程式怎麼用這張表

- **單純放貸只做第 1、2 級**（`sources.supply.max_risk_tier: 2`）。第 3 級的穩定幣不能單純存，可以出現在循環裡，但要付 L 倍的預期損失。
- **預期損失當成持有成本**，每年從 net 裡扣掉。
- **脫鉤訊號用市價算**，也就是 |價格 − 1|，價格來自 DefiLlama 多交易所彙總。
  - 不用協議預言機，因為預言機常被釘在 1。2026/7 AZND 事件時，市價約 0.18，預言機還顯示 1。
  - 警告級：禁止新進場。
  - 出場級：全部出場，不做去抖動，因為擠兌時先走的人先拿到錢。
- **單一資產上限：** `stables.<幣>.max_frac` 可以限制某一種幣在所有部位裡的合計占比。

### 4.3 研究建議了、但還沒自動化的規則（目前要人工盯）

- 價格用三個來源的穩健中位數，而且要持續 15–30 分鐘才算數。目前用單一彙總價，每輪都判斷。
- 遇到下面任何一件事要立刻出場：
  - 橋或 DVN 暫停或被駭；
  - 發行方停止鑄造或贖回；
  - PSM／GSM 緩衝低於供給的 10%，或 PegKeeper 歸零；
  - 準備金證明遲交超過 60 天。

  這些目前沒有資料源，要靠人工監看，然後用 Telegram `/exit`。
- 借貸協議本身的風險（例如 Kelp/Aave、AZND/Morpho）不在這張表裡，只由協議等級和上限處理。

---

## 5. 獎勵到期與「每週活動會續」假設

- 今天看得到的 Aave Monad／V4 補貼幾乎都是**每週一期，10/29 13:00–14:00 UTC 到期**，下一期會不會續、給多少都不知道。
- **預設是保守做法：**
  - 獎勵到期後就當作 0。估值按「剩餘時間 ÷ 21 天」加權，還剩 14 小時的每週活動只值約 3%。
  - 持有中的部位如果「扣掉 12 小時內到期的獎勵」後跌破出場門檻，就整筆出場（出場規則 6）。
- **可以自己打開續期假設**（`config/live-router.yaml` 的 `rewards.renewal`，預設註解掉）：

  ```yaml
  rewards:
    renewal:
      aave-v4: {prob: 0.8, period_days: 7}   # 每週有 80% 機率以同樣利率續期
  ```

  - 估值時，第 k 期用 0.8^k 加權。
  - 出場規則 6 把快到期的獎勵當作「× 0.8」，而不是歸零，避免每週到期前一律出場、續了之後又進場的空轉。
  - 這是對補貼計畫的主觀判斷，不是市場事實，打開前請先觀察幾週。

---

## 6. 情境：2026-10-29，$300k

- **起始資金：** Arbitrum USDC $150k、Plasma USDT0 $100k、Sui USDC $50k。
- **候選：** 12 個單純放貸、4 個循環。
- **設定：** 直接讀 `config/live-router.yaml`（`router_config:`）。
- **執行：**

  ```
  npx tsx packages/core/src/cli.ts sim examples/scenarios/selection-2026-10-29.yaml --why
  ```

### 6.1 結果

| 結果 | 候選 | 試算規模 | net | 門檻 | 原因 |
|---|---|---|---|---|---|
| **選中 $120k** | Fluid fUSDC（Ethereum，tier 1） | $120k | **5.72%**（扣掉搬運後；搬到後 5.79%） | 5.5% | 原生 5.87%；CCTP 搬運 $5.37 |
| 不進 | NAVI USDsui（Sui） | $30k | 6.65% | 6.5% | 5 bps 換幣成本 $15 > 一天收益 $5.5 |
| 不進 | NAVI USDC（Sui） | $24k | 5.72% | 6.5% | 低於 tier 2 門檻 |
| 不進 | Fluid fUSDT0（Arbitrum） | $6k | 4.75% | 5.5% | 低於門檻；Fluid 已滿 40% |
| 不進 | Aave V3 Plasma GHO | $24k | 4.61% | 5.5% | WXPL 獎勵折價重；GHO 預期損失 0.3% |
| 不進 | Aave V3 Plasma USDT0 | — | 4.38% | 5.5% | 利用率 93.7% 達警告級 |
| 不進 | Morpho Sentora RLUSD | — | 4.32% | 6.5% | 利用率 98%，達出場級（可提領量未驗證） |
| 不進 | Aave V3 Monad USDC | — | 4.18% | 5.5% | 利用率 92%；WMON 每週活動今天到期 |
| 不進 | Fluid fGHO（Ethereum） | $6k | 4.10% | 5.5% | 低於門檻；Fluid 已滿 40% |
| 不進 | Aave V4 Core USDC | $24k | 3.26% | 6.5% | 2.65% USDC 補貼 14 小時後到期，幾乎不算 |
| 不進 | Aave Horizon RLUSD | $24k | 2.51% | 6.5% | 補貼到 11/5，時間加權後偏低 |
| 不進 | Aave V4 Core USDG | $24k | 1.95% | 6.5% | 3.6% 補貼今天到期 |
| 不進 | 循環 Plasma USDe→GHO | $24k | 0.57% | 7.5% | 脫鉤 5.0%（3.33 × 1.5%）＋換匯成本 |
| 不進 | 循環 Monad USDe→USDT0 | $24k | −1.87% | 7.5% | 同上，WMON 獎勵到期 |
| 不進 | 循環 Ethereum USDe→USDC | — | −2.20% | 7.5% | USDC 利用率 94% |
| 不進 | 循環 Plasma USDe→USDT0 | — | −2.83% | 7.5% | USDT0 利用率 93.7% |

- 第 0 輪：把 $120k 從 Arbitrum 經 CCTP 搬到 Ethereum。
- 第 1 輪：錢到了就存進 Fluid。
- 結果：$180k 留在原鏈；權益變動 −$4，就是搬運和 gas。

### 6.2 What-if：每週活動有 80% 會續

```
npx tsx packages/core/src/cli.ts sim examples/scenarios/selection-2026-10-29-whatif-renewal.yaml --why
```

- Aave V4 USDC 升到約 4.5–4.9%，Aave V3 Plasma GHO 升到 5.73%，但結果不變：
  - Aave V4 USDC 還是低於 6.5%。
  - Plasma GHO 卡在 3 bps 換幣成本超過一天收益。
- **意思是：** 今天單純放貸的超額收益，大部分只能靠「相信補貼會續」才撐得起來。

### 6.3 「一天收益」規則對換幣的影響

- 你設的跨鏈磨損上限是「一次搬運 ≤ 目的地一天收益」。年化 6% 時，一天收益只有 1.6 bps。
- 所以目的鏈上需要換幣（USDC → GHO／RLUSD／USDsui／AUSD，通常 3–5 bps）的池子幾乎都會被擋。
- CCTP 和 USDT0 搬運只付 gas，不受影響。
- 如果想放寬：把 `xchain.max_cost_days_of_yield` 調到 2–3。

---

## 7. 新增的程式（第 2 輪）

| 位置 | 內容 |
|---|---|
| `core/src/sources/supply.ts` | `SupplyMarket` → kind `deposit` 的 Opportunity。<br>IRM 稀釋、獎勵規則、可提領量決定 1/10 與 1/5 規則。<br>資料缺漏（NaN）時沿用最近值並禁止進場，沒有最近值就當作沒回報。 |
| `core/src/stables.ts` | 脫鉤分級、預期損失、各幣的警告／出場水位 |
| `core/src/selection.ts` | `explainSelection`／`formatSelection`（`--why` 那張表） |
| `core/src/valuation.ts` | 續期假設、穩定幣獎勵不折價 |
| `core/src/allocator.ts` | 固定成本場所的第一筆加大 |
| `live-evm/src/aave`、`live-aave-v4` | Aave V3 與 V4 的單純存款：精確授權後歸零、全額提領不留塵 |
| `live-evm/src/vault` | ERC-4626：Euler EVault、MetaMorpho、Fluid fToken、一般 vault |
| `live-sui/src/navi`、`suilend`、`scallop` | Sui 三家的單純存款。<br>和循環部位分開：NAVI 用錢包帳戶；Suilend 用專用、不借款的 obligation；Scallop 用 sCoin／spool。 |
| `live-runner` | `SupplyExecutor`／`SupplyRegistry`、vault 接線、領獎、對帳時會收養錢包裡沒登記的存款、`plan --why` |

**上線順序和循環一樣**：`verify` → shadow 3–7 天 → canary（$2k／$10k）→ 逐步放大。設定範例在 `config/live.example.yaml` 的 `supply:` 和 `vaults:`。

---

## 8. 已知限制

- **市價抓不到時會退回協議價：** `SupplyRegistry` 會改用協議自己的價格，同時記一筆警告。如果協議預言機被釘在 1，這段期間就看不到脫鉤。
- **Fluid 與一般 vault 的 APR** 是從份額價格成長推算的，需要能查歷史狀態的 archive RPC。
  - Fluid 的可提領量是上限估計，提領速率限制沒有讀進來。
- **還不支援：** MetaMorpho vault V2、Compound v3、Spark Savings。
- **研究沒驗到的數字**（情境裡已標註）：
  - Sentora RLUSD 的可提領量；
  - 各 Aave 儲備的存款上限餘額；
  - Plasma GHO 獎勵在 WXPL 和 aPlaGHO 之間的拆分。
- 情境只是快照，用來示範選倉邏輯。真正的決策每 60 秒用鏈上讀數重算一次。

## 資料來源

- **單純放貸利率**（皆為 2026-10-29）：
  - Merkl v4 API，`https://api.merkl.xyz/v4/opportunities`（ts 1793232000）；
  - aavescan.com（monad-v3、ethereum-v4-core、plasma-v3、horizon-v3、ethereum-v3、rates）；
  - `https://api.fluid.instadapp.io/v2/lending/{1,9745,42161}/tokens`；
  - `https://open-api.naviprotocol.io/api/navi/pools`；
  - tradingstrategy.ai（Sentora RLUSD、Valos vUSD）。
- **脫鉤分級：**
  - [DefiLlama stablecoins API](https://stablecoins.llama.fi/stablecoins?includePrices=true)
  - [21Shares：USDe 2025/10](https://www.21shares.com//research/why-did-ethenas-stablecoin-remain-stable-onchain-but-depegged-on-binance)
  - [KuCoin：USDe 2026/9](https://www.kucoin.com/blog/usde-depeg-binance-0-92-1011-contagion-risk)
  - [Stabilizer：USDT0 評估](https://stabilizer.discourse.group/t/usdt0-risk-assessment-for-stabilizer/710)
  - [CoinDesk：Kelp 2026/4](https://www.coindesk.com/tech/2026/04/19/2026-s-biggest-crypto-exploit-kelp-dao-hit-for-usd292-million-with-wrapped-ether-stranded-across-20-chains)
  - [Aave GHO Stewards 2026/8](https://governance.aave.com/t/gho-stewards-august-2026-gho-borrow-rate-and-aave-savings-rate-update/25534)
  - [GHO 2023 脫鉤分析](https://governance.aave.com/t/gho-depeg-and-liquidity-analysis/15250)
  - [Cork：FDUSD](https://www.cork.tech/blog/fdusd-depeg)
  - [The Block：USD1](https://www.theblock.co/post/390857/trump-backed-world-liberty-financial-says-usd1-short-and-social-media-attack-fails-as-stablecoin-briefly-dips)
  - [The Block：PYUSD 誤鑄](https://www.theblock.co/post/374870/paxos-mistakenly-mints-300-trillion)
  - [The Block：RLUSD OCC](https://theblock.co/news/regulation/2026-10-26-ripple-gains-final-occ-approval-rlusd-431810)
  - [Tether Q2 2026](https://forklog.com/en/news/tethers-excess-reserves-halve-in-q2)
  - [Chaos Labs：frxUSD](https://chaoslabs.xyz/posts/frxusd-token-review)
  - [Webacy：2026 脫鉤](https://www.webacy.com/blog/stablecoin-depeg-failure-mechanisms)
  - [Ethena trust assumptions](https://docs.ethena.fi/technical-design/key-trust-assumptions)
