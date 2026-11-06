# Accessibility Tools Pro

**Claude x William77**

以純 JavaScript 撰寫的網頁無障礙工具列（不需任何框架或套件），包含文字與色彩調整、閱讀輔助、鍵盤語音導覽、各種檢測工具與網頁截圖。
本資料夾同時附上一個示範用的一頁式電商網站「森日選物」。

---

## 在新的空專案中使用

### 需要的檔案

| 檔案 | 必要性 | 說明 |
|---|---|---|
| `at-pro.js` | **必要** | 工具列本體。所有介面（面板、按鈕、樣式）都由這支檔案產生，不需要另外的 CSS 或圖片。 |
| `h2c.js` | 選用（使用截圖功能時需要） | HTML → Canvas 截圖函式庫。由 `at-pro.js` 在按下「部分截圖／整頁截圖」時**自動從同一個資料夾載入**，不需要另外寫 `<script>`。 |

> `index.html`、`style.css`、`app.js` 是示範電商網站的檔案，**新專案不需要**。

### 最小安裝步驟

1. 把 `at-pro.js` 和 `h2c.js` 複製到專案的**同一個資料夾**，例如：

   ```
   my-project/
   ├── index.html
   └── js/
       ├── at-pro.js
       └── h2c.js
   ```

2. 在 HTML 的 `</body>` 前加入一行：

   ```html
   <script src="js/at-pro.js" defer></script>
   ```

3. 用網頁伺服器開啟頁面（見下方〈注意事項〉），左下角會出現無障礙圓形按鈕，點擊即可展開工具面板。

### 選用設定

在載入 `at-pro.js` **之前**宣告 `window.ATProConfig`：

```html
<script>
  window.ATProConfig = {
    speechLang: 'zh-TW',  // 語音導覽語言，預設 zh-TW
    openOnLoad: false     // 載入頁面時是否自動展開面板，預設 false
  };
</script>
<script src="js/at-pro.js" defer></script>
```

### 更新檔案後避免瀏覽器快取

Safari 等瀏覽器可能沿用舊檔。更新 `at-pro.js` 後，可在網址加上版本參數：

```html
<script src="js/at-pro.js?v=1.5.3" defer></script>
```

`at-pro.js` 載入 `h2c.js` 時會自動加上版本參數，並檢查版本是否符合（目前需要 h2c **1.2.3** 以上）。

---

## 功能一覽

| 分區 | 工具 |
|---|---|
| 顯示調整 | 文字放大、行高、字元間距、單字間距（皆分 3 段）、顏色相反、亮度、對比、灰階、飽和度 |
| 閱讀輔助 | 隱藏圖片、閱讀指引、閱讀面罩、強調連結、大白滑鼠、大黑滑鼠 |
| 語音與標示 | 鍵盤語音導覽、顯示 HTML 標籤名、備註、清除所有備註 |
| 檢測工具 | 用色查核、元素量測、圖層提示、文字樹、圖片檢閱、無障礙檢測、CSS 用色檢查、z-index 檢查 |
| 擷取與畫面 | 部分截圖、整頁截圖、繪圖板（整頁）、全螢幕 |

### 快捷鍵

| 按鍵 | 功能 |
|---|---|
| `Shift` + `Z` / `A` | 鍵盤語音導覽：下一段／上一段文字（需先開啟「鍵盤語音導覽」） |
| `Shift` + `1`～`6` | 跳到下一個 H1～H6 標題（需先開啟「鍵盤語音導覽」） |
| `Shift` + `X` | 開啟／關閉備註（開啟後在頁面任一處點兩下新增備註） |
| `Esc` | 依序關閉：截圖選取 → 繪圖板 → 右側資訊面板 → 頁面標示 → 工具面板 |

---

## JavaScript API

### `window.ATPro`

```js
ATPro.open();          // 展開工具面板
ATPro.close();         // 收合工具面板
ATPro.toggle();        // 切換面板
ATPro.reset();         // 恢復所有預設設定
ATPro.audit();         // 執行無障礙檢測，回傳檢查結果陣列
ATPro.getSettings();   // 取得目前的設定
ATPro.notes();         // 取得本頁所有備註
ATPro.clearNotes();    // 清除本頁所有備註（不會跳出確認視窗）
```

### `window.h2c`（可獨立使用）

`h2c.js` 也可以單獨引入，當作一般的 HTML 截圖函式庫：

```html
<script src="js/h2c.js"></script>
<script>
  // 回傳 <canvas>
  const canvas = await h2c();                                  // 目前可視區
  const page   = await h2c(document, { mode: 'page' });        // 整頁
  const card   = await h2c(document.querySelector('.card'));   // 單一元素
  const part   = await h2c(document, { region: { x: 0, y: 0, width: 800, height: 600 } }); // 指定範圍（文件座標）

  // 直接輸出
  const blob = await h2c.toBlob(document, { mode: 'page' });
  const url  = await h2c.toDataURL(document);
  await h2c.download(document, 'screenshot.png', { mode: 'page' });
</script>
```

| 選項 | 預設值 | 說明 |
|---|---|---|
| `mode` | `'viewport'` | `'viewport'`（可視區）或 `'page'`（整頁） |
| `region` | — | `{ x, y, width, height }` 指定範圍，優先於 `mode` |
| `scale` | `max(2, devicePixelRatio)` | 輸出倍率，超過瀏覽器 canvas 上限時自動降低 |
| `backgroundColor` | 頁面背景色 | 傳 `null` 為透明背景 |
| `ignore` | — | `(el) => boolean`，回傳 `true` 的元素不繪製；也可在元素加上 `data-h2c-ignore` 屬性 |
| `imageTimeout` | `8000` | 單一圖片／字型的載入逾時（毫秒） |
| `fonts` | `true` | 是否內嵌網頁字型 |
| `scaleMethod` | 自動 | `'zoom'` 或 `'transform'`；支援 CSS `zoom` 的瀏覽器預設使用 `zoom` |

---

## 注意事項

- **請用網頁伺服器開啟**：直接以 `file://` 開啟時，瀏覽器會禁止讀取本機圖片與字型，截圖中的圖片會留白。可使用 VS Code 的 Live Server，或在專案資料夾執行：

  ```bash
  python3 -m http.server 8000
  ```

- **跨網域資源**：截圖時，未開放 CORS 的跨網域圖片／字型無法擷取，跨網域 iframe 會以灰色區塊代替。
- **Safari 截圖較慢**：Safari 需等待頁面內嵌圖片載入後才能完整繪製，每次截圖約多 1～1.5 秒。
- **語音導覽**：使用瀏覽器內建的 Web Speech API，可用的中文語音依作業系統而定。
- **資料儲存**：設定與備註存在瀏覽器的 `localStorage`，只在該瀏覽器有效：
  - `atpro-settings-v1`：工具設定
  - `atpro-notes:<網址>`：各頁面的備註
- **不影響頁面樣式**：工具列使用 Shadow DOM，介面樣式與頁面 CSS 互相隔離；調整類功能（文字放大、濾鏡等）才會作用在 `<body>` 上。

---

## 本資料夾的檔案

| 檔案 | 用途 |
|---|---|
| `at-pro.js` | Accessibility Tools Pro 工具列 |
| `h2c.js` | HTML → Canvas 截圖函式庫 |
| `index.html` | 示範電商網站頁面（已引入 `at-pro.js`） |
| `style.css` | 示範電商網站樣式（Indigo 主題） |
| `app.js` | 示範電商網站互動（商品、購物車、結帳） |
| `README.md` | 本說明文件 |

---

## 製作

**Claude x William77**
