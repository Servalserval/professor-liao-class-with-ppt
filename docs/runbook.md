# 實盤操作手冊（runbook）

這份手冊說明怎麼把 bot 從「只在本機跑測試」一路帶到「實盤，約 $300k」。
每一步都有退路。**任何一步看到不對勁，就停在那一步。**

市場的選擇與起始上限見 [lending-landscape.md](lending-landscape.md)。

---

## 0. 架構一覽

```
                 config/live.yaml（地址、鏈、上限；不含秘密）
                         │
   ┌─────────────────────┼──────────────────────────────────┐
   │ live-runner         ▼                                  │
   │  PriceFeed（DefiLlama 市價） → PairRegistry（市價覆蓋、綁定）│
   │  LendingAdapters（Aave v3/v4、Morpho、Navi、Suilend、Scallop）│
   │      │ markets()                                        │
   │      ▼                                                  │
   │  core Router：估值 → 進出場閘門 → 配置器 → 跨鏈 planner（磨損規則）│
   │      │ enter/exit/rebalance          │ 跨鏈搬運           │
   │      ▼                               ▼                  │
   │  CanaryExecutor → LoopExecutor   LiveBridgeExecutor（CCTP V2、│
   │                                  USDT0、同鏈 swap）        │
   │  RewardKeeper（Merkl／原生獎勵領取、賣出）                    │
   └─────────────────────────────────────────────────────────┘
   每一筆寫入：建交易 → 鏈上模擬（eth_call / simulateTransaction）→ gas 上限 →
   （shadow 到此為止）→ 簽名廣播 → 等收據。
```

三種模式：

shadow 模式可以**完全不放金鑰**：只要 `EVM_ADDRESS`／`SUI_ADDRESS`，所有交易都從這個地址模擬。建議 staging 機器先這樣跑。

| 模式 | 會不會動錢 | 用途 |
|---|---|---|
| `shadow` | **不會**。每筆交易都用真實錢包在鏈上模擬，成功就照 paper 方式記帳 | 驗證交易路徑、獎勵資格、數字 |
| `live` + canary | 會，但每個部位、總部署都有硬上限（預設 $2k／$10k） | 小額實盤驗證 |
| `live` | 會 | 正式運行 |

`live` 要同時滿足以下條件才會廣播：
1. 設定檔裡寫 `mode: live`。
2. 環境變數 `LIVE_CONFIRM=yes`。
3. 7 天內跑過 `verify`，而且設定沒有改過（config hash 相同）。
4. `verify` 零問題。

---

## 1. 準備機器

- 一台專用的 Linux 主機（VPS 即可），不要和日常使用的電腦混用。
- Node.js 22 以上（Pyth 的 Sui 套件建議 24）。
- 取得程式並自我檢查：

```bash
git clone https://github.com/Servalserval/professor-liao-class-with-ppt.git incentive-router
cd incentive-router
npm ci
npm run typecheck
npm test
```

- 時鐘要準（`timedatectl` 確認有 NTP），stamp 的時效與資料過期判定都靠它。

## 2. 金鑰與錢包

- **專用熱錢包**：EVM 一把、Sui 一把，只放要部署的資金加上 gas。冷錢包不要接這台機器。
- 金鑰放檔案，權限 600，用 `*_FILE` 環境變數指向它。程式會拒絕權限太寬的金鑰檔：

```bash
install -m 600 /dev/null /etc/incentive-router/evm.key   # 貼上 0x 開頭的私鑰
install -m 600 /dev/null /etc/incentive-router/sui.key   # 貼上 suiprivkey1... (bech32)
```

- 設定檔、log、Telegram 訊息都不會出現私鑰（程式用 `redact`）。
- 每條鏈準備少量 gas：ETH（Ethereum／Arbitrum／Base）、XPL（Plasma）、MON（Monad）、AVAX、SUI 等。

## 3. RPC

每條鏈用付費節點（Alchemy、QuickNode、dRPC、Ankr 等），把 URL 放在環境變數：

```
RPC_ETHEREUM=…  RPC_ARBITRUM=…  RPC_BASE=…  RPC_PLASMA=…  RPC_MANTLE=…  (RPC_MONAD、RPC_AVALANCHE 視需要)
SUI_GRPC=…      SUI_JSONRPC=…
EVM_ADDRESS=…   SUI_ADDRESS=…        # shadow 可以只給地址、不給金鑰
PYTH_HERMES_URL=… PYTH_API_KEY=…     # Suilend／Scallop 在交易內推價格時需要
```

完整範本在 `deploy/env.example`。

公開 RPC 會限流，也可能回傳錯誤資料，不能拿來寫入。程式在每次寫入前都會用 `assertChainId` 確認 RPC 的 chain id。

## 4. 設定檔

```bash
cp config/live.example.yaml config/live.yaml
```

- `assets`：每條鏈每個代幣的地址和 decimals。**從官方文件或區塊瀏覽器複製，不要憑記憶打**。`verify` 會到鏈上讀回 symbol／decimals 比對。
- `lending`：要開的市場和組合。先只放 [lending-landscape.md](lending-landscape.md) 第 5 節的第一批。
- `bridges`／`config/default.yaml` 的 `xchain.routes`：要開的跨鏈路由與費用上限。
- `canary`：上線初期的硬上限。
- 改任何一個值都會改變 config hash，必須重新 `verify` 才能 live。

## 5. 第一步：verify

```bash
set -a; . /etc/incentive-router/env; set +a
npm run live -- verify --config config/live.yaml
```

它會做這些事：
- 確認 chain id。
- 確認每個協議合約有程式碼，而且彼此關係正確（例如 provider.getPool() == pool）。
- 確認每個代幣是該市場的 reserve，decimals 一致。
- 確認橋合約、domain／eid 正確，swap router 在白名單裡。
- 確認錢包地址和金鑰對得上。

有任何問題就印出來、以非零結束，並寫下 stamp（含問題清單）。**問題清單不是空的就不能 live。**

## 6. 第二步：看數字

```bash
npm run live -- markets --config config/live.yaml --why   # 每個市場的即時淨 APR、能不能進、原因
npm run live -- balances --config config/live.yaml        # 錢包各鏈各幣餘額（router 的閒置資金桶）
npm run live -- plan --config config/live.yaml --why      # 這一刻 router 會怎麼分配、要不要跨鏈搬錢
```

拿 `markets` 的數字和 Aavescan、Merkl 頁面對照。差距大就先查原因，不要往下走。

## 7. 第三步：shadow（建議 3–7 天）

```yaml
mode: shadow
```

```bash
npm run live -- run --config config/live.yaml
```

每一筆進場、出場、去槓桿、領獎、跨鏈搬運都會建好交易、在鏈上模擬，但不廣播。
- 模擬成功：照 paper 方式記帳。
- 模擬失敗：告警，該動作視為失敗。

要確認的事：
- journal（`state/shadow/journal.jsonl`）裡沒有反覆失敗的模擬。
- Telegram 能收到告警，`/status` 有回應。
- 獎勵讀數和網頁一致。特別要確認 Suilend 穩定幣對 obligation 的獎勵資格，以及 Merkl 活動類型。
- 跨鏈規劃的成本估計合理，沒有出現「搬運成本 > 一天收益」卻被執行的情況（程式會擋，這裡是再確認一次）。

## 8. 第四步：canary 實盤（1–2 週）

```yaml
mode: live
state_dir: state/live      # 一定要換新的目錄：shadow 的 paper 部位和轉帳不能混進實盤帳本
canary: { max_position_usd: 2000, max_total_deployed_usd: 10000 }
```

同一個 `state_dir` 只能用一種模式（目錄裡的 `mode.json` 會記錄），混用時 runner 會拒絕啟動。
**錢包必須是 bot 專用的**：live 模式每 10 輪會比對鏈上部位，設定裡的市場若有 router 不知道的部位，會自動接手管理並發 critical 告警。

```bash
npm run live -- verify --config config/live.yaml
LIVE_CONFIRM=yes npm run live -- run --config config/live.yaml
```

至少完成一次完整來回：
1. 進場。
2. 隔天看到 `markToMarket` 的淨值變化合理。
3. 領獎（Merkl 約每 2 小時更新）。
4. 用 Telegram `/exit <oppId>` 手動出場，確認資金回到錢包。
5. 跨鏈搬一次小額（例如 $1–2k 走 CCTP Standard），確認到帳後會自動進場。

## 9. 第五步：放大

逐步調高 canary：$2k → $25k → $100k → 依 landscape 第 5 節的上限（總額約 $300k）。
- 每次調整都要重新 `verify`。
- 每一級至少觀察 2–3 天。
- 把 `config/default.yaml` 的 `caps`、`xchain` 調到最終值之前，先用 `plan` 看分配結果。

---

## 10. 日常操作

### Telegram 指令

設定 `TG_BOT_TOKEN`、`TG_CHAT_ID`。只接受該 chat 的指令。

| 指令 | 作用 |
|---|---|
| `/status` | 狀態、閒置資金、各部位 |
| `/pause` | 停止新進場（出場照常） |
| `/resume` | 恢復，並重置回撤熔斷的觀察窗 |
| `/exit <oppId>` | 下一輪出場該部位，失敗會重試到成功 |
| `/exitall` | 全部出場並暫停 |
| `/transfer <id> arrived\|failed\|refunded [usd]` | 人工結案一筆卡住的跨鏈轉帳（同時重置熔斷觀察窗） |

沒有 Telegram 時，同樣的指令可以用 `npm run live -- cmd "/status"` 下。

### 告警等級

- `critical`：熔斷觸發、出場失敗、橋卡住、在途資金失敗。**要人處理。**
- `warn`：資料源失敗、價格過期、模擬失敗、獎勵領取失敗。
- `info`：進出場、搬運完成。

### 領獎

`RewardKeeper` 每 `rewards.keeper.interval_hours` 小時跑一次（Merkl 約每 2 小時更新）。它負責：
- 領 Merkl 與各協議原生獎勵。
- 把 `rewards.sell` 列出的獎勵幣換成該鏈的 `cash_asset`。

Ethena Liquid Leverage 發的 aUSDe 本身就是抵押品，不會被賣掉。要立刻跑一次：`npm run live -- rewards`。

### live gate 關閉時

stamp 過期時，bot 會自動切到「只出不進」：
- 停止新進場和新的跨鏈搬運。
- 出場、去槓桿、脫鉤出場、熔斷照常運作。
- 每一輪都重新檢查 gate，`/resume` 繞不過去。
- 重新 `verify`（設定不變）後自動恢復。

設定改了、verify 有問題、或沒設 `LIVE_CONFIRM=yes`，runner 都會拒絕以 live 啟動。

### 例行檢查（每天）

1. `/status`。
2. `npm run live -- status`：看在途轉帳、過去 24 小時的跨鏈磨損合計。
3. 確認 gas 餘額。
4. stamp 7 天到期前重新 `verify`。過期時 bot 會自動暫停新進場。

---

## 11. 緊急處理

| 狀況 | 動作 |
|---|---|
| 協議被駭、暫停、凍結 | `/exitall`。若協議已暫停，出場會一直重試；同時到協議 Discord 或治理論壇確認狀況 |
| USDe 或其他穩定幣脫鉤 | bot 在 0.3% 告警、1% 自動出場；換匯滑價大時分段出場，必要時 `/pause` 後人工判斷 |
| 鏈停擺（例如 Sui 2026-05 的 6.7 小時） | bot 會因為資料過期而不進場；恢復後檢查健康度 |
| 跨鏈轉帳卡住 | bot 不會自動重送。確認結果後用 `/transfer <id> arrived|failed|refunded [usd]` 結案。拿 `status` 裡的 tx hash 到區塊瀏覽器查。CCTP 可查 Iris `/v2/messages/{domain}?transactionHash=`，必要時用 `/v2/reattest/{nonce}`；LayerZero 用 layerzeroscan |
| 價格 API（DefiLlama）失聯 | 價格過期即拒絕進場；部位改用協議價格，並告警 |
| 金鑰疑似外洩 | 立刻 `/exitall` → 把錢轉到新錢包 → 換金鑰 → 重新 verify |

---

## 12. 用 systemd 常駐

範本在 `deploy/incentive-router.service`、`deploy/env.example`：

```bash
sudo useradd -r -m -d /opt/incentive-router incentive
sudo cp -r . /opt/incentive-router/app && sudo chown -R incentive: /opt/incentive-router
sudo install -m 600 -o incentive deploy/env.example /etc/incentive-router/env   # 填入 RPC、金鑰檔路徑、TG
sudo cp deploy/incentive-router.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now incentive-router
journalctl -u incentive-router -f
```

`LIVE_CONFIRM=yes` 只在要 live 時寫進 env 檔。拿掉它再重啟，就回到不能廣播的狀態。

## 13. 升級

1. `git pull` 後跑 `npm ci && npm run typecheck && npm test`。
2. 先用 shadow 跑一輪。
3. 重新 `verify`。
4. 再切回 live。
