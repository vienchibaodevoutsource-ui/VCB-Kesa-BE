# KESA → 長青 履歷同步規格

KESA 使用者在履歷頁按下「推送到 長青」、選擇 長青 的**面試專案**並補填 KESA 沒有的欄位後，KESA 以 HTTP POST 將該筆履歷推送到 長青 Apps Script 的 Web App（`/exec`），由 `doPost(e)` 接收並寫入 長青 系統。

- 只推送使用者手動按下推送的「已完成」履歷（草稿不推送），儲存履歷時**不會**自動推送。
- 只推送新增 / 更新，**不推送刪除**。
- 每次推送都是**整筆履歷**（不是差異），長青 端以 `externalId` upsert 即可。同一筆履歷再次推送 = 更新同一位勞工。
- 第一次推送前，KESA 呼叫 長青 的查詢 API（見第 0 節，**不開放試算表權限**），以「英文姓名 + 出生日期」或「英文姓名 + 電話」比對 長青 既有的 KESA 勞工。若有符合，使用者必須選擇「更新既有勞工」（payload 帶 `worker.workerId`）或「新增」。
- **空白欄位 = 保留 長青 原值**。長青 人工補登或翻譯過的資料不會被 KESA 的空字串清掉；目前不支援由 KESA 清除欄位。

## 0. 查詢 API（推送前使用）

與推送同一個 `/exec` 網址，以 KESA 的存取碼驗證，只會回傳 KESA 自己的專案與勞工。

```
POST /exec   { "action": "list_projects", "accessCode": "<KESA 存取碼>" }
→ { "success": true, "projects": [{ "code", "name", "label", "status" }] }
```

只列出 `status === "啟用"` 的專案給使用者選（回應也會包含 `已完成` 的專案）。

```
POST /exec   { "action": "export_workers", "accessCode": "<KESA 存取碼>", "includePhotos": false }
→ { "success": true, "workers": [{ "workerId", "englishName", "chineseName", "nationality", "birthDate", "phone", ... }] }
```

`birthDate` 為 `yyyy-mm-dd`。`worker.workerId` 只能帶這裡查到的編號；帶其他仲介或不存在的編號，推送會失敗。

## 1. 請求格式

```
POST https://script.google.com/macros/s/<部署 ID>/exec
Content-Type: application/json

{
  "payload":   "<JSON 字串>",
  "signature": "<HMAC-SHA256 十六進位小寫>"
}
```

- `signature = HMAC_SHA256(key = 共用密鑰, message = payload 字串, UTF-8)`，以十六進位小寫表示。
- Apps Script 無法讀取 HTTP header，因此簽章放在 body 中。
- **共用密鑰會由 KESA 另外以安全管道提供，不會寫在本文件中。** 請存放於 Apps Script 的「指令碼屬性」`KESA_SYNC_SECRET`，不要寫死在程式碼裡。

`payload` 解析後的結構：

```json
{
  "event": "candidate.upserted",
  "sentAt": "2026-11-02T03:00:05.123Z",
  "version": "2026-11-02T03:00:00.000Z",
  "accessCode": "<KESA 在 長青 系統的存取碼>",
  "application": { "projectCode": "20261104_永勝光學新工50人", "introducer": "..." },
  "worker": { ... 已轉換為 長青 表單欄位，見第 2 節 ... },
  "raw":    { ... KESA 原始資料（越南文），見第 3 節 ... }
}
```

| 欄位 | 說明 |
|---|---|
| `event` | 目前固定為 `candidate.upserted` |
| `sentAt` | 推送時間（ISO 8601, UTC） |
| `version` | 推送時間（與 `sentAt` 相同，ISO 8601）。同一個 `externalId` 必須遞增；**收到的 version 小於或等於已儲存的，長青 會略過並回傳 `skipped: "stale"`** |
| `accessCode` | KESA 在 長青 系統的存取碼。長青 以此判斷所屬仲介（`Interview_Applications` 第 4 欄 仲介公司名稱）；管理員存取碼會被拒絕 |
| `application.projectCode` | 使用者選擇的面試專案代碼（`Project_Settings` A 欄，KESA 只列出 仲介代碼 = KESA 且狀態 `啟用` 的專案）。長青 會再檢查一次專案存在、狀態 `啟用`、仲介代碼 = KESA，不符就回傳錯誤。以此新增 / 更新 `Interview_Applications` 一列（專案代碼 + workerId）；面試編號、錄取狀態、順序、評語由 長青 管理，推送不會改動 |
| `application.introducer` | 介紹人（`Interview_Applications` 第 5 欄） |
| `worker.externalId` | KESA 履歷的唯一 ID（永不改變，**整個 KESA 系統內唯一**）。長青 以此作為 upsert 的鍵 |

## 2. `worker`：已對應 長青 表單欄位

欄位名稱與值已依 長青「履歷表單」的格式轉換（例如性別為 `男/女`、日期為 `yyyy-mm-dd`）。無資料時為空字串。

| 欄位 | 長青 表單 | 範例 / 說明 |
|---|---|---|
| `externalId` | — | KESA 履歷 ID（upsert 鍵） |
| `externalCode` | — | KESA 履歷編號，例如 `KS001` |
| `workerId` | 勞工編號 | **僅在對應到 長青 既有勞工時才帶**（必須是第 0 節查到的編號）。長青 會更新該勞工並在 `KesaSync` 記錄 `externalId` ↔ `workerId`；之後同一個 `externalId` 一律寫到綁定的勞工，此欄會被忽略。未帶此欄時，長青 仍會用「英文姓名 + 出生日期 + 國籍 + 仲介」比對，相同就更新該勞工，避免重複建檔 |
| `englishName` | 英文姓名 | 越南姓名去除聲調後大寫，`NGUYEN THI DAO` |
| `chineseName` | 中文姓名 | `阮氏桃` |
| `nativeName` | 母語姓名 | `Nguyễn Thị Đào` |
| `nationality` | 國籍 | 固定 `VN` |
| `gender` | 性別 | `男` / `女` |
| `birthDate` | 出生日期 | `1998-03-05` |
| `height` / `weight` | 身高 / 體重 | 數字（cm / kg） |
| `religion` | 宗教 | `佛教` / `天主教` / `基督教` / `伊斯蘭教` / `其他`；無宗教為空字串 |
| `phone` | 聯絡電話 | |
| `address` | 聯絡地址 | 越南文 |
| `hand` | 慣用手 | `右手` / `左手` |
| `handSweat` | 手汗 | `有` / `無` |
| `surgery` | 開刀 | `無`，或 `有，<部位/說明>`（全形逗號） |
| `colorBlind` | 色盲 | `有` / `無` |
| `visionLeft` / `visionRight` | 視力左 / 右 | 例如 `10/10` |
| `tattoo` | 刺青 | `有` / `無` |
| `smoke` / `drink` | 抽菸 / 喝酒 | `有` / `無` |
| `history` | 病史 | 越南文說明；有病史但無說明時為 `有`；無則為空 |
| `marital` | 婚姻狀況 | `未婚` / `已婚` / `離婚` / `喪偶` |
| `fatherName` / `fatherAge` / `fatherJob` | 父親 | 職業為越南文 |
| `motherName` / `motherAge` / `motherJob` | 母親 | 職業為越南文 |
| `fatherAlive` / `motherAlive` | 父親 / 母親 存歿 | `存` / `歿`；未填則不帶此欄 |
| `birthPlace` | 出生地 | 使用者補填；未填則不帶此欄 |
| `diet` | 飲食習慣 | `葷` / `葷(不吃豬)` / `素`；使用者補填 |
| `englishLevel` | 英文能力 | `完全不會` / `英文字母合格` / `簡單會話` / `流暢`；使用者補填 |
| `passportNo` | 護照號碼 | 使用者補填 |
| `passportExp` / `medExp` / `policeExp` | 護照 / 體檢 / 良民證期限 | `yyyy-mm-dd`；使用者補填 |
| `rank` | 家中排行 | `<排行>/<兄弟姊妹總數>`，例如 `2/3` |
| `children` | 子女狀況 | 例如 `兒子2人（5、3歲），女兒1人（1歲）`；未婚或無子女為 `無` |
| `taiwanContact` | 在台有無親友 | `無`，或 `有，<說明>`（越南文） |
| `specialty` | 特殊專長 | 越南文，多項以 `；` 分隔 |
| `chineseLevel` | 中文能力 | `略懂` / `完全不會` |
| `otherLanguage` | 其他語言 | 例如 `台語 略懂` |
| `education` | 學歷 | 陣列，格式同 `educationJson`：`[{"degree":"高中","start":"","end":"","major":"","majorZh":"","status":"畢"}]`；KESA 無起迄年。長青 已有的筆數較多時保留 長青 的 |
| `docStatus` | 護照 / 良民證 / 體檢狀態 | 格式同 `docStatusJson`：`{"passport":"辦理中","police":"無","medical":"有"}`；不確定的項目不帶 key |
| `headshotUrl` | 大頭照 | 圖片公開網址（Cloudinary），非 base64。限 `https://res.cloudinary.com`（其他網域需先通知 長青 加入白名單）、`image/*`、單張 10MB 以內、不跟隨轉址。網址與上次推送相同時不會重新下載。下載失敗整筆推送失敗 |
| `fullbodyUrl` | 全身照 | 同上 |
| `interview` | 面談 | 物件，key 為 長青 題目文字（同 Excel 範本 `面談_` 後面的文字），值為越南文回答；是非題為 `是` / `否`。無回答的題目不帶 key。`是否抽水菸`、`是否有無塵衣經驗`、`之前工作是否辛苦`、`親戚朋友在台灣做什麼` 由使用者補填 |

`religion`、`visionLeft` / `visionRight`、`chineseLevel` 預設由 KESA 表單轉換，使用者可在推送時改寫成 長青 的格式。

`docStatus` 只合併有帶的 key；`interview` 的 key 必須與該專案題組的中文題目完全相同，對不上的題目會被略過。

## 3. `raw`：KESA 原始資料

包含 KESA 履歷的完整欄位（越南文原值）。**長青 目前不讀取也不儲存 `raw`**（含大量個資且沒有固定格式）；需要其中的資料（例如 `workExperience`）時，請另外提供轉換成 長青 `experienceJson` 格式的 `worker` 欄位。目前內容例如：

- `education`、`workExperience`、`domesticExperience`、`overseasExperience`
- `passport`、`criminalRecord`、`healthCheck`、`cccd`（越南身分證號）
- `languages`、`limbImages`、`scarImages`、`tattooImages`（圖片網址陣列）
- `broker` / `factory`：`{ id, slug, name, chineseName }`
- `familyMembers`：`[{ name, relationship, age, occupation }]`
- `formType`、`formData`：KESA 表單的完整資料（已移除 base64 圖片）

欄位可能隨 KESA 系統更新而**增加**，請忽略不認識的欄位；既有欄位不會在未通知的情況下移除或改名。

## 4. 回應格式

`doPost` 請回傳 JSON（`ContentService` + `MimeType.JSON`）：

```json
{ "success": true, "workerId": "<長青 端的 worker ID>" }
{ "success": true, "workerId": "...", "skipped": "stale" }   // version 不比已儲存的新，未寫入
{ "success": false, "error": "<原因>" }
```

- `success: false`、HTTP 錯誤、逾時（60 秒）或回傳非 JSON（例如 Apps Script 執行錯誤頁面），KESA 都視為失敗，並把 `error` 顯示給使用者。KESA 不自動重試，由使用者再按一次推送。
- 使用者可能重複推送同一筆，處理邏輯必須是**冪等**的（以 `externalId` upsert）。
- 請在 `workerId` 回傳 長青 端的勞工編號，KESA 會顯示在履歷頁。

## 5. 長青 端實作（已完成）

長青 已在既有的 `doPost` 開頭加入分流：body 帶 `payload` + `signature` 時交給 `GS_28_KesaSync.gs` 處理，其他 action 不受影響，不需要另外的部署網址。處理順序：

1. 驗證 HMAC（指令碼屬性 `KESA_SYNC_SECRET`）。
2. 以 `accessCode` 判斷仲介，檢查專案。
3. 依 `KesaSync` 判斷 version 是否較新；照片在鎖外下載存到 Google Drive。
4. 加鎖寫入：人員主檔（空白保留原值）、報名列、證件狀態、面談答案、`KesaSync`。

Web App 存取權為「任何人」，安全性由簽章驗證確保。單次執行上限約 6 分鐘，一般一筆履歷遠低於此。

## 6. 上線步驟

1. KESA 以安全管道將共用密鑰交給 長青；長青 設定指令碼屬性 `KESA_SYNC_SECRET`（照片網域若不只 `res.cloudinary.com`，另設 `KESA_PHOTO_HOSTS`，逗號分隔）。
2. 長青 以**同一個部署**「管理部署作業 → 編輯 → 新版本」發布，`/exec` 網址不變。`KesaSync` 工作表會在第一次推送時自動建立。
3. KESA 推送一筆測試履歷到啟用中的專案，雙方確認資料正確。建議測試：新增、重複推送、修改後再推、綁定既有勞工、帶錯誤的 `workerId`、停用專案、錯誤簽章、照片網址失效。
4. 只推送使用者手動推送的履歷；除非使用者選擇「更新既有勞工」（帶 `worker.workerId`），長青 既有的 KESA 勞工資料不受影響。
