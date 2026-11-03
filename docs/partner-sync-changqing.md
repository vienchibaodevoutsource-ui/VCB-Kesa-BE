# KESA → 長青 履歷同步規格

KESA 使用者在履歷頁按下「推送到 長青」、選擇 長青 的**面試專案**並補填 KESA 沒有的欄位後，KESA 以 HTTP POST 將該筆履歷推送到 長青 Apps Script 的 Web App（`/exec`），由 `doPost(e)` 接收並寫入 長青 系統。

- 只推送使用者手動按下推送的「已完成」履歷（草稿不推送），儲存履歷時**不會**自動推送。
- 只推送新增 / 更新，**不推送刪除**。
- 每次推送都是**整筆履歷**（不是差異），長青 端以 `externalId` upsert 即可。同一筆履歷再次推送 = 更新同一位勞工。
- 第一次推送前，KESA 會讀取 長青 試算表（唯讀），以「英文姓名 + 出生日期」或「英文姓名 + 電話」比對 長青 既有的 KESA 勞工。若有符合，使用者必須選擇「更新既有勞工」（payload 帶 `worker.workerId`）或「新增」。

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
  "questionSetId": "default",
  "answers": { "spouseLocation": "...", "overtimeAccepted": "是", "...": "..." },
  "raw":    { ... KESA 原始資料（越南文），見第 3 節 ... }
}
```

| 欄位 | 說明 |
|---|---|
| `event` | 目前固定為 `candidate.upserted` |
| `sentAt` | 推送時間（ISO 8601, UTC） |
| `version` | 推送時間（與 `sentAt` 相同）。**若收到的 version 比已儲存的舊，請忽略**（避免兩次推送先後順序錯亂） |
| `accessCode` | KESA 在 長青 系統的存取碼，可用來判斷所屬仲介（`Interview_Applications` 第 4 欄 仲介公司名稱） |
| `application.projectCode` | 使用者選擇的面試專案代碼（`Project_Settings` A 欄，KESA 只列出 仲介代碼 = KESA 且狀態 `啟用` 的專案）。請以此新增 / 更新 `Interview_Applications` 一列（專案代碼 + workerId） |
| `application.introducer` | 介紹人（`Interview_Applications` 第 5 欄） |
| `worker.externalId` | KESA 履歷的唯一 ID（永不改變）。**請以此作為 upsert 的鍵** |
| `questionSetId` | 本次面談回答所依據的題組（`Project_Settings` I 欄，空白為 `default`） |
| `answers` | 面談回答，key 為 `Interview_Questions` 的 **questionId**（B 欄），只包含有回答的題目。是非題為 `是` / `否`，數字題為數字字串，其餘為越南文。**請優先以此寫入面談紀錄**：題目文字修改後 questionId 不變，回答仍可對應 |

## 2. `worker`：已對應 長青 表單欄位

欄位名稱與值已依 長青「履歷表單」的格式轉換（例如性別為 `男/女`、日期為 `yyyy-mm-dd`）。無資料時為空字串。

| 欄位 | 長青 表單 | 範例 / 說明 |
|---|---|---|
| `externalId` | — | KESA 履歷 ID（upsert 鍵） |
| `externalCode` | — | KESA 履歷編號，例如 `KS001` |
| `workerId` | 勞工編號 | **僅在對應到 長青 既有勞工時才帶**。請更新該勞工（不要新增），並在 `KesaSync` 記錄 `externalId` ↔ `workerId`。未帶此欄 = 新勞工 |
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
| `education` | 學歷 | 陣列，格式同 `educationJson`：`[{"degree":"高中","start":"","end":"","major":"","majorZh":"","status":"畢"}]`；KESA 無起迄年 |
| `docStatus` | 護照 / 良民證 / 體檢狀態 | 格式同 `docStatusJson`：`{"passport":"辦理中","police":"無","medical":"有"}`；不確定的項目不帶 key |
| `headshotUrl` | 大頭照 | 圖片公開網址（Cloudinary），請用 `UrlFetchApp` 下載。非 base64 |
| `fullbodyUrl` | 全身照 | 同上 |
| `interview` | 面談 | 與 `answers` 相同內容，但 key 為推送當下的題目文字（同 Excel 範本 `面談_` 後面的文字），供相容舊流程使用 |

`religion`、`visionLeft` / `visionRight`、`chineseLevel` 預設由 KESA 表單轉換，使用者可在推送時改寫成 長青 的格式。

面談題目：KESA 每次推送時即時讀取該專案題組中 `active = Y` 的題目（依 `sortOrder`）。KESA 表單有的資料會自動帶入，其餘題目由使用者填寫。貴司新增、修改（題目文字、題型或 `updatedAt`）或停用題目後，已推送過的履歷會在 KESA 顯示「題目已變更、需補填」，使用者補填後再次推送。**修改題目時請更新 `updatedAt`，並請勿重複使用已停用題目的 questionId。**

## 3. `raw`：KESA 原始資料

包含 KESA 履歷的完整欄位（越南文原值），供 `worker` 未涵蓋的需求使用，例如：

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
```

- `success: false`、HTTP 錯誤、逾時（60 秒）或回傳非 JSON（例如 Apps Script 執行錯誤頁面），KESA 都視為失敗，並把 `error` 顯示給使用者。KESA 不自動重試，由使用者再按一次推送。
- 使用者可能重複推送同一筆，處理邏輯必須是**冪等**的（以 `externalId` upsert）。
- 請在 `workerId` 回傳 長青 端的勞工編號，KESA 會顯示在履歷頁。

## 5. `doPost` 範例

以下範例假設 長青 端已有 `doPost` 處理其他用途，因此將原本的函式改名為 `legacyDoPost_`，再依 body 是否帶有 `payload` + `signature` 分流。`upsertWorkerFromKesa_` 需要由 長青 依現有的寫入邏輯（例如 `processFormSubmission` 的內部實作）完成。

```javascript
// 指令碼屬性：KESA_SYNC_SECRET = KESA 另行提供的共用密鑰
// 工作表 KesaSync：A 欄 externalId、B 欄 workerId、C 欄 version
var KESA_SYNC_SHEET = 'KesaSync';

function doPost(e) {
  var body = null;
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (body && body.payload && body.signature) return handleKesaSync_(body);
  return legacyDoPost_(e); // 原本的 doPost 改名為 legacyDoPost_
}

function handleKesaSync_(body) {
  var secret = PropertiesService.getScriptProperties().getProperty('KESA_SYNC_SECRET');
  if (!secret || !verifyKesaSignature_(body.payload, body.signature, secret)) {
    return kesaJson_({ success: false, error: 'invalid signature' });
  }

  var msg = JSON.parse(body.payload);
  if (msg.event !== 'candidate.upserted') return kesaJson_({ success: true, ignored: true });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(KESA_SYNC_SHEET);
    var rows = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === msg.worker.externalId) { rowIndex = i; break; }
    }

    // 尚未同步過但 KESA 已對應到既有勞工時，worker.workerId 會有值
    var existingWorkerId = rowIndex > 0 ? rows[rowIndex][1] : (msg.worker.workerId || '');
    // 試算表會把 ISO 字串自動轉成日期，因此以時間戳比較
    var storedVersion = rowIndex > 0 && rows[rowIndex][2] ? new Date(rows[rowIndex][2]).getTime() : 0;
    if (storedVersion && storedVersion >= new Date(msg.version).getTime()) {
      return kesaJson_({ success: true, workerId: existingWorkerId, skipped: 'stale' });
    }

    // TODO(長青)：依 existingWorkerId 決定新增或更新 Worker_Profiles，
    // 並以 msg.application.projectCode + workerId 新增 / 更新 Interview_Applications，回傳 長青 端的 workerId
    var workerId = upsertWorkerFromKesa_(existingWorkerId, msg.worker, msg.application, msg.raw, msg.accessCode);

    if (rowIndex > 0) {
      sheet.getRange(rowIndex + 1, 2, 1, 2).setValues([[workerId, msg.version]]);
    } else {
      sheet.appendRow([msg.worker.externalId, workerId, msg.version]);
    }
    return kesaJson_({ success: true, workerId: workerId });
  } catch (err) {
    return kesaJson_({ success: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function verifyKesaSignature_(payload, signature, secret) {
  var bytes = Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8);
  var hex = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  return hex === String(signature).toLowerCase();
}

function kesaJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
```

注意事項：

- 修改後請以**同一個部署**「管理部署作業 → 編輯 → 新版本」發布，`/exec` 網址才不會改變。若網址改變，請通知 KESA。
- Web App 的存取權必須是「任何人」，KESA 伺服器才能在未登入 Google 的情況下呼叫。安全性由簽章驗證確保。
- 單次執行上限約 6 分鐘，一般一筆履歷遠低於此。

## 6. 上線步驟

1. KESA 以安全管道將共用密鑰交給 長青。
2. 長青 建立工作表 `KesaSync`（第 1 列為標題：externalId、workerId、version），設定指令碼屬性 `KESA_SYNC_SECRET`，實作 `upsertWorkerFromKesa_` 並部署為網頁應用程式。
3. 長青 將 `/exec` 網址提供給 KESA。KESA 推送一筆測試履歷到啟用中的專案，雙方確認資料正確。
4. 只推送使用者手動推送的履歷；除非使用者選擇「更新既有勞工」（帶 `worker.workerId`），長青 既有的 KESA 勞工資料不受影響。
