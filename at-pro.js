/*!
 * Accessibility Tools Pro — at-pro.js
 * 純 JavaScript 無障礙工具列（UI 全部由本檔產生，使用 Shadow DOM 隔離樣式）
 *
 * 用法：
 *   <script src="at-pro.js" defer></script>
 *
 * 選用設定（需在載入本檔前宣告）：
 *   window.ATProConfig = {
 *     speechLang: 'zh-TW',                                  // 語音導覽語言
 *     openOnLoad: false                                     // 載入時自動展開面板
 *   };
 *
 * 公開 API：window.ATPro.open() / close() / toggle() / reset() / audit() / notes() / clearNotes()
 */
(function () {
  'use strict';
  if (window.ATPro) return;

  const CFG = Object.assign(
    { speechLang: 'zh-TW', openOnLoad: false },
    window.ATProConfig || {}
  );
  const STORE_KEY = 'atpro-settings-v1';
  const NOTES_KEY = 'atpro-notes';
  const Z = 2147483000;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 本檔的網址（用來從同目錄載入 h2c.js）；defer/async 載入時 currentScript 仍可取得
  const SCRIPT_SRC = (document.currentScript && document.currentScript.src)
    || (Array.from(document.scripts).map((s) => s.src).find((s) => /at-pro\.js(\?|#|$)/.test(s)) || '');

  /* ------------------------------------------------------------------ *
   * 工具函式
   * ------------------------------------------------------------------ */
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round = (n) => Math.round(n * 10) / 10;
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無法儲存時忽略 */ } },
  };
  const isEditable = (el) => !!el && el.nodeType === 1 && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const selectorOf = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };

  /* ---------- 色彩 / 對比 ---------- */
  function parseColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  function luminance({ r, g, b }) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrastRatio(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function effectiveBg(el) {
    const layers = [];
    let hasImage = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') hasImage = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return { color: base, hasImage };
  }
  function textContrast(el) {
    const cs = getComputedStyle(el);
    const { color: bg, hasImage } = effectiveBg(el);
    let fg = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    if (fg.a < 1) fg = blend(fg, bg);
    const ratio = contrastRatio(fg, bg);
    const size = parseFloat(cs.fontSize);
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    return { fg, bg, ratio, size, bold, large, hasImage, aa: ratio >= (large ? 3 : 4.5), aaa: ratio >= (large ? 4.5 : 7) };
  }

  /* ---------- 無障礙名稱 ---------- */
  function accName(el, { allowPlaceholder = true } = {}) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ').trim();
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const tag = el.tagName;
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) {
      return (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) {
      if (el.id) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && textOf(l)) return textOf(l);
      }
      const pl = el.closest('label');
      if (pl) {
        const c = pl.cloneNode(true);
        c.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
        const t = c.textContent.replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
      if (['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;
      return allowPlaceholder ? (el.getAttribute('placeholder') || '').trim() : '';
    }
    let t = textOf(el);
    if (!t) { const img = el.querySelector('img[alt]'); if (img) t = img.alt.trim(); }
    if (!t) { const st = el.querySelector('svg title'); if (st) t = st.textContent.trim(); }
    return t || (el.getAttribute('title') || '').trim();
  }

  /* ------------------------------------------------------------------ *
   * 設定
   * ------------------------------------------------------------------ */
  const CYCLES = {
    fontScale: { values: [1, 1.15, 1.3, 1.5], fmt: (v) => '×' + v },
    lineHeight: { values: [null, 1.6, 2, 2.4], fmt: (v) => v },
    letterSpacing: { values: [null, '0.05em', '0.1em', '0.2em'], fmt: (v) => v },
    wordSpacing: { values: [null, '0.15em', '0.3em', '0.6em'], fmt: (v) => v },
    brightness: { values: [1, 1.2, 1.4, 0.8], fmt: (v) => Math.round(v * 100) + '%' },
    contrast: { values: [1, 1.3, 1.6, 0.8], fmt: (v) => Math.round(v * 100) + '%' },
    saturate: { values: [1, 1.6, 2.2, 0.4], fmt: (v) => Math.round(v * 100) + '%' },
  };
  const DEFAULTS = {
    fontScale: 0, lineHeight: 0, letterSpacing: 0, wordSpacing: 0, brightness: 0, contrast: 0, saturate: 0,
    invert: false, grayscale: false, hideImages: false, readingGuide: false, readingMask: false,
    highlightLinks: false, cursor: null, keyNav: false, showLabels: false, notes: false,
  };
  let settings = Object.assign({}, DEFAULTS, store.get(STORE_KEY, {}));
  Object.keys(CYCLES).forEach((k) => {
    if (!(settings[k] >= 0 && settings[k] < CYCLES[k].values.length)) settings[k] = 0;
  });
  const cyc = (k) => CYCLES[k].values[settings[k]];

  // 暫時性狀態（不儲存）
  let hoverMode = null; // 'colorCheck' | 'measure' | 'layers'
  let hoverEl = null;
  let infoOpen = null;  // 'textTree' | 'imageReview' | 'audit'
  let infoRefs = [];
  let keyboardMode = false;
  let drawOpen = false;
  let navEl = null;
  const mouse = { x: innerWidth / 2, y: innerHeight / 2, moved: false };

  /* ------------------------------------------------------------------ *
   * 按鈕定義
   *   section：所屬分區　layout：tile（圖示在上，佔 1/3）｜half（橫排，佔 1/2）｜wide（橫排，整列）
   *   kbd：顯示在按鈕右側的快捷鍵提示
   * ------------------------------------------------------------------ */
  const SECTIONS = [
    { id: 'display', title: '顯示調整' },
    { id: 'reading', title: '閱讀輔助' },
    { id: 'voice', title: '語音與標示' },
    { id: 'inspect', title: '檢測工具' },
    { id: 'capture', title: '擷取與畫面' },
  ];
  const BUTTONS = [
    { id: 'fontScale', section: 'display', label: '文字放大', type: 'cycle', tip: '逐段放大頁面文字' },
    { id: 'lineHeight', section: 'display', label: '行高', type: 'cycle', tip: '加大行距' },
    { id: 'letterSpacing', section: 'display', label: '字元間距', type: 'cycle', tip: '加大字與字的距離' },
    { id: 'wordSpacing', section: 'display', label: '單字間距', type: 'cycle', tip: '加大單字間距' },
    { id: 'invert', section: 'display', label: '顏色相反', type: 'toggle', tip: '反轉頁面色彩（深色模式）' },
    { id: 'brightness', section: 'display', label: '亮度', type: 'cycle', tip: '調整頁面亮度' },
    { id: 'contrast', section: 'display', label: '對比', type: 'cycle', tip: '調整頁面對比' },
    { id: 'grayscale', section: 'display', label: '灰階', type: 'toggle', tip: '以灰階顯示頁面' },
    { id: 'saturate', section: 'display', label: '飽和度', type: 'cycle', tip: '調整色彩飽和度' },

    { id: 'hideImages', section: 'reading', label: '隱藏圖片', type: 'toggle', tip: '隱藏圖片與背景圖' },
    { id: 'readingGuide', section: 'reading', label: '閱讀指引', type: 'toggle', tip: '跟隨滑鼠的閱讀尺' },
    { id: 'readingMask', section: 'reading', label: '閱讀面罩', type: 'toggle', tip: '只顯示滑鼠附近的區域' },
    { id: 'highlightLinks', section: 'reading', label: '強調連結', type: 'toggle', tip: '醒目標示所有連結' },
    { id: 'cursorWhite', section: 'reading', label: '大白滑鼠', type: 'toggle', tip: '放大白色游標' },
    { id: 'cursorBlack', section: 'reading', label: '大黑滑鼠', type: 'toggle', tip: '放大黑色游標' },

    { id: 'keyNav', section: 'voice', layout: 'wide', label: '鍵盤語音導覽', kbd: 'Shift A/Z · 1–6', type: 'toggle', tip: 'Shift+Z 下一段、Shift+A 上一段；Shift+1~6 跳到 H1~H6 標題' },
    { id: 'showLabels', section: 'voice', layout: 'wide', label: '顯示 HTML 標籤名', type: 'toggle', tip: '在每個元素上顯示其 HTML 標籤名稱' },
    { id: 'notes', section: 'voice', layout: 'half', label: '備註', kbd: 'Shift X', type: 'toggle', tip: '開啟後在頁面任一處點兩下新增備註' },
    { id: 'clearNotes', section: 'voice', layout: 'half', label: '清除所有備註', type: 'action', danger: true, tip: '刪除本頁所有備註（無法復原）' },

    { id: 'colorCheck', section: 'inspect', label: '用色查核', type: 'tool', tip: '滑鼠移到文字上檢查對比（點擊複製）' },
    { id: 'measure', section: 'inspect', label: '元素量測', type: 'tool', tip: '顯示元素尺寸、內外距（點擊複製）' },
    { id: 'layers', section: 'inspect', label: '圖層提示', type: 'tool', tip: '以框線顯示元素層級' },
    { id: 'textTree', section: 'inspect', label: '文字樹', type: 'tool', tip: '標題大綱與頁面地標' },
    { id: 'imageReview', section: 'inspect', label: '圖片檢閱', type: 'tool', tip: '列出所有圖片與 alt 狀態' },
    { id: 'audit', section: 'inspect', label: '無障礙檢測', type: 'tool', tip: '自動檢查常見無障礙問題' },
    { id: 'cssColors', section: 'inspect', layout: 'half', label: 'CSS 用色檢查', type: 'tool', tip: '統計頁面所有顏色：文字、背景、邊框、外框與其他屬性，含色碼與使用次數' },
    { id: 'zIndex', section: 'inspect', layout: 'half', label: 'z-index 檢查', type: 'tool', tip: '列出所有設定 z-index 的元素（id、class）與各數值的使用次數' },

    { id: 'partialShot', section: 'capture', layout: 'half', label: '部分截圖', type: 'tool', tip: '拖曳選取範圍截圖（面板會先收合）' },
    { id: 'fullShot', section: 'capture', layout: 'half', label: '整頁截圖', type: 'action', tip: '擷取整個頁面（面板會先收合）' },
    { id: 'draw', section: 'capture', layout: 'half', label: '繪圖板', type: 'tool', tip: '在頁面上畫重點' },
    { id: 'fullscreen', section: 'capture', layout: 'half', label: '全螢幕', type: 'tool', tip: '切換全螢幕' },
  ];

  function isActive(id) {
    if (id in CYCLES) return settings[id] > 0;
    if (id === 'cursorWhite') return settings.cursor === 'white';
    if (id === 'cursorBlack') return settings.cursor === 'black';
    if (id in DEFAULTS) return !!settings[id];
    if (id === 'colorCheck' || id === 'measure' || id === 'layers') return hoverMode === id;
    if (id === 'zIndex') return infoOpen === id || zMarks;
    if (id === 'textTree' || id === 'imageReview' || id === 'audit' || id === 'cssColors') return infoOpen === id;
    if (id === 'draw') return drawOpen;
    if (id === 'partialShot') return !!selecting;
    if (id === 'fullscreen') return !!(document.fullscreenElement || document.webkitFullscreenElement);
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 圖示（24×24 線條圖示，使用 currentColor）
   * ------------------------------------------------------------------ */
  const ICON_PATHS = {
    fontScale: '<path d="M3.5 19 9 5l5.5 14"/><path d="M5.6 14h6.8"/><path d="M18 8v6M15 11h6"/>',
    lineHeight: '<path d="M11 6h10M11 12h10M11 18h10"/><path d="M6 5v14M3.8 7.2 6 5l2.2 2.2M3.8 16.8 6 19l2.2-2.2"/>',
    letterSpacing: '<path d="M3 4v16M21 4v16"/><path d="m8 17 4-10 4 10M9.6 13h4.8"/>',
    wordSpacing: '<path d="M4 7v10M20 7v10"/><path d="M8 12h8M10 10l-2 2 2 2M14 10l2 2-2 2"/>',
    invert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
    brightness: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M12 8h5.5M12 12h8.5M12 16h5.5"/>',
    grayscale: '<path d="M12 3.2s6 6.4 6 10.8a6 6 0 0 1-12 0c0-4.4 6-10.8 6-10.8z"/><path d="m4 4 16 16"/>',
    saturate: '<path d="M12 3.2s6 6.4 6 10.8a6 6 0 0 1-12 0c0-4.4 6-10.8 6-10.8z"/><path d="M8.8 14.5a3.2 3.2 0 0 0 3.2 3"/>',
    hideImages: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 16 4.5-4.5 4 4 3-3 5.5 5.5"/><path d="m3 3 18 18"/>',
    readingGuide: '<rect x="2.5" y="9" width="19" height="6" rx="1.6"/><path d="M6.5 9v2.6M10 9v1.8M13.5 9v2.6M17 9v1.8"/>',
    readingMask: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M3 14h18"/><path d="M5.5 6.5h13M5.5 17.5h13" opacity=".45"/>',
    highlightLinks: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    cursorWhite: '<path d="m5 3.5 13.5 7.2-6 1.6-2.4 6.2z"/>',
    cursorBlack: '<path d="m5 3.5 13.5 7.2-6 1.6-2.4 6.2z" fill="currentColor"/>',
    keyNav: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M5.5 10h.01M8.5 10h.01M11.5 10h.01M6 14h6"/><path d="M18.5 9.5a3.5 3.5 0 0 1 0 5M20.8 7.5a6.5 6.5 0 0 1 0 9"/>',
    showLabels: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5.5l-3 13"/>',
    notes: '<path d="M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5l-6 6H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M14.5 20.5v-4.5a1.5 1.5 0 0 1 1.5-1.5h4.5"/><path d="M7.5 8.5h9M7.5 12h5"/>',
    clearNotes: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4.5h6V7"/>',
    colorCheck: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-2l-.4-1a1.6 1.6 0 0 1 1.5-2.2h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 7.1 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.4" r="1.1" fill="currentColor"/><circle cx="15" cy="7.8" r="1.1" fill="currentColor"/>',
    measure: '<path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="m7.5 12.5 2 2M10.5 9.5l2 2M13.5 6.5l2 2"/>',
    layers: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5" opacity=".5"/>',
    textTree: '<path d="M4 4.5v15M4 9.5h4M4 15h4"/><rect x="9" y="7" width="11" height="5" rx="1.5"/><rect x="9" y="12.8" width="11" height="5" rx="1.5"/><path d="M3 4.5h6"/>',
    imageReview: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m3.5 17 5-5 4 4 3-3 5 5"/>',
    audit: '<path d="M12 3 19.5 6v5.6c0 4.6-3.2 7.8-7.5 9.4-4.3-1.6-7.5-4.8-7.5-9.4V6z"/><path d="m8.6 12.2 2.4 2.4 4.6-4.8"/>',
    zIndex: '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/><path d="M9.5 14.5v4a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"/><path d="M6.8 7h4.4l-4.4 4.4h4.4"/>',
    cssColors: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><path d="M17.2 13.5s3.3 3.5 3.3 5.4a3.3 3.3 0 0 1-6.6 0c0-1.9 3.3-5.4 3.3-5.4z"/>',
    partialShot: '<path d="M6.5 2.5v13a2 2 0 0 0 2 2h13"/><path d="M17.5 21.5v-13a2 2 0 0 0-2-2h-13"/>',
    fullShot: '<path d="M4.5 8h2.8l1.8-2.6h5.8L16.7 8h2.8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-9A1.5 1.5 0 0 1 4.5 8z"/><circle cx="12" cy="13.6" r="3.4"/>',
    draw: '<path d="m4 20 1-4.5L15.8 4.7a2 2 0 0 1 2.9 0l.6.6a2 2 0 0 1 0 2.9L8.5 19z"/><path d="m14 6.5 3.5 3.5"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const icon = (name, size) => `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;

  // 無障礙標誌（浮動按鈕、面板標題）
  const a11yIcon = (size) => `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="3.5"/>
    <circle cx="32" cy="17" r="4.8" fill="currentColor"/>
    <path d="M17 24.5c5 1.4 10 2.1 15 2.1s10-.7 15-2.1" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"/>
    <path d="M32 27v11M32 38l-6.5 13M32 38l6.5 13" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  /* ------------------------------------------------------------------ *
   * Shadow DOM UI
   * ------------------------------------------------------------------ */
  const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang TC","Noto Sans TC","Microsoft JhengHei","Segoe UI",sans-serif';
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  // 設計色票
  const C = {
    accent: '#5b7cff', accent2: '#7c5cff', glow: 'rgba(91,124,255,.38)',
    panel: '#14171d', panel2: '#0f1115', line: 'rgba(255,255,255,.07)', line2: 'rgba(255,255,255,.13)',
    tile: 'rgba(255,255,255,.035)', tileHover: 'rgba(255,255,255,.075)',
    text: '#e9ecf2', sub: '#a3abbd', mute: '#717a8f',
    glass: 'rgba(18,21,27,.96)',
  };
  const GRAD = `linear-gradient(135deg,${C.accent} 0%,${C.accent2} 100%)`;

  const CSS_TEXT = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,input,select,textarea{font-family:${FONT}}
:focus-visible{outline:2px solid #9db4ff!important;outline-offset:2px}

/* ---------- 浮動按鈕 ---------- */
.fab{position:fixed;left:20px;bottom:20px;z-index:${Z + 7};width:58px;height:58px;padding:0;border:0;border-radius:50%;
  background:${GRAD};color:#fff;display:grid;place-items:center;cursor:pointer;
  box-shadow:0 0 0 3px rgba(255,255,255,.95),0 10px 28px ${C.glow},0 2px 6px rgba(0,0,0,.18);
  transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,background .25s}
.fab:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 0 0 3px #fff,0 14px 34px rgba(91,124,255,.5),0 2px 6px rgba(0,0,0,.2)}
.fab:active{transform:scale(.97)}
.fab[aria-expanded="true"]{background:#1b1f27;box-shadow:0 0 0 3px rgba(255,255,255,.95),0 10px 28px rgba(0,0,0,.35)}

/* ---------- 左側面板 ---------- */
.panel{position:fixed;top:0;left:0;z-index:${Z + 6};width:min(392px,100vw);height:100vh;height:100dvh;overflow-y:auto;overscroll-behavior:contain;
  background:linear-gradient(180deg,${C.panel} 0%,${C.panel2} 100%);color:${C.text};padding:0 0 96px;
  font:14px/1.45 ${FONT};-webkit-font-smoothing:antialiased;
  border-right:1px solid ${C.line};box-shadow:12px 0 48px rgba(0,0,0,.38);
  transform:translateX(-100%);visibility:hidden;transition:transform .32s cubic-bezier(.2,.8,.2,1),visibility 0s linear .32s;
  scrollbar-width:thin;scrollbar-color:#2b303b transparent}
.panel.open{transform:none;visibility:visible;transition:transform .32s cubic-bezier(.2,.8,.2,1)}
.panel::-webkit-scrollbar{width:8px}
.panel::-webkit-scrollbar-thumb{background:#2b303b;border-radius:8px;border:2px solid ${C.panel}}

.head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:18px 18px 16px;background:${C.panel};border-bottom:1px solid ${C.line};box-shadow:0 8px 16px -12px rgba(0,0,0,.6)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:${GRAD};color:#fff;
  box-shadow:0 8px 20px ${C.glow},inset 0 1px 0 rgba(255,255,255,.25)}
.head h2{margin:0;font-size:16px;font-weight:700;letter-spacing:.01em;color:#fff;white-space:nowrap}
.head p{margin:2px 0 0;font-size:12px;color:${C.mute};white-space:nowrap}
.head-actions{display:flex;gap:6px}
.icon-btn{width:34px;height:34px;padding:0;display:grid;place-items:center;border-radius:10px;cursor:pointer;
  border:1px solid ${C.line};background:${C.tile};color:${C.sub};transition:background .15s,color .15s,border-color .15s}
.icon-btn:hover{background:${C.tileHover};border-color:${C.line2};color:#fff}

.sections{padding:4px 18px 0}
.sec h3{display:flex;align-items:center;gap:8px;margin:20px 2px 10px;font-size:11px;font-weight:600;letter-spacing:.14em;color:${C.mute}}
.sec h3::after{content:"";flex:1;height:1px;background:${C.line}}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}

.btn{position:relative;grid-column:span 2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;
  min-height:70px;padding:11px 6px 14px;border-radius:14px;cursor:pointer;
  border:1px solid ${C.line};background:${C.tile};color:#d6dbe5;
  font-size:12.5px;font-weight:500;line-height:1.2;letter-spacing:.02em;text-align:center;
  transition:background .18s,border-color .18s,transform .18s,box-shadow .18s,color .18s}
.btn .ic{display:grid;place-items:center;color:${C.sub};transition:color .18s,transform .18s}
.btn .lb{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn:hover{background:${C.tileHover};border-color:${C.line2};color:#fff;transform:translateY(-1px)}
.btn:hover .ic{color:#fff}
.btn:active{transform:translateY(0) scale(.97)}
.btn[aria-pressed="true"]{background:${GRAD};border-color:transparent;color:#fff;
  box-shadow:0 8px 22px ${C.glow},inset 0 1px 0 rgba(255,255,255,.22)}
.btn[aria-pressed="true"] .ic{color:#fff}
.btn.half,.btn.wide{flex-direction:row;justify-content:flex-start;gap:10px;min-height:48px;padding:10px 12px;text-align:left;font-size:13px}
.btn.half{grid-column:span 3}
.btn.wide{grid-column:span 6}
.kbd{margin-left:auto;flex:none;font:600 10.5px/1 ${MONO};color:${C.sub};white-space:nowrap;
  padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid ${C.line2}}
.btn[aria-pressed="true"] .kbd{color:#fff;background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.28)}
.btn.danger:hover{background:rgba(244,63,94,.12);border-color:rgba(244,63,94,.38);color:#ffd5dc}
.btn.danger:hover .ic{color:#fb7185}
.pips{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;gap:3px}
.pips i{width:9px;height:3px;border-radius:2px;background:currentColor;opacity:.18;transition:opacity .18s}
.pips i.on{opacity:.95}

.foot{display:flex;flex-wrap:wrap;gap:8px 16px;margin:22px 18px 0;padding-top:14px;border-top:1px solid ${C.line};font-size:12px;color:${C.mute}}
.foot span{display:inline-flex;align-items:center;gap:4px}
kbd{font:600 10.5px/1 ${MONO};color:#cfd5e1;padding:3px 5px 4px;border-radius:5px;
  background:rgba(255,255,255,.06);border:1px solid ${C.line2};border-bottom-width:2px}
.credit{margin:18px 18px 0;text-align:center;font-size:12px;font-weight:600;letter-spacing:.06em;color:${C.mute}}
.credit span[aria-hidden]{margin:0 6px;background:${GRAD};-webkit-background-clip:text;background-clip:text;color:transparent}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---------- 閱讀指引 / 面罩 ---------- */
.guide{position:fixed;left:0;right:0;height:16px;z-index:${Z + 1};pointer-events:none;
  background:rgba(255,213,0,.2);border-top:2px solid #ffb300;border-bottom:2px solid #ffb300;box-shadow:0 0 0 1px rgba(0,0,0,.05)}
.mask{position:fixed;left:0;right:0;z-index:${Z + 1};pointer-events:none;background:rgba(10,12,16,.62)}

/* ---------- 高亮框 / 提示 ---------- */
.hl{position:fixed;pointer-events:none;z-index:${Z + 2};display:none}
.hl-box{outline:2px solid ${C.accent};background:rgba(91,124,255,.12);border-radius:2px}
.hl-margin{background:rgba(246,178,107,.38)}
.hl-content{outline:1px dashed #0a8a3a;background:rgba(147,196,125,.28)}
.hl-nav{outline:3px solid #ff9800;box-shadow:0 0 0 6px rgba(255,152,0,.25);border-radius:5px}
.hl-word{background:rgba(255,213,0,.45);border-bottom:2px solid #ff9800;border-radius:2px}
.hl-flash{outline:3px solid #f43f5e;box-shadow:0 0 0 8px rgba(244,63,94,.22);border-radius:5px}
.tip{position:fixed;z-index:${Z + 3};pointer-events:none;background:${C.glass};color:#fff;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid ${C.line2};
  font:12px/1.6 ${MONO};padding:10px 12px;border-radius:12px;max-width:340px;box-shadow:0 12px 32px rgba(0,0,0,.35);display:none}
.tip b{color:#a8bcff}
.tip .big{font-size:15px;font-weight:700}
.sw{display:inline-block;width:11px;height:11px;border:1px solid rgba(255,255,255,.7);border-radius:3px;vertical-align:-1px;margin-right:5px}
.ok{color:#86efac}.bad{color:#fda4af}

/* ---------- HTML 標籤名 ---------- */
.labels{position:absolute;top:0;left:0;width:0;height:0;z-index:${Z}}
.lbl{position:absolute;font:600 10.5px/1.3 ${MONO};padding:2px 6px;border-radius:5px;color:#fff;white-space:nowrap;
  max-width:260px;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:.94;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.lbl.l-sem{background:#15803d}.lbl.l-h{background:#7c3aed}.lbl.l-int{background:#2563eb}
.lbl.l-media{background:#ea580c}.lbl.l-list{background:#0e7490}.lbl.l-info{background:#475569}

/* ---------- 右側資訊面板 ---------- */
.info{position:fixed;top:0;right:0;z-index:${Z + 5};width:min(440px,100vw);height:100vh;height:100dvh;display:flex;flex-direction:column;
  background:rgba(246,247,251,.6);-webkit-backdrop-filter:saturate(1.8) blur(24px);backdrop-filter:saturate(1.8) blur(24px);
  color:#1d2330;font:14px/1.55 ${FONT};-webkit-font-smoothing:antialiased;
  border-left:1px solid rgba(255,255,255,.6);box-shadow:-16px 0 48px rgba(15,20,35,.18);
  transform:translateX(105%);visibility:hidden;transition:transform .32s cubic-bezier(.2,.8,.2,1),visibility 0s linear .32s}
.info.open{transform:none;visibility:visible;transition:transform .32s cubic-bezier(.2,.8,.2,1)}
.info-head{display:flex;align-items:center;gap:10px;padding:16px 18px;background:rgba(255,255,255,.4);border-bottom:1px solid rgba(20,30,60,.08)}
.info-head h2{margin:0;font-size:17px;font-weight:700;flex:1;letter-spacing:.01em}
.info-body{flex:1;overflow-y:auto;padding:16px 18px 40px}
.x{width:34px;height:34px;padding:0;display:grid;place-items:center;background:none;border:0;cursor:pointer;color:#5b6475;border-radius:10px}
.x:hover{background:#eef0f5;color:#111}
.small-btn{background:rgba(255,255,255,.7);border:1px solid rgba(20,30,60,.14);border-radius:9px;padding:6px 12px;font-size:13px;color:#2a3140;cursor:pointer;transition:background .15s}
.small-btn:hover{background:#f1f4fa}
.info h3{font-size:11.5px;font-weight:700;letter-spacing:.1em;margin:20px 2px 8px;color:#7a8396}
.tree-item{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;background:none;border:0;border-radius:9px;
  padding:8px 10px;font-size:14px;cursor:pointer;color:#1d2330}
.tree-item:hover{background:#e9eefc}
.tag{flex:none;font:700 10.5px/1 ${MONO};padding:4px 6px;border-radius:6px;background:#7c3aed;color:#fff}
.tag.lm{background:#0f766e}
.warn{font-style:normal;font-size:12px;color:#e11d48;flex:none}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.stat{flex:1;min-width:80px;background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.75);border-radius:14px;padding:10px 8px;text-align:center;font-size:12px;color:#6b7385}
.stat b{display:block;font-size:22px;color:#1d2330;line-height:1.3}
.img-card{display:grid;grid-template-columns:72px 1fr;gap:12px;padding:10px;margin-bottom:8px;background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.75);border-radius:14px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.img-card:hover{border-color:#c9d3f5;box-shadow:0 6px 16px rgba(30,50,120,.08)}
.img-card .thumb{width:72px;height:72px;border-radius:10px;background:#eef0f5 center/cover no-repeat;display:grid;place-items:center;font-size:26px;overflow:hidden}
.img-card .thumb img{width:100%;height:100%;object-fit:cover}
.img-card .meta{font-size:13px;min-width:0}
.img-card .alt{font-weight:600;word-break:break-word}
.img-card .file{color:#7a8396;font-size:12px;word-break:break-all}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;margin:4px 4px 0 0;color:#fff}
.c-ok{background:#16a34a}.c-bad{background:#e11d48}.c-warn{background:#ea580c}.c-info{background:#64748b}
.score{padding:14px;border-radius:14px;background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.75);margin-bottom:12px;font-size:15px}
.score .e{color:#e11d48;font-weight:700}.score .w{color:#ea580c;font-weight:700}
details.chk{background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.75);border-radius:12px;margin-bottom:8px;overflow:hidden}
details.chk summary{cursor:pointer;padding:10px 12px;display:grid;grid-template-columns:22px 1fr;gap:4px 6px;list-style:none}
details.chk summary::-webkit-details-marker{display:none}
details.chk summary small{grid-column:2;color:#6b7385}
details.chk.error{border-left:4px solid #e11d48}
details.chk.warn{border-left:4px solid #ea580c}
details.chk.pass{border-left:4px solid #16a34a}
.el-list{padding:0 12px 10px 40px;margin:0;list-style:none}
.el-list button{background:none;border:0;padding:3px 0;color:#2f55d4;cursor:pointer;font:12px/1.45 ${MONO};text-align:left;word-break:break-all}
.el-list button:hover{text-decoration:underline}
.cc-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 8px}
.cc-tab{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(20,30,60,.14);background:rgba(255,255,255,.6);color:#2a3140;
  border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
.cc-tab small{font-weight:600;font-size:11px;color:#7a8396}
.cc-tab:hover{background:rgba(255,255,255,.9)}
.cc-tab.on{background:#1d2330;border-color:#1d2330;color:#fff}
.cc-tab.on small{color:rgba(255,255,255,.7)}
.cc-tab.sm{padding:3px 9px;font-size:12px;font-weight:500}
.cc-sort{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;color:#7a8396}
.cc-hint{margin:2px 2px 10px;font-size:12px;color:#7a8396}
.cc-row{display:grid;grid-template-columns:56px 1fr;gap:12px;padding:12px;margin-bottom:8px;background:rgba(255,255,255,.55);
  border:1px solid rgba(255,255,255,.75);border-radius:14px}
.cc-sw{width:56px;height:56px;padding:0;border:0;border-radius:12px;cursor:pointer;
  background:linear-gradient(var(--c),var(--c)),repeating-conic-gradient(#d5d9e2 0 25%,#fff 0 50%) 0 0/12px 12px;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.08);transition:transform .15s}
.cc-sw:hover{transform:scale(1.05)}
.cc-main{min-width:0}
.cc-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cc-hex{background:none;border:0;padding:0;font:700 15px/1.3 ${MONO};color:#1d2330;cursor:pointer;letter-spacing:.02em}
.cc-hex:hover{color:#2f55d4}
.cc-alpha{font-size:11px;color:#7a8396;background:rgba(20,30,60,.06);border-radius:999px;padding:2px 7px}
.cc-count{margin-left:auto;font:700 14px/1 ${FONT};color:#1d2330;background:rgba(91,124,255,.12);border-radius:999px;padding:5px 10px}
.cc-count small{font-weight:500;color:#5b6475}
.cc-props{display:flex;flex-wrap:wrap;gap:4px;margin:7px 0}
.cc-prop{display:inline-flex;gap:5px;align-items:center;font:600 11px/1 ${MONO};padding:4px 7px;border-radius:999px}
.cc-prop b{font-family:${FONT}}
.cc-color{background:#e0e9ff;color:#1e40af}.cc-bg{background:#dcfce7;color:#166534}.cc-border{background:#ffedd5;color:#9a3412}
.cc-outline{background:#ede9fe;color:#5b21b6}.cc-other{background:#e2e8f0;color:#334155}
.cc-codes{display:flex;flex-wrap:wrap;gap:4px}
.cc-code{font:11px/1.3 ${MONO};padding:4px 7px;border-radius:7px;background:rgba(255,255,255,.75);border:1px solid rgba(20,30,60,.1);
  color:#2a3140;cursor:pointer;transition:border-color .15s,color .15s}
.cc-code:hover{border-color:#5b7cff;color:#2f55d4}
.z-warn{margin:0 2px 8px;font-size:12.5px;color:#be123c}
.z-stats{display:flex;flex-direction:column;gap:5px}
.z-stat{display:grid;grid-template-columns:minmax(56px,auto) 1fr 52px;align-items:center;gap:10px;width:100%;padding:7px 10px;
  border:1px solid rgba(255,255,255,.75);background:rgba(255,255,255,.55);border-radius:10px;cursor:pointer;font:13px ${FONT};color:#1d2330;text-align:left;transition:background .15s,border-color .15s}
.z-stat:hover{background:rgba(255,255,255,.85)}
.z-stat.on{border-color:${C.accent};background:rgba(91,124,255,.12)}
.z-val{font:700 13px/1 ${MONO};text-align:right}
.z-bar{height:8px;border-radius:99px;background:rgba(20,30,60,.08);overflow:hidden}
.z-bar i{display:block;height:100%;border-radius:99px;background:${GRAD}}
.z-n{font-size:12px;color:#5b6475;text-align:right;white-space:nowrap}
.z-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.z-head h3 small{margin-left:6px;font-weight:600;letter-spacing:0;color:#9aa1b2}
.z-row{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;
  background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.75);border-radius:12px;cursor:pointer;font:13px/1.5 ${FONT};color:#1d2330;transition:background .15s,border-color .15s}
.z-row:hover{background:rgba(255,255,255,.88);border-color:#c9d3f5}
.z-badge{min-width:52px;padding:7px 8px;border-radius:9px;background:#1d2330;color:#fff;font:700 13px/1 ${MONO};text-align:center}
.z-badge.neg{background:#64748b}
.z-info{display:flex;flex-direction:column;gap:4px;min-width:0}
.z-sel{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.z-tag{font:600 12px/1.4 ${MONO};color:#7c3aed}
.z-id{font:600 12px/1.4 ${MONO};color:#92400e;background:#fef3c7;padding:1px 7px;border-radius:6px;word-break:break-all}
.z-cls{display:flex;flex-wrap:wrap;gap:4px}
.z-cls span{font:11.5px/1.4 ${MONO};color:#1e40af;background:#e0e9ff;padding:1px 7px;border-radius:6px;word-break:break-all}
.z-meta{font-size:11.5px;color:#7a8396}
.z-meta em{font-style:normal;color:#e11d48}
.z-mark-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin:0 0 12px;padding:10px 12px;border-radius:12px;cursor:pointer;
  border:1px solid rgba(91,124,255,.45);background:rgba(91,124,255,.1);color:#2f4fd1;font:600 13px/1.3 ${FONT};transition:background .15s}
.z-mark-btn:hover{background:rgba(91,124,255,.18)}
.z-mark-btn.on{background:${GRAD};border-color:transparent;color:#fff;box-shadow:0 6px 16px ${C.glow}}
.zmarks{position:fixed;inset:0;z-index:${Z + 2};pointer-events:none}
.zm{position:fixed;border:2px solid var(--zc);border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.7),inset 0 0 0 9999px color-mix(in srgb,var(--zc) 8%,transparent)}
.zm.bad{border-style:dashed}
.zm span{position:absolute;left:-2px;bottom:100%;margin-bottom:2px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  background:var(--zc);color:#fff;font:600 11px/1.3 ${MONO};padding:3px 7px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.2)}
.zm.in span{bottom:auto;top:2px;left:2px;margin:0}

/* ---------- 繪圖板 ---------- */
.draw-layer{position:absolute;top:0;left:0;z-index:${Z + 3};cursor:crosshair;touch-action:none}
.draw-layer.pass{pointer-events:none}
.draw-layer canvas{position:absolute;left:0;display:block}
.draw-bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:${Z + 4};display:flex;gap:6px;align-items:center;flex-wrap:wrap;
  justify-content:center;width:max-content;max-width:calc(100vw - 24px);padding:8px 10px;border-radius:16px;
  background:${C.glass};-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);
  border:1px solid ${C.line2};color:${C.text};font:13px ${FONT};box-shadow:0 16px 40px rgba(0,0,0,.35)}
.draw-bar button{background:${C.tile};color:${C.text};border:1px solid ${C.line2};border-radius:9px;padding:6px 11px;font-size:13px;cursor:pointer;transition:background .15s}
.draw-bar button:hover{background:${C.tileHover}}
.draw-bar button[aria-pressed="true"]{background:${GRAD};border-color:transparent;color:#fff}
.draw-bar .color{width:22px;height:22px;padding:0;border-radius:50%;border:2px solid rgba(255,255,255,.22)}
.draw-bar .color[aria-pressed="true"]{outline:2px solid #fff;outline-offset:2px}
.draw-bar .sep{width:1px;height:22px;background:${C.line2};margin:0 2px}
.draw-bar label{display:inline-flex;align-items:center;gap:6px;color:${C.sub};font-size:12px}
.draw-bar input[type=range]{width:84px;accent-color:${C.accent}}

/* ---------- 備註 ---------- */
.notes{position:absolute;top:0;left:0;width:0;height:0;z-index:${Z + 4}}
.note{position:absolute;width:236px;background:#fffbea;color:#3b3220;border:1px solid #f1e2a6;border-radius:14px;font:13px/1.55 ${FONT};
  box-shadow:0 14px 32px rgba(80,60,0,.16),0 2px 6px rgba(0,0,0,.06)}
.note:focus-within{box-shadow:0 0 0 2px #f5b400,0 16px 36px rgba(80,60,0,.2)}
.note-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 6px 5px 12px;
  background:linear-gradient(180deg,#ffe58f,#ffd866);border-radius:13px 13px 0 0;color:#6b5300;font-weight:600;
  cursor:move;user-select:none;-webkit-user-select:none;font-size:12px;touch-action:none}
.note-del{width:26px;height:26px;padding:0;display:grid;place-items:center;background:none;border:0;cursor:pointer;font-size:13px;line-height:1;color:#6b5300;border-radius:8px}
.note-del:hover{background:rgba(0,0,0,.1)}
.note textarea{display:block;width:100%;min-height:86px;border:0;background:transparent;padding:10px 12px;
  font:inherit;color:inherit;resize:vertical;outline:none!important}

/* ---------- 部分截圖選取 ---------- */
.shot-sel{position:fixed;inset:0;z-index:${Z + 8};cursor:crosshair;touch-action:none;background:rgba(10,12,16,.22)}
.shot-box{position:fixed;outline:2px solid #fff;box-shadow:0 0 0 1px ${C.accent},0 0 0 9999px rgba(10,12,16,.38);border-radius:2px;background:transparent;pointer-events:none}
.shot-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:${C.glass};color:#fff;font:13px/1.4 ${FONT};
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid ${C.line2};
  padding:8px 16px;border-radius:12px;pointer-events:none;box-shadow:0 12px 32px rgba(0,0,0,.3)}

/* ---------- Toast ---------- */
.toast{position:fixed;left:50%;bottom:28px;z-index:${Z + 9};transform:translate(-50%,180%);opacity:0;
  background:${C.glass};color:#fff;-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);
  border:1px solid ${C.line2};font:14px/1.45 ${FONT};padding:11px 18px;border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.3);
  transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .2s;pointer-events:none;max-width:calc(100vw - 32px);text-align:center}
.toast.show{transform:translate(-50%,0);opacity:1}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`;

  let host, root, ui = {};

  function buildUI() {
    host = document.createElement('div');
    host.id = 'atpro-root';
    host.setAttribute('data-atpro', '');
    root = host.attachShadow({ mode: 'open' });

    const btnHTML = (b) => {
      const pips = b.type === 'cycle'
        ? `<span class="pips" aria-hidden="true">${CYCLES[b.id].values.slice(1).map(() => '<i></i>').join('')}</span>`
        : '';
      const pressed = b.type === 'action' ? '' : ' aria-pressed="false"';
      const cls = ['btn', b.layout || 'tile', b.danger ? 'danger' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-id="${b.id}" title="${esc(b.tip)}"${pressed}>`
        + `<span class="ic">${icon(b.id)}</span><span class="lb">${esc(b.label)}</span>`
        + (b.kbd ? `<span class="kbd">${esc(b.kbd)}</span>` : '') + pips + '</button>';
    };
    const sectionsHTML = SECTIONS.map((s) => `<section class="sec" aria-label="${esc(s.title)}"><h3>${esc(s.title)}</h3>`
      + `<div class="grid">${BUTTONS.filter((b) => b.section === s.id).map(btnHTML).join('')}</div></section>`).join('');

    root.innerHTML = `
      <style>${CSS_TEXT}</style>
      <div class="labels" data-ref="labels"></div>
      <div class="guide" data-ref="guide" hidden></div>
      <div class="mask" data-ref="maskTop" hidden></div>
      <div class="mask" data-ref="maskBottom" hidden></div>
      <div class="hl hl-margin" data-ref="hlMargin"></div>
      <div class="hl hl-box" data-ref="hlBox"></div>
      <div class="hl hl-content" data-ref="hlContent"></div>
      <div class="hl hl-nav" data-ref="hlNav"></div>
      <div class="hl hl-word" data-ref="hlWord"></div>
      <div class="hl hl-flash" data-ref="hlFlash"></div>
      <div class="tip" data-ref="tip"></div>
      <div class="zmarks" data-ref="zMarks" hidden></div>

      <div class="draw-layer" data-ref="drawLayer" hidden></div>
      <div class="draw-bar" data-ref="drawBar" role="toolbar" aria-label="繪圖工具" hidden>
        ${['#ef4444', '#facc15', '#3b82f6', '#22c55e', '#111827', '#ffffff']
          .map((c, i) => `<button type="button" class="color" data-color="${c}" style="background:${c}" aria-label="顏色 ${c}" aria-pressed="${i === 0}"></button>`).join('')}
        <span class="sep" aria-hidden="true"></span>
        <button type="button" data-tool="pen" aria-pressed="true">畫筆</button>
        <button type="button" data-tool="marker" aria-pressed="false">螢光筆</button>
        <button type="button" data-tool="eraser" aria-pressed="false">橡皮擦</button>
        <button type="button" data-tool="scroll" aria-pressed="false" title="暫停作畫，可捲動或操作頁面">捲動</button>
        <span class="sep" aria-hidden="true"></span>
        <label>粗細 <input type="range" min="1" max="20" value="4" data-ref="drawSize" aria-label="筆刷粗細"></label>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" data-act="clear">清除</button>
        <button type="button" data-act="save">下載</button>
        <button type="button" data-act="close">關閉 ✕</button>
      </div>

      <aside class="info" data-ref="info" role="dialog" aria-labelledby="atpro-info-title">
        <div class="info-head">
          <h2 id="atpro-info-title" data-ref="infoTitle"></h2>
          <span data-ref="infoActions"></span>
          <button type="button" class="x" data-ref="infoClose" aria-label="關閉">${icon('close', 18)}</button>
        </div>
        <div class="info-body" data-ref="infoBody"></div>
      </aside>

      <div class="panel" data-ref="panel" role="dialog" aria-label="Accessibility Options 無障礙選項" id="atpro-panel">
        <header class="head">
          <div class="brand">
            <span class="logo">${a11yIcon(26)}</span>
            <div><h2>Accessibility Options</h2><p>無障礙工具・設定自動保存</p></div>
          </div>
          <div class="head-actions">
            <button type="button" class="icon-btn" data-ref="reset" title="恢復所有預設值" aria-label="重設所有設定">${icon('reset', 18)}</button>
            <button type="button" class="icon-btn" data-ref="panelClose" title="關閉面板" aria-label="關閉面板">${icon('close', 18)}</button>
          </div>
        </header>
        <div class="sections" data-ref="grid">${sectionsHTML}</div>
        <footer class="foot">
          <span><kbd>Shift</kbd><kbd>X</kbd> 備註</span>
          <span><kbd>Shift</kbd><kbd>A</kbd>/<kbd>Z</kbd> 語音導覽</span>
          <span><kbd>Esc</kbd> 關閉工具</span>
        </footer>
        <p class="credit">Claude <span aria-hidden="true">×</span><span class="sr">x</span> William77</p>
      </div>
      <button type="button" class="fab" data-ref="fab" aria-label="開啟無障礙選單" aria-expanded="false" aria-controls="atpro-panel">${a11yIcon(34)}</button>

      <div class="notes" data-ref="notes" aria-label="頁面備註" hidden></div>

      <div class="shot-sel" data-ref="shotSel" hidden>
        <div class="shot-box" data-ref="shotBox" hidden></div>
        <div class="shot-hint" data-ref="shotHint"></div>
      </div>
      <div class="toast" data-ref="toast" role="status" aria-live="polite"></div>
    `;
    root.querySelectorAll('[data-ref]').forEach((el) => { ui[el.dataset.ref] = el; });
    document.documentElement.appendChild(host);

    // 頁面層級樣式（作用於 <body>，面板位於 <html> 下的 Shadow DOM 不受影響）
    ui.pageStyle = document.createElement('style');
    ui.pageStyle.id = 'atpro-page-style';
    (document.head || document.documentElement).appendChild(ui.pageStyle);
  }

  const isOwnEvent = (e) => e.composedPath && e.composedPath().includes(host);

  /* ------------------------------------------------------------------ *
   * Toast / 語音
   * ------------------------------------------------------------------ */
  let toastTimer;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200);
  }
  // 中文語音：優先選用與 speechLang（預設 zh-TW）相符的語音，其次任一中文語音
  function pickVoice() {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const norm = (l) => (l || '').replace('_', '-').toLowerCase();
    const want = norm(CFG.speechLang);
    return voices.find((v) => norm(v.lang) === want)
      || voices.find((v) => /^zh-(tw|hant)/.test(norm(v.lang)))
      || voices.find((v) => norm(v.lang).startsWith('zh'))
      || null;
  }
  if (window.speechSynthesis && speechSynthesis.addEventListener) {
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }
  function speak(text, { onBoundary, onEnd } = {}) {
    if (!('speechSynthesis' in window) || !text) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CFG.speechLang;
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1;
    if (onBoundary) u.onboundary = onBoundary;
    if (onEnd) u.onend = u.onerror = onEnd;
    speechSynthesis.speak(u);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 頁面樣式（濾鏡、間距、游標、連結…）
   * ------------------------------------------------------------------ */
  function cursorURL(color) {
    const fill = color === 'white' ? '#ffffff' : '#000000';
    const stroke = color === 'white' ? '#000000' : '#ffffff';
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 24 24'><path d='M4 2l14 11.5-6.5.8 3.8 7.4-2.9 1.4-3.7-7.5L4 20z' fill='${fill}' stroke='${stroke}' stroke-width='1.2' stroke-linejoin='round'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 4, auto`;
  }
  function pageBgColor() {
    const b = parseColor(getComputedStyle(document.body).backgroundColor);
    const h = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    return b && b.a > 0 ? b : h && h.a > 0 ? h : { r: 255, g: 255, b: 255, a: 1 };
  }

  function applyPageStyle() {
    ui.pageStyle.textContent = '';
    let css = '';
    const lh = cyc('lineHeight'), ls = cyc('letterSpacing'), ws = cyc('wordSpacing');
    if (lh) css += `body,body *{line-height:${lh}!important}`;
    if (ls) css += `body,body *{letter-spacing:${ls}!important}`;
    if (ws) css += `body,body *{word-spacing:${ws}!important}`;

    const filters = [];
    if (settings.invert) filters.push('invert(1) hue-rotate(180deg)');
    if (settings.grayscale) filters.push('grayscale(1)');
    if (cyc('brightness') !== 1) filters.push(`brightness(${cyc('brightness')})`);
    if (cyc('contrast') !== 1) filters.push(`contrast(${cyc('contrast')})`);
    if (cyc('saturate') !== 1) filters.push(`saturate(${cyc('saturate')})`);
    if (filters.length) css += `body{filter:${filters.join(' ')}!important}`;
    if (settings.invert) {
      const bg = pageBgColor();
      const inv = { r: 255 - bg.r, g: 255 - bg.g, b: 255 - bg.b };
      css += `html{background-color:${hex(inv)}!important}body{background-color:${hex(bg)}!important}`;
      css += `body img,body video,body canvas,body iframe,body embed,body object{filter:invert(1) hue-rotate(180deg)!important}`;
    }
    if (settings.hideImages) {
      css += `body img,body picture,body video,body svg,body canvas,body object,body embed{visibility:hidden!important}`;
      css += `body,body *{background-image:none!important}`;
    }
    if (settings.highlightLinks) {
      css += `body a[href]{background:#fff59d!important;color:#000!important;text-decoration:underline!important;
        outline:3px solid #ffb300!important;outline-offset:2px!important}`;
    }
    if (settings.cursor) {
      css += `html,body,body *{cursor:${cursorURL(settings.cursor)}!important}`;
    }
    if (hoverMode === 'layers') {
      const colors = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#d81b60'];
      css += `body *{outline:1px dashed rgba(120,120,120,.6)!important;outline-offset:-1px!important}`;
      colors.forEach((c, i) => {
        css += `body${' > *'.repeat(i + 1)}{outline:2px solid ${c}!important;outline-offset:-2px!important}`;
      });
    }
    ui.pageStyle.textContent = css;
  }

  /* ---------- 文字放大（記錄原始字級，逐元素縮放） ---------- */
  const fontOrig = new WeakMap();
  const fontTracked = new Set();
  const SKIP_FONT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BR', 'HR', 'IFRAME', 'TEMPLATE']);

  function recordFont(el) {
    if (fontOrig.has(el)) return;
    const px = parseFloat(getComputedStyle(el).fontSize);
    let orig = px;
    const p = el.parentElement;
    // 若字級與(已縮放的)父元素相同，視為繼承，使用父元素原始值，避免重複放大
    if (p && fontOrig.has(p) && Math.abs(px - parseFloat(getComputedStyle(p).fontSize)) < 0.01) orig = fontOrig.get(p).px;
    fontOrig.set(el, { px: orig, inline: el.style.getPropertyValue('font-size'), prio: el.style.getPropertyPriority('font-size') });
  }
  function scaleEls(els, scale) {
    els = els.filter((el) => !SKIP_FONT.has(el.tagName));
    els.forEach(recordFont);
    els.forEach((el) => {
      el.style.setProperty('font-size', (fontOrig.get(el).px * scale).toFixed(2) + 'px', 'important');
      fontTracked.add(el);
    });
  }
  function applyFontScale() {
    const scale = cyc('fontScale');
    if (scale === 1) {
      fontTracked.forEach((el) => {
        const o = fontOrig.get(el);
        el.style.removeProperty('font-size');
        if (o && o.inline) el.style.setProperty('font-size', o.inline, o.prio);
      });
      fontTracked.clear();
      return;
    }
    scaleEls([document.body, ...document.body.querySelectorAll('*')], scale);
  }

  /* ------------------------------------------------------------------ *
   * 閱讀指引 / 面罩
   * ------------------------------------------------------------------ */
  function updateReadingAids() {
    ui.guide.hidden = !settings.readingGuide;
    ui.maskTop.hidden = ui.maskBottom.hidden = !settings.readingMask;
    const y = mouse.y;
    if (settings.readingGuide) ui.guide.style.top = y - 8 + 'px';
    if (settings.readingMask) {
      const gap = 60;
      ui.maskTop.style.top = '0';
      ui.maskTop.style.height = Math.max(0, y - gap) + 'px';
      ui.maskBottom.style.top = y + gap + 'px';
      ui.maskBottom.style.bottom = '0';
    }
  }

  /* ------------------------------------------------------------------ *
   * 顯示 HTML 標籤名
   * ------------------------------------------------------------------ */
  const LABEL_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'OPTION', 'OPTGROUP', 'SOURCE', 'TRACK', 'LINK', 'META']);
  const LABEL_KIND = [
    [/^H[1-6]$/, 'h'],
    [/^(HEADER|NAV|MAIN|ASIDE|FOOTER|SECTION|ARTICLE|FORM|FIGURE|FIGCAPTION|DETAILS|SUMMARY|DIALOG|ADDRESS)$/, 'sem'],
    [/^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL)$/, 'int'],
    [/^(IMG|PICTURE|SVG|VIDEO|AUDIO|CANVAS|IFRAME|OBJECT|EMBED)$/, 'media'],
    [/^(UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|CAPTION)$/, 'list'],
  ];
  const labelKind = (tag) => (LABEL_KIND.find(([re]) => re.test(tag)) || [0, 'info'])[1];

  function renderLabels() {
    ui.labels.innerHTML = '';
    if (!settings.showLabels) return;
    const sx = scrollX, sy = scrollY;
    const occupied = new Map(); // 同一位置已放的標籤寬度，用來往右錯開
    const visible = visibilityTester(); // 與語音導覽相同：只標示畫面上看得到的元素（排除收合到視窗外的側欄等）
    let count = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (count >= 1500) break;
      const tag = el.tagName.toUpperCase();
      if (LABEL_SKIP.has(tag)) continue;
      if (el.closest('svg') && tag !== 'SVG') continue; // 不標 svg 內部的 path、g…
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.round(r.left + sx));
      const y = Math.max(0, Math.round(r.top + sy));
      const key = x + ',' + y;
      const b = document.createElement('span');
      b.className = 'lbl l-' + labelKind(tag);
      b.textContent = tag.toLowerCase();
      b.style.left = x + (occupied.get(key) || 0) + 'px';
      b.style.top = y + 'px';
      ui.labels.appendChild(b);
      occupied.set(key, (occupied.get(key) || 0) + b.offsetWidth + 2);
      count++;
    }
  }
  let labelTimer;
  const scheduleLabels = () => {
    if (!settings.showLabels) return;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(renderLabels, 250);
  };

  /* ------------------------------------------------------------------ *
   * 高亮框工具
   * ------------------------------------------------------------------ */
  function setBox(box, r) {
    if (!r) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(0, r.width) + 'px';
    box.style.height = Math.max(0, r.height) + 'px';
  }
  let flashEl = null, flashTimer;
  function locate(el) {
    if (!el || !el.isConnected) { toast('元素已不存在'); return; }
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    flashEl = el;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl = null; setBox(ui.hlFlash, null); }, 2200);
    updateTracked();
  }
  function updateTracked() {
    setBox(ui.hlNav, navEl && navEl.isConnected ? padRect(rectOf(navEl), 3) : null);
    setBox(ui.hlWord, navWord && navWord.node.isConnected ? padRect(wordRect(), 1) : null);
    setBox(ui.hlFlash, flashEl && flashEl.isConnected ? flashEl.getBoundingClientRect() : null);
    if (hoverMode && hoverEl) renderHover();
    positionZMarks();
  }

  /* ------------------------------------------------------------------ *
   * 滑鼠懸停工具：用色查核 / 元素量測 / 圖層提示
   * ------------------------------------------------------------------ */
  function setHoverMode(mode) {
    hoverMode = hoverMode === mode ? null : mode;
    hoverEl = null;
    hideHover();
    applyPageStyle();
    const names = { colorCheck: '用色查核', measure: '元素量測', layers: '圖層提示' };
    toast(hoverMode ? `${names[mode]}：移動滑鼠檢視${mode === 'layers' ? '' : '，點擊可複製資訊'}` : `已關閉${names[mode]}`);
  }
  function hideHover() {
    [ui.hlBox, ui.hlMargin, ui.hlContent].forEach((b) => setBox(b, null));
    ui.tip.style.display = 'none';
  }
  function sides(cs, prop) {
    return ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[prop + s + (prop === 'border' ? 'Width' : '')]) || 0);
  }
  function renderHover() {
    const el = hoverEl;
    if (!el || !el.isConnected || !hoverMode) return hideHover();
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    setBox(ui.hlBox, r);
    setBox(ui.hlMargin, null);
    setBox(ui.hlContent, null);
    let html = '';

    if (hoverMode === 'measure') {
      const m = sides(cs, 'margin'), p = sides(cs, 'padding'), b = sides(cs, 'border');
      setBox(ui.hlMargin, { left: r.left - m[3], top: r.top - m[0], width: r.width + m[1] + m[3], height: r.height + m[0] + m[2] });
      setBox(ui.hlContent, {
        left: r.left + b[3] + p[3], top: r.top + b[0] + p[0],
        width: r.width - b[1] - b[3] - p[1] - p[3], height: r.height - b[0] - b[2] - p[0] - p[2],
      });
      html = `<b>${esc(selectorOf(el))}</b>
        <div class="big">${round(r.width)} × ${round(r.height)} px</div>
        <div>位置 x:${Math.round(r.left + scrollX)} y:${Math.round(r.top + scrollY)}</div>
        <div>margin  ${m.map(round).join(' ')}</div>
        <div>padding ${p.map(round).join(' ')}</div>
        <div>border  ${b.map(round).join(' ')}</div>
        <div>font ${esc(cs.fontSize)} / ${esc(cs.lineHeight)} · ${esc(cs.display)}</div>`;
    } else if (hoverMode === 'colorCheck') {
      const c = textContrast(el);
      const mark = (ok) => (ok ? '<span class="ok">✔ 通過</span>' : '<span class="bad">✘ 未通過</span>');
      html = `<b>${esc(selectorOf(el))}</b>
        <div><span class="sw" style="background:${hex(c.fg)}"></span>文字 ${hex(c.fg)}</div>
        <div><span class="sw" style="background:${hex(c.bg)}"></span>背景 ${hex(c.bg)}</div>
        <div class="big">對比 ${c.ratio.toFixed(2)} : 1</div>
        <div>AA  ${mark(c.aa)}（需 ${c.large ? '3' : '4.5'}:1）</div>
        <div>AAA ${mark(c.aaa)}（需 ${c.large ? '4.5' : '7'}:1）</div>
        <div>字級 ${round(c.size)}px${c.bold ? ' 粗體' : ''}${c.large ? '（大字）' : ''}</div>
        ${c.hasImage ? '<div class="bad">⚠ 背景含圖片，結果僅供參考</div>' : ''}`;
    } else if (hoverMode === 'layers') {
      const path = [];
      let depth = 0;
      for (let n = el; n && n !== document.body; n = n.parentElement) { path.unshift(selectorOf(n)); depth++; }
      html = `<b>深度 ${depth}</b><div>${esc(path.slice(-5).join(' › '))}</div>
        <div>z-index ${esc(cs.zIndex)} · position ${esc(cs.position)}</div>`;
    }
    ui.tip.innerHTML = html;
    ui.tip.style.display = 'block';
    const tw = ui.tip.offsetWidth, th = ui.tip.offsetHeight;
    let x = mouse.x + 16, y = mouse.y + 16;
    if (x + tw > innerWidth - 8) x = mouse.x - tw - 16;
    if (y + th > innerHeight - 8) y = mouse.y - th - 16;
    ui.tip.style.left = Math.max(8, x) + 'px';
    ui.tip.style.top = Math.max(8, y) + 'px';
  }

  /* ------------------------------------------------------------------ *
   * 鍵盤語音導覽 / Heading 導覽
   * ------------------------------------------------------------------ */
  const INTERACTIVE_SEL = 'a[href],button,summary,[role=button],[role=link],[tabindex]:not([tabindex="-1"])';
  const TEXT_SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION|OPTGROUP)$/;

  /* ---------- 視覺可見判斷（只導覽畫面上真的看得到的內容） ----------
   * 排除：display:none、visibility 非 visible、祖先 opacity:0、content-visibility:hidden、
   *       文字顏色全透明、尺寸 < 1px、被 overflow:hidden/clip 或 clip/clip-path 祖先裁掉
   *       （例如 sr-only 只剩 1px）、移到頁面左／上方外（left:-9999px）、
   *       position:fixed 但位於視窗外（例如收合到畫面外的側欄）。
   * 每次導覽建立一個 tester，祖先資訊做快取。 */
  function visibilityTester() {
    const memo = new Map();
    const se = scroller();
    const sx = se.scrollLeft, sy = se.scrollTop, docW = se.scrollWidth;
    const inter = (a, b) => {
      if (!a) return b;
      const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b);
      return { l, t, r, b: bt };
    };
    const box = (rc) => ({ l: rc.left, t: rc.top, r: rc.right, b: rc.bottom });

    // 元素層級：是否被隱藏、累積的裁切框、是否位於 fixed 內
    function info(el) {
      if (!el || el === document.documentElement || el === document.body) return { ok: true, clip: null, fixed: false };
      let v = memo.get(el);
      if (v) return v;
      const parent = info(el.parentElement);
      v = { ok: parent.ok, clip: parent.clip, fixed: parent.fixed };
      if (v.ok) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || parseFloat(cs.opacity) === 0 || cs.contentVisibility === 'hidden') {
          v.ok = false;
        } else {
          if (cs.position === 'fixed') { v.fixed = true; v.clip = null; } // fixed 不受一般祖先的 overflow 裁切
          const clips = /(hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY)
            || (cs.clip && cs.clip !== 'auto')
            || (cs.clipPath && cs.clipPath !== 'none');
          if (clips) v.clip = inter(v.clip, box(el.getBoundingClientRect()));
        }
      }
      memo.set(el, v);
      return v;
    }

    return function visible(node) {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!el) return false;
      const inf = info(el);
      if (!inf.ok) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') return false;
      const color = parseColor(cs.color);
      if (node.nodeType === Node.TEXT_NODE && color && color.a === 0) return false;
      const rc = rectOf(node);
      if (rc.width < 1 || rc.height < 1) return false;
      let b = box(rc);
      if (inf.clip) b = inter(inf.clip, b);
      if (b.r - b.l < 2 || b.b - b.t < 2) return false; // 被裁切到幾乎看不見
      if (inf.fixed) {
        b = inter({ l: 0, t: 0, r: innerWidth, b: innerHeight }, b);
        return b.r - b.l >= 2 && b.b - b.t >= 2; // fixed 元素必須在視窗內
      }
      // 一般元素：不能位於文件左方、上方或右方之外（捲動也到不了的位置）
      return b.r + sx > 0 && b.b + sy > 0 && b.l + sx < docW;
    };
  }

  // 依 DOM 順序取得頁面上所有「視覺上看得到、有內容」的文字節點
  function textNodes() {
    const visible = visibilityTester();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        const p = n.parentElement;
        if (!p || TEXT_SKIP.test(p.tagName)) return NodeFilter.FILTER_SKIP;
        return visible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }
  // 文字節點用 Range 取得實際文字範圍；元素用自身外框
  function rectOf(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.selectNodeContents(node);
      return r.getBoundingClientRect();
    }
    return node.getBoundingClientRect();
  }
  const padRect = (r, p) => ({ left: r.left - p, top: r.top - p, width: r.width + p * 2, height: r.height + p * 2 });

  // 畫面跟隨（只調整 scrollTop，不做水平捲動）：
  // 讓目前朗讀位置保持在畫面垂直中央。先調整頁面內可垂直捲動的容器，再調整頁面本身的 scrollTop；
  // 位於 position:fixed 內的文字本來就在畫面上，不捲動頁面。
  const scroller = () => document.scrollingElement || document.documentElement;
  function follow(getRect) {
    let r = getRect();
    if (!r.width && !r.height) return;
    // 過高的內容（超過畫面 60%）以其上方區段為準，避免直接跳到中段
    const anchor = (rect) => rect.top + Math.min(rect.height, innerHeight * 0.6) / 2;
    let inFixed = false;
    for (let el = navEl && (navEl.nodeType === 1 ? navEl : navEl.parentElement); el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') { inFixed = true; break; }
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
        const cr = el.getBoundingClientRect();
        const d = anchor(r) - (cr.top + cr.height / 2);
        if (Math.abs(d) > 4) { el.scrollTop += d; r = getRect(); }
      }
    }
    if (inFixed) return;
    const se = scroller();
    const d = anchor(r) - innerHeight / 2;
    if (Math.abs(d) < 4) return;
    const top = Math.max(0, Math.min(se.scrollHeight - innerHeight, se.scrollTop + d));
    if (reduceMotion) se.scrollTop = top;
    else window.scrollTo({ top, left: se.scrollLeft, behavior: 'smooth' });
  }

  // 目前朗讀到的字詞（由語音 boundary 事件更新）
  let navWord = null; // { node, start, end }
  function wordRect() {
    const r = document.createRange();
    r.setStart(navWord.node, navWord.start);
    r.setEnd(navWord.node, navWord.end);
    return r.getBoundingClientRect();
  }

  // 朗讀單一文字節點並顯示外框
  function readTextNode(node) {
    navEl = node;
    navWord = null;
    const p = node.parentElement;
    follow(() => rectOf(node));
    const focusable = p.closest(INTERACTIVE_SEL);
    if (focusable && focusable.focus) focusable.focus({ preventScroll: true });
    updateTracked();

    const raw = node.nodeValue;
    const lead = raw.length - raw.trimStart().length; // 朗讀文字去掉前導空白，換算 charIndex 用
    const text = raw.trim();
    let lastLine = null; // 上一個字詞所在行（文件座標），換行時才捲動
    const spoken = speak(text, {
      onBoundary(e) {
        if (navEl !== node || !node.isConnected) return;
        const start = lead + (e.charIndex || 0);
        let len = e.charLength;
        if (!len) { // Safari 等不提供 charLength：取到下一個空白或標點
          const m = raw.slice(start).match(/^[^\s，。、；：！？「」『』（）,.;:!?()]{1,20}/);
          len = m ? m[0].length : 1;
        }
        navWord = { node, start, end: Math.min(raw.length, start + len) };
        updateTracked();
        const line = wordRect().top + scroller().scrollTop;
        if (lastLine === null || Math.abs(line - lastLine) > 4) { lastLine = line; follow(wordRect); }
      },
      onEnd() {
        if (navEl === node) { navWord = null; updateTracked(); }
      },
    });
    if (!spoken) toast(text.replace(/\s+/g, ' ').slice(0, 80));
  }
  function describe(el) {
    const tag = el.tagName;
    let role = '', name = accName(el);
    if (/^H[1-6]$/.test(tag)) role = '標題 ' + tag[1];
    else if (el.getAttribute('role') === 'heading') role = '標題 ' + (el.getAttribute('aria-level') || '');
    else if (tag === 'A' || el.getAttribute('role') === 'link') role = '連結';
    else if (tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type))) role = '按鈕';
    else if (tag === 'IMG') { role = '圖片'; if (!el.hasAttribute('alt')) name = '未提供替代文字'; }
    else if (tag === 'INPUT') {
      role = { checkbox: '核取方塊', radio: '選項按鈕', search: '搜尋框', email: '電子郵件輸入框', password: '密碼輸入框' }[el.type] || '輸入框';
      if (el.type === 'checkbox' || el.type === 'radio') role += el.checked ? '，已勾選' : '，未勾選';
      else if (el.value && el.type !== 'password') name += '，內容：' + el.value;
    } else if (tag === 'SELECT') { role = '下拉選單'; name += '，目前選擇：' + (el.selectedOptions[0] ? el.selectedOptions[0].text : ''); }
    else if (tag === 'TEXTAREA') role = '多行輸入框';
    else if (tag === 'LI') role = '項目';
    else if (tag === 'SUMMARY') role = '可展開項目，' + (el.parentElement && el.parentElement.open ? '已展開' : '已收合');
    else if (tag === 'BLOCKQUOTE') role = '引言';
    return [role, name].filter(Boolean).join('，').slice(0, 400);
  }
  function navTo(el) {
    navEl = el; navWord = null;
    follow(() => el.getBoundingClientRect());
    if (el.matches('a[href],button,summary,[role=button],[role=link]')) el.focus({ preventScroll: true });
    updateTracked();
    const text = describe(el);
    if (!speak(text)) toast(text.slice(0, 80));
  }
  function navMove(dir) {
    const list = textNodes();
    if (!list.length) { toast('頁面沒有可朗讀的文字'); return; }
    let i = navEl ? list.indexOf(navEl) : -1;
    if (i !== -1) {
      i = (i + dir + list.length) % list.length; // 頭尾循環
    } else if (navEl && navEl.isConnected) {
      // 目前停在元素上（例如 Heading 導覽跳到的標題）：從該元素之後／之前接續
      const D = Node.DOCUMENT_POSITION_FOLLOWING, P = Node.DOCUMENT_POSITION_PRECEDING;
      if (dir > 0) {
        i = list.findIndex((t) => !navEl.contains(t) && navEl.compareDocumentPosition(t) & D);
        if (i === -1) i = 0;
      } else {
        for (let k = list.length - 1; k >= 0; k--) {
          if (!navEl.contains(list[k]) && navEl.compareDocumentPosition(list[k]) & P) { i = k; break; }
        }
        if (i === -1) i = list.length - 1;
      }
    } else {
      // 第一次使用：從目前畫面中第一段文字開始
      i = list.findIndex((t) => rectOf(t).top >= 0);
      if (i === -1) i = 0;
      if (dir < 0) i = Math.max(0, i - 1);
    }
    readTextNode(list[i]);
  }
  function headingJump(level) {
    const hs = $$('h' + level, document.body).filter(visibilityTester());
    if (!hs.length) { toast(`本頁沒有 H${level} 標題`); speak(`本頁沒有標題 ${level}`); return; }
    let next = navEl
      ? hs.find((h) => navEl.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)
      : hs.find((h) => h.getBoundingClientRect().top >= 1);
    navTo(next || hs[0]);
  }

  /* ------------------------------------------------------------------ *
   * 右側資訊面板：文字樹 / 圖片檢閱 / 無障礙檢測
   * ------------------------------------------------------------------ */
  function openInfo(kind) {
    if (infoOpen === kind) return closeInfo();
    infoOpen = kind;
    infoRefs = [];
    const titles = { textTree: '文字樹', imageReview: '圖片檢閱', audit: '無障礙檢測', cssColors: 'CSS 用色檢查', zIndex: 'z-index 檢查' };
    ui.infoTitle.textContent = titles[kind];
    ui.infoActions.innerHTML = '<button type="button" class="small-btn" data-act="refresh">重新整理</button>';
    ui.infoBody.innerHTML = { textTree: buildTextTree, imageReview: buildImageReview, audit: buildAudit, cssColors: buildCssColors, zIndex: buildZIndex }[kind]();
    ui.info.classList.add('open');
    ui.infoBody.scrollTop = 0;
    if (keyboardMode) ui.infoClose.focus({ preventScroll: true }); // 滑鼠開啟時不移動焦點，避免出現焦點框
    refreshButtons();
  }
  function closeInfo() {
    infoOpen = null;
    ui.info.classList.remove('open');
    if (root.activeElement && ui.info.contains(root.activeElement)) root.activeElement.blur();
    refreshButtons();
  }
  const ref = (el) => infoRefs.push(el) - 1;

  /* ------------------------------------------------------------------ *
   * CSS 用色檢查：統計頁面上所有實際呈現的顏色
   * ------------------------------------------------------------------ */
  const CC_CATS = [
    { id: 'color', short: '文字', label: 'color' },
    { id: 'background-color', short: '背景', label: 'background-color' },
    { id: 'border-color', short: '邊框', label: 'border-color' },
    { id: 'outline-color', short: '外框', label: 'outline-color' },
    { id: 'other', short: '其他', label: 'box-shadow、text-shadow、漸層、fill、stroke…' },
  ];
  const CC_PROP_CAT = { 'color': 'color', 'background-color': 'bg', 'border-color': 'border', 'outline-color': 'outline' };
  const COLOR_RE = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-fA-F]{3,8}\b/g;
  const SVG_SHAPES = /^(path|rect|circle|ellipse|line|polyline|polygon|text|tspan|textPath|use)$/;
  let ccData = null, ccFilter = 'all', ccSort = 'count';
  const ccLocIdx = new Map();

  // 任何 CSS 顏色字串 → {r,g,b,a}（rgb() 直接解析；其他格式以 canvas 轉為 sRGB）
  const ccCache = new Map();
  let ccCtx = null;
  function normColor(str) {
    if (!str) return null;
    if (ccCache.has(str)) return ccCache.get(str);
    let out = null;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: Math.round(a * 1000) / 1000 };
    } else {
      try {
        if (!ccCtx) { const c = document.createElement('canvas'); c.width = c.height = 1; ccCtx = c.getContext('2d', { willReadFrequently: true }); }
        ccCtx.clearRect(0, 0, 1, 1);
        ccCtx.fillStyle = 'rgba(0,0,0,0)';
        ccCtx.fillStyle = str;
        ccCtx.fillRect(0, 0, 1, 1);
        const d = ccCtx.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: Math.round(d[3] / 255 * 1000) / 1000 };
      } catch (e) { out = null; }
    }
    ccCache.set(str, out);
    return out;
  }

  function collectCssColors() {
    const map = new Map();
    const add = (raw, cat, prop, el) => {
      const c = normColor(raw);
      if (!c || c.a === 0) return; // 完全透明不列入
      const key = c.r + ',' + c.g + ',' + c.b + ',' + c.a;
      let e = map.get(key);
      if (!e) { e = { key, r: c.r, g: c.g, b: c.b, a: c.a, total: 0, cats: {}, props: {}, els: [] }; map.set(key, e); }
      e.total++;
      e.cats[cat] = (e.cats[cat] || 0) + 1;
      e.props[prop] = (e.props[prop] || 0) + 1;
      if (e.els.length < 300 && e.els[e.els.length - 1] !== el) e.els.push(el);
    };
    const hasOwnText = (el) => Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.nodeValue.trim());
    const scan = (el, cs, pseudo) => {
      const tag = el.tagName.toUpperCase();
      const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
      const showsText = pseudo
        ? !/^(none|normal|""|'')$/.test(cs.content || 'none')
        : hasOwnText(el) || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag);
      // 文字色：只計算本身有顯示文字的元素（避免單純繼承造成次數灌水）
      if (showsText && !isSvg) add(cs.color, 'color', 'color', el);
      add(cs.backgroundColor, 'background-color', 'background-color', el);
      // 邊框色：只計算有寬度且有樣式的邊，同元素同色只算一次
      const sides = new Set();
      ['Top', 'Right', 'Bottom', 'Left'].forEach((s) => {
        if (parseFloat(cs['border' + s + 'Width']) > 0 && !/^(none|hidden)$/.test(cs['border' + s + 'Style'])) sides.add(cs['border' + s + 'Color']);
      });
      sides.forEach((v) => add(v, 'border-color', 'border-color', el));
      if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') add(cs.outlineColor, 'outline-color', 'outline-color', el);

      // 其他與顏色相關的屬性
      if (showsText && cs.textDecorationLine && cs.textDecorationLine !== 'none') add(cs.textDecorationColor, 'other', 'text-decoration-color', el);
      if (parseFloat(cs.webkitTextStrokeWidth) > 0) add(cs.webkitTextStrokeColor, 'other', '-webkit-text-stroke-color', el);
      if (showsText && cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) add(cs.webkitTextFillColor, 'other', '-webkit-text-fill-color', el);
      if (cs.columnRuleStyle && cs.columnRuleStyle !== 'none' && parseFloat(cs.columnRuleWidth) > 0 && parseInt(cs.columnCount, 10) > 1) add(cs.columnRuleColor, 'other', 'column-rule-color', el);
      if (cs.accentColor && cs.accentColor !== 'auto' && /^(INPUT|PROGRESS|METER)$/.test(tag)) add(cs.accentColor, 'other', 'accent-color', el);
      if (cs.caretColor && cs.caretColor !== 'auto' && cs.caretColor !== cs.color && /^(INPUT|TEXTAREA)$/.test(tag)) add(cs.caretColor, 'other', 'caret-color', el);
      if (isSvg && !pseudo && SVG_SHAPES.test(el.localName)) {
        if (cs.fill && cs.fill !== 'none' && !cs.fill.startsWith('url')) add(cs.fill, 'other', 'fill', el);
        if (cs.stroke && cs.stroke !== 'none' && !cs.stroke.startsWith('url') && parseFloat(cs.strokeWidth) > 0) add(cs.stroke, 'other', 'stroke', el);
      }
      [['boxShadow', 'box-shadow'], ['textShadow', 'text-shadow'], ['backgroundImage', 'background-image']].forEach(([k, name]) => {
        const v = cs[k];
        if (v && v !== 'none') (v.match(COLOR_RE) || []).forEach((c) => add(c, 'other', name, el));
      });
    };

    let scanned = 0;
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|BR|WBR)$/i.test(el.tagName)) continue;
      if (!el.getClientRects().length) continue; // 未呈現（display:none 或位於其內）
      const cs = getComputedStyle(el);
      scanned++;
      scan(el, cs, false);
      ['::before', '::after'].forEach((p) => {
        const ps = getComputedStyle(el, p);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal') scan(el, ps, true);
      });
    }
    return { colors: [...map.values()], scanned };
  }

  // 各式色碼
  function ccFormats(c) {
    const h2 = (n) => n.toString(16).padStart(2, '0');
    const hex = ('#' + h2(c.r) + h2(c.g) + h2(c.b) + (c.a < 1 ? h2(Math.round(c.a * 255)) : '')).toUpperCase();
    const a = +c.a.toFixed(3);
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const l = (mx + mn) / 2;
    const sl = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    const sv = mx ? d / mx : 0;
    const P = (x) => Math.round(x * 100);
    const H = Math.round(h) % 360;
    const k = 1 - mx;
    const cmy = (x) => (k >= 1 ? 0 : (1 - x - k) / (1 - k));
    return {
      hex,
      rgb: c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` : `rgb(${c.r}, ${c.g}, ${c.b})`,
      hsl: c.a < 1 ? `hsla(${H}, ${P(sl)}%, ${P(l)}%, ${a})` : `hsl(${H}, ${P(sl)}%, ${P(l)}%)`,
      hsb: `hsb(${H}, ${P(sv)}%, ${P(mx)}%)`,
      cmyk: `cmyk(${P(cmy(r))}%, ${P(cmy(g))}%, ${P(cmy(b))}%, ${P(k)}%)`,
      h, s: sl, l,
    };
  }

  function buildCssColors() {
    ccData = collectCssColors();
    ccLocIdx.clear();
    return ccHTML();
  }
  function ccHTML() {
    const list = ccData.colors;
    const catCount = (id) => list.filter((c) => c.cats[id]).length;
    const uses = list.reduce((s, c) => s + c.total, 0);
    const tabs = [{ id: 'all', short: '全部', label: '所有顏色' }, ...CC_CATS].map((t) =>
      `<button type="button" class="cc-tab${ccFilter === t.id ? ' on' : ''}" data-cfilter="${t.id}" title="${esc(t.label)}">${esc(t.short)}<small>${t.id === 'all' ? list.length : catCount(t.id)}</small></button>`).join('');
    const sorts = [['count', '使用次數'], ['hue', '色相'], ['light', '亮度']].map(([k, l]) =>
      `<button type="button" class="cc-tab sm${ccSort === k ? ' on' : ''}" data-csort="${k}">${l}</button>`).join('');
    return `<div class="stats">
        <div class="stat"><b>${list.length}</b>顏色</div>
        <div class="stat"><b>${uses}</b>使用次數</div>
        <div class="stat"><b>${ccData.scanned}</b>掃描元素</div>
      </div>
      <div class="cc-tabs">${tabs}</div>
      <div class="cc-sort"><span>排序</span>${sorts}</div>
      <p class="cc-hint">點色碼複製・點色塊在頁面上定位（再點一次跳到下一個）</p>
      <div data-ccl>${ccListHTML()}</div>`;
  }
  function ccListHTML() {
    const list = ccData.colors.filter((c) => ccFilter === 'all' || c.cats[ccFilter]);
    if (!list.length) return '<p>沒有符合的顏色。</p>';
    const fmt = new Map(list.map((c) => [c, ccFormats(c)]));
    const countOf = (c) => (ccFilter === 'all' ? c.total : c.cats[ccFilter]);
    if (ccSort === 'count') list.sort((a, b) => countOf(b) - countOf(a));
    else if (ccSort === 'light') list.sort((a, b) => fmt.get(b).l - fmt.get(a).l);
    else list.sort((a, b) => {
      const A = fmt.get(a), B = fmt.get(b);
      const ga = A.s < 0.08 || A.l < 0.04 || A.l > 0.97, gb = B.s < 0.08 || B.l < 0.04 || B.l > 0.97; // 無彩色排最後
      if (ga !== gb) return ga ? 1 : -1;
      return ga ? B.l - A.l : (A.h - B.h) || (B.l - A.l);
    });
    return list.map((c) => {
      const f = fmt.get(c);
      const props = Object.entries(c.props).sort((a, b) => b[1] - a[1])
        .filter(([p]) => ccFilter === 'all' || (ccFilter === 'other' ? !CC_PROP_CAT[p] : p === ccFilter))
        .map(([p, n]) => `<span class="cc-prop cc-${CC_PROP_CAT[p] || 'other'}">${esc(p)}<b>${n}</b></span>`).join('');
      const codes = ['rgb', 'hsl', 'hsb', 'cmyk'].map((k) =>
        `<button type="button" class="cc-code" data-copy="${esc(f[k])}" title="點擊複製">${esc(f[k])}</button>`).join('');
      return `<div class="cc-row">
          <button type="button" class="cc-sw" style="--c:rgba(${c.r},${c.g},${c.b},${c.a})" data-cloc="${c.key}"
            title="在頁面上定位（${c.els.length} 個元素）" aria-label="定位使用 ${f.hex} 的元素"></button>
          <div class="cc-main">
            <div class="cc-top">
              <button type="button" class="cc-hex" data-copy="${f.hex}" title="點擊複製">${f.hex}</button>
              ${c.a < 1 ? `<span class="cc-alpha">不透明度 ${Math.round(c.a * 100)}%</span>` : ''}
              <span class="cc-count" title="使用次數">${countOf(c)}<small> 次</small></span>
            </div>
            <div class="cc-props">${props}</div>
            <div class="cc-codes">${codes}</div>
          </div>
        </div>`;
    }).join('');
  }
  function ccRerender() {
    if (infoOpen !== 'cssColors' || !ccData) return;
    const st = ui.infoBody.scrollTop;
    ui.infoBody.innerHTML = ccHTML();
    ui.infoBody.scrollTop = st;
  }
  function ccLocate(key) {
    const c = ccData && ccData.colors.find((x) => x.key === key);
    if (!c) return;
    const els = c.els.filter((el) => el.isConnected);
    if (!els.length) { toast('元素已不存在，請按「重新整理」'); return; }
    const i = ((ccLocIdx.get(key) ?? -1) + 1) % els.length;
    ccLocIdx.set(key, i);
    locate(els[i]);
    toast(`${ccFormats(c).hex}：第 ${i + 1} / ${els.length} 個元素`);
  }
  /* ------------------------------------------------------------------ *
   * z-index 檢查：列出所有設定了 z-index 的元素與數值統計
   * ------------------------------------------------------------------ */
  let zData = null, zFilter = 'all';
  let zMarks = false;      // 是否在頁面上標示 z-index 元素
  let zMarkList = [];      // [{ item, box, label }]
  const Z_COLORS = ['#5b7cff', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'];

  // 依目前的篩選建立頁面標示（同一數值同一顏色；數值大的畫在上層）
  function buildZMarks() {
    ui.zMarks.innerHTML = '';
    zMarkList = [];
    if (!zMarks || !zData) { ui.zMarks.hidden = true; return; }
    const values = [...new Set(zData.map((i) => i.z))].sort((a, b) => b - a);
    const items = zData.filter((i) => i.rendered && (zFilter === 'all' || String(i.z) === zFilter))
      .sort((a, b) => a.z - b.z || a.order - b.order);
    items.forEach((item) => {
      const el = item.el;
      const color = Z_COLORS[values.indexOf(item.z) % Z_COLORS.length];
      const sel = el.localName + (el.id ? '#' + el.id : '')
        + ((el.getAttribute('class') || '').trim() ? '.' + el.getAttribute('class').trim().split(/\s+/).join('.') : '')
        + (item.pseudo || '');
      const box = document.createElement('div');
      box.className = 'zm' + (item.effective ? '' : ' bad');
      box.style.setProperty('--zc', color);
      const label = document.createElement('span');
      label.textContent = 'z-index: ' + item.z + ' · ' + sel + (item.effective ? '' : ' ⚠ 無作用');
      box.appendChild(label);
      ui.zMarks.appendChild(box);
      zMarkList.push({ item, box });
    });
    ui.zMarks.hidden = false;
    positionZMarks();
  }
  // 依元素目前位置更新標示框（捲動、縮放時呼叫）
  function positionZMarks() {
    if (!zMarks) return;
    const anchors = new Map(); // 同一位置的標籤往右排開，避免互相遮住
    zMarkList.forEach(({ item, box }) => {
      const r = item.el.isConnected ? item.el.getBoundingClientRect() : null;
      if (!r || (!r.width && !r.height)) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      const inside = r.top < 24; // 太靠近視窗頂端時，標籤改放在框內
      box.classList.toggle('in', inside);
      const label = box.firstChild;
      const key = Math.round(r.left / 8) + ',' + Math.round((inside ? r.top : r.top - 20) / 8);
      const offset = anchors.get(key) || 0;
      label.style.transform = offset ? 'translateX(' + offset + 'px)' : '';
      anchors.set(key, offset + label.offsetWidth + 4);
    });
  }
  function setZMarks(on) {
    zMarks = on;
    buildZMarks();
    zRerender();
    refreshButtons();
  }
  function collectZIndex() {
    const items = [];
    const consider = (el, cs, pseudo) => {
      const z = cs.zIndex;
      if (!z || z === 'auto') return;
      // z-index 只對「已定位」元素或 flex / grid 子項目有作用
      let effective = cs.position !== 'static';
      if (!effective) {
        const container = pseudo ? el : el.parentElement;
        if (container && /(flex|grid)/.test(getComputedStyle(container).display)) effective = true;
      }
      items.push({
        el, pseudo, z: parseInt(z, 10), pos: cs.position, effective,
        rendered: el.getClientRects().length > 0,
        order: items.length,
      });
    };
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/i.test(el.tagName)) continue;
      consider(el, getComputedStyle(el), '');
      ['::before', '::after'].forEach((p) => {
        const ps = getComputedStyle(el, p);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal') consider(el, ps, p);
      });
    }
    return items;
  }
  function buildZIndex() {
    zData = collectZIndex();
    if (zFilter !== 'all' && !zData.some((i) => String(i.z) === zFilter)) zFilter = 'all';
    if (zMarks) setTimeout(buildZMarks, 0);
    return zHTML();
  }
  function zHTML() {
    infoRefs = [];
    const list = zData;
    if (!list.length) return '<p>此頁沒有設定 z-index 的元素。</p>';
    const counts = new Map();
    list.forEach((i) => counts.set(i.z, (counts.get(i.z) || 0) + 1));
    const values = [...counts.entries()].sort((a, b) => b[0] - a[0]);
    const maxN = Math.max(...counts.values());
    const zs = list.map((i) => i.z);
    const ineffective = list.filter((i) => !i.effective).length;

    const statRows = values.map(([v, n]) => `
      <button type="button" class="z-stat${zFilter === String(v) ? ' on' : ''}" data-zfilter="${v}" title="只顯示 z-index: ${v} 的元素">
        <span class="z-val">${v}</span>
        <span class="z-bar"><i style="width:${Math.max(4, (n / maxN) * 100)}%"></i></span>
        <span class="z-n">${n} 次</span>
      </button>`).join('');

    const shown = list.filter((i) => zFilter === 'all' || String(i.z) === zFilter)
      .sort((a, b) => b.z - a.z || a.order - b.order);
    const rows = shown.map((i) => {
      const el = i.el;
      const tag = el.localName;
      const id = el.id;
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      const notes = [];
      if (!i.effective) notes.push('<em>未定位，z-index 無作用</em>');
      if (!i.rendered) notes.push('目前未顯示');
      return `<button type="button" class="z-row" data-ref="${ref(el)}" title="在頁面上定位">
          <span class="z-badge${i.z < 0 ? ' neg' : ''}">${i.z}</span>
          <span class="z-info">
            <span class="z-sel"><span class="z-tag">&lt;${esc(tag)}&gt;${i.pseudo ? esc(i.pseudo) : ''}</span>${id ? `<span class="z-id" title="id">#${esc(id)}</span>` : ''}</span>
            ${cls.length ? `<span class="z-cls" title="class">${cls.map((c) => `<span>.${esc(c)}</span>`).join('')}</span>` : ''}
            <span class="z-meta">position: ${esc(i.pos)}${notes.length ? '・' + notes.join('・') : ''}</span>
          </span>
        </button>`;
    }).join('');

    return `<div class="stats">
        <div class="stat"><b>${list.length}</b>元件</div>
        <div class="stat"><b>${values.length}</b>不同數值</div>
        <div class="stat"><b>${Math.max(...zs)}</b>最大</div>
        <div class="stat"><b>${Math.min(...zs)}</b>最小</div>
      </div>
      <button type="button" class="z-mark-btn${zMarks ? ' on' : ''}" data-zmark aria-pressed="${zMarks}">${zMarks ? '✓ 頁面標示中・點擊取消' : '在頁面上標示' + (zFilter === 'all' ? '全部 z-index 元素' : ' z-index: ' + esc(zFilter) + ' 的元素')}</button>
      ${ineffective ? `<p class="z-warn">⚠ ${ineffective} 個元素設定了 z-index 但未定位，數值不會生效。</p>` : ''}
      <h3>z-index 統計</h3>
      <div class="z-stats">${statRows}</div>
      <div class="z-head">
        <h3>元件列表${zFilter === 'all' ? '' : `（z-index: ${esc(zFilter)}）`}<small>${shown.length} 個</small></h3>
        ${zFilter === 'all' ? '' : '<button type="button" class="cc-tab sm" data-zfilter="all">顯示全部</button>'}
      </div>
      <div class="z-list">${rows}</div>`;
  }
  function zRerender() {
    if (infoOpen !== 'zIndex' || !zData) return;
    const st = ui.infoBody.scrollTop;
    ui.infoBody.innerHTML = zHTML();
    ui.infoBody.scrollTop = st;
  }

  function copyText(text) {
    const done = () => toast('已複製 ' + text);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('無法複製'); }
      ta.remove();
    }
  }


  function buildTextTree() {
    const hs = $$('h1,h2,h3,h4,h5,h6,[role=heading]', document.body).filter(isVisible);
    let prev = 0;
    const items = hs.map((h) => {
      const lvl = /^H\d$/.test(h.tagName) ? +h.tagName[1] : +(h.getAttribute('aria-level') || 2);
      const skipped = prev && lvl > prev + 1;
      prev = lvl;
      return `<button type="button" class="tree-item" data-ref="${ref(h)}" style="padding-left:${(lvl - 1) * 18 + 8}px">
        <span class="tag">H${lvl}</span><span>${esc(textOf(h) || '（空白標題）')}</span>${skipped ? '<em class="warn">⚠ 跳級</em>' : ''}</button>`;
    }).join('');

    const LM = [
      ['header,[role=banner]', '頁首 banner'], ['nav,[role=navigation]', '導覽 nav'], ['main,[role=main]', '主要內容 main'],
      ['aside,[role=complementary]', '側欄 aside'], ['footer,[role=contentinfo]', '頁尾 footer'],
      ['form,[role=form]', '表單 form'], ['[role=search]', '搜尋 search'], ['section[aria-label],section[aria-labelledby],[role=region]', '區域 region'],
    ];
    const lms = LM.flatMap(([sel, name]) => $$(sel, document.body).filter(isVisible).map((el) =>
      `<button type="button" class="tree-item" data-ref="${ref(el)}"><span class="tag lm">${esc(name)}</span><span>${esc(el.getAttribute('aria-label') || selectorOf(el))}</span></button>`
    )).join('');
    const h1Count = hs.filter((h) => h.tagName === 'H1').length;

    return `<div class="stats">
        <div class="stat"><b>${hs.length}</b>標題</div>
        <div class="stat"><b>${h1Count}</b>H1</div>
        <div class="stat"><b>${(lms.match(/class="tree-item"/g) || []).length}</b>地標</div>
      </div>
      <h3>標題大綱</h3>${items || '<p>此頁沒有任何標題。</p>'}
      <h3>頁面地標</h3>${lms || '<p>此頁沒有使用地標元素（header / nav / main / footer）。</p>'}`;
  }

  function buildImageReview() {
    const imgs = $$('img,input[type=image],[role=img]', document.body);
    let missing = 0, deco = 0, ok = 0;
    const cards = imgs.map((el) => {
      const isImg = el.tagName === 'IMG' || el.tagName === 'INPUT';
      const alt = isImg ? el.getAttribute('alt') : accName(el);
      const chips = [];
      if (alt === null || (!isImg && !alt)) { missing++; chips.push(['c-bad', '缺少替代文字']); }
      else if (alt.trim() === '') { deco++; chips.push(['c-info', '裝飾圖片']); }
      else {
        ok++; chips.push(['c-ok', '有替代文字']);
        if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(alt) || /^(image|img|photo|圖片|照片|圖)$/i.test(alt.trim())) chips.push(['c-warn', 'alt 內容無意義']);
        if (alt.length > 125) chips.push(['c-warn', 'alt 過長']);
      }
      let src = '', size = '';
      if (el.tagName === 'IMG') {
        src = el.currentSrc || el.src;
        const r = el.getBoundingClientRect();
        if (el.complete && !el.naturalWidth) chips.push(['c-bad', '載入失敗']);
        size = `原始 ${el.naturalWidth}×${el.naturalHeight}・顯示 ${Math.round(r.width)}×${Math.round(r.height)}`;
        if (r.width && el.naturalWidth > r.width * 2.5 * (window.devicePixelRatio || 1) / 2) chips.push(['c-warn', '尺寸過大']);
        if (!isVisible(el)) chips.push(['c-info', '目前隱藏']);
      }
      const file = src ? decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || '').slice(0, 80) : selectorOf(el);
      const thumb = src && !src.startsWith('data:image/svg') ? `<img src="${esc(src)}" alt="">` : '🖼️';
      return `<div class="img-card" data-ref="${ref(el)}" role="button" tabindex="0">
        <div class="thumb">${thumb}</div>
        <div class="meta">
          <div class="alt">${alt ? esc(alt) : '<span style="color:#c62828">（無）</span>'}</div>
          <div class="file">${esc(file)}</div>
          ${size ? `<div class="file">${size}</div>` : ''}
          <div>${chips.map(([c, t]) => `<span class="chip ${c}">${t}</span>`).join('')}</div>
        </div></div>`;
    }).join('');
    return `<div class="stats">
        <div class="stat"><b>${imgs.length}</b>全部</div>
        <div class="stat"><b style="color:#c62828">${missing}</b>缺 alt</div>
        <div class="stat"><b>${deco}</b>裝飾</div>
        <div class="stat"><b style="color:#2e7d32">${ok}</b>有 alt</div>
      </div>${cards || '<p>此頁沒有圖片。</p>'}`;
  }

  function runAudit() {
    const body = document.body;
    const C = [];
    const add = (title, level, desc, els) => C.push({ title, level, desc, els: els || [] });

    const lang = document.documentElement.getAttribute('lang');
    add('頁面語言', lang ? 'pass' : 'error', lang ? `lang="${lang}"` : '<html> 缺少 lang 屬性，螢幕閱讀器無法判斷發音語言');
    const title = document.title.trim();
    add('頁面標題', title ? 'pass' : 'error', title ? `「${title}」` : '缺少 <title>');

    const vp = (document.querySelector('meta[name=viewport]') || {}).content || '';
    const ms = vp.match(/maximum-scale\s*=\s*([\d.]+)/i);
    const noZoom = /user-scalable\s*=\s*(no|0)/i.test(vp) || (ms && parseFloat(ms[1]) < 2);
    add('允許縮放', noZoom ? 'error' : 'pass', noZoom ? 'viewport 禁止或限制使用者縮放' : '使用者可自由縮放頁面');

    const imgs = $$('img', body);
    const noAlt = imgs.filter((i) => !i.hasAttribute('alt'));
    add('圖片替代文字', noAlt.length ? 'error' : 'pass', noAlt.length ? `${noAlt.length} 張圖片缺少 alt 屬性` : `${imgs.length} 張圖片皆有 alt`, noAlt);

    const links = $$('a[href]', body).filter(isVisible);
    const noNameLinks = links.filter((a) => !accName(a));
    add('連結名稱', noNameLinks.length ? 'error' : 'pass', noNameLinks.length ? `${noNameLinks.length} 個連結沒有可讀名稱` : `${links.length} 個連結皆有名稱`, noNameLinks);
    const vague = links.filter((a) => /^(click here|here|more|read more|link|點此|點這裡|這裡|按此|更多|詳全文|了解更多)$/i.test(accName(a)));
    add('連結文字明確', vague.length ? 'warn' : 'pass', vague.length ? `${vague.length} 個連結文字過於籠統（如「更多」「點此」）` : '未發現籠統的連結文字', vague);

    const btns = $$('button,[role=button],input[type=button],input[type=submit],input[type=reset]', body).filter(isVisible);
    const noNameBtns = btns.filter((b) => !accName(b));
    add('按鈕名稱', noNameBtns.length ? 'error' : 'pass', noNameBtns.length ? `${noNameBtns.length} 個按鈕沒有可讀名稱` : `${btns.length} 個按鈕皆有名稱`, noNameBtns);

    const fields = $$('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea', body).filter(isVisible);
    const unlabeled = fields.filter((f) => !accName(f, { allowPlaceholder: false }));
    add('表單標籤', unlabeled.length ? 'error' : 'pass', unlabeled.length ? `${unlabeled.length} 個欄位沒有 label（placeholder 不能取代 label）` : `${fields.length} 個欄位皆有標籤`, unlabeled);

    const hs = $$('h1,h2,h3,h4,h5,h6', body).filter(isVisible);
    const h1s = hs.filter((h) => h.tagName === 'H1');
    add('H1 標題', !h1s.length ? 'error' : h1s.length > 1 ? 'warn' : 'pass', !h1s.length ? '頁面缺少 H1' : h1s.length > 1 ? `有 ${h1s.length} 個 H1，建議只有一個` : '有一個 H1', h1s.length > 1 ? h1s : []);
    const skips = [];
    let prev = 0;
    hs.forEach((h) => { const l = +h.tagName[1]; if (prev && l > prev + 1) skips.push(h); prev = l; });
    add('標題層級順序', skips.length ? 'warn' : 'pass', skips.length ? `${skips.length} 處標題跳級（例如 H2 直接到 H4）` : '標題層級連續', skips);
    const emptyH = hs.filter((h) => !textOf(h));
    if (emptyH.length) add('空白標題', 'error', `${emptyH.length} 個標題沒有文字`, emptyH);

    const hasMain = !!body.querySelector('main,[role=main]');
    add('主要內容地標', hasMain ? 'pass' : 'warn', hasMain ? '有 <main> 地標' : '缺少 <main>，不利於快速跳到主要內容');

    const idMap = {};
    $$('[id]').forEach((el) => { (idMap[el.id] = idMap[el.id] || []).push(el); });
    const dups = Object.values(idMap).filter((a) => a.length > 1).flat();
    add('ID 唯一', dups.length ? 'error' : 'pass', dups.length ? `${dups.length} 個元素使用重複的 id` : '所有 id 皆唯一', dups);

    const posTab = $$('[tabindex]', body).filter((el) => parseInt(el.getAttribute('tabindex'), 10) > 0);
    add('Tab 順序', posTab.length ? 'warn' : 'pass', posTab.length ? `${posTab.length} 個元素使用 tabindex > 0，會打亂鍵盤順序` : '未使用正數 tabindex', posTab);

    const frames = $$('iframe', body).filter((f) => !(f.getAttribute('title') || '').trim());
    add('iframe 標題', frames.length ? 'error' : 'pass', frames.length ? `${frames.length} 個 iframe 缺少 title` : '所有 iframe 皆有 title（或無 iframe）', frames);

    const autoplay = $$('video[autoplay]:not([muted]),audio[autoplay]', body);
    add('自動播放', autoplay.length ? 'warn' : 'pass', autoplay.length ? `${autoplay.length} 個媒體會自動播放聲音` : '沒有會自動播放聲音的媒體', autoplay);

    // 文字對比
    const parents = new Set();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let n, guard = 0;
    while ((n = walker.nextNode()) && guard++ < 3000) {
      const p = n.parentElement;
      if (p && !/^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(p.tagName)) parents.add(p);
      if (parents.size >= 1000) break;
    }
    const lowContrast = [...parents].filter((el) => {
      if (!isVisible(el)) return false;
      const c = textContrast(el);
      return !c.hasImage && !c.aa;
    });
    add('文字對比 (AA)', lowContrast.length ? 'error' : 'pass', lowContrast.length ? `${lowContrast.length} 處文字對比不足（一般文字需 4.5:1）` : `抽查 ${parents.size} 個文字區塊皆通過`, lowContrast);

    return C;
  }

  function buildAudit() {
    const order = { error: 0, warn: 1, pass: 2 };
    const checks = runAudit().sort((a, b) => order[a.level] - order[b.level]);
    const cnt = (l) => checks.filter((c) => c.level === l).length;
    const icon = { error: '❌', warn: '⚠️', pass: '✅' };
    return `<div class="score"><b>${cnt('pass')} / ${checks.length}</b> 項通過 ·
        <span class="e">${cnt('error')} 錯誤</span> · <span class="w">${cnt('warn')} 警告</span>
        <div style="font-size:12px;color:#777;margin-top:4px">自動檢測只能發現部分問題，仍建議搭配鍵盤與螢幕閱讀器實測。</div></div>
      ${checks.map((c) => `<details class="chk ${c.level}"${c.level !== 'pass' && c.els.length ? ' open' : ''}>
        <summary><span>${icon[c.level]}</span><span>${esc(c.title)}</span><small>${esc(c.desc)}</small></summary>
        ${c.els.length ? `<ul class="el-list">${c.els.slice(0, 50).map((el) =>
          `<li><button type="button" data-ref="${ref(el)}">${esc(selectorOf(el))}${textOf(el) ? ' — ' + esc(textOf(el).slice(0, 40)) : ''}</button></li>`).join('')}
          ${c.els.length > 50 ? `<li>…另有 ${c.els.length - 50} 個</li>` : ''}</ul>` : ''}
      </details>`).join('')}`;
  }

  /* ------------------------------------------------------------------ *
   * 備註（開啟後在頁面上點兩下新增；可拖曳、編輯、刪除；依頁面網址保存）
   * ------------------------------------------------------------------ */
  const notesKey = () => NOTES_KEY + ':' + location.origin + location.pathname;
  let notes = [];
  let noteDragging = false;
  const saveNotes = () => store.set(notesKey(), notes.filter((n) => n.text.trim()));
  const fmtTime = (t) => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function noteEl(n) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.innerHTML = `<div class="note-head" title="拖曳移動"><span>📝 ${esc(fmtTime(n.time))}</span>
        <button type="button" class="note-del" aria-label="刪除備註">✕</button></div>
      <textarea aria-label="備註內容" placeholder="輸入備註…"></textarea>`;
    el.querySelector('textarea').value = n.text;
    return el;
  }
  function renderNotes() {
    ui.notes.hidden = !settings.notes;
    ui.notes.innerHTML = '';
    if (settings.notes) notes.forEach((n) => ui.notes.appendChild(noteEl(n)));
  }
  function addNote(x, y) {
    const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), text: '', time: Date.now() };
    notes.push(n);
    const el = noteEl(n);
    ui.notes.appendChild(el);
    el.querySelector('textarea').focus({ preventScroll: true });
  }
  function removeNote(el) {
    notes = notes.filter((n) => n.id !== el.dataset.id);
    el.remove();
    saveNotes();
  }
  const noteOf = (el) => notes.find((n) => n.id === el.dataset.id);

  // 清除本頁所有備註（會先確認；skipConfirm 供 API 使用）
  function clearAllNotes(skipConfirm) {
    const count = notes.filter((n) => n.text.trim()).length;
    if (!count) { toast('本頁沒有備註'); return false; }
    if (!skipConfirm && !window.confirm(`確定要刪除本頁的 ${count} 則備註嗎？此動作無法復原。`)) return false;
    notes = [];
    saveNotes();
    renderNotes();
    toast(`已清除 ${count} 則備註`);
    return true;
  }

  function bindNotes() {
    // 點兩下新增
    document.addEventListener('dblclick', (e) => {
      if (!settings.notes || isOwnEvent(e) || isEditable(e.target)) return;
      e.preventDefault();
      const sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
      addNote(e.pageX, e.pageY);
    }, true);

    ui.notes.addEventListener('input', (e) => {
      const el = e.target.closest('.note');
      const n = el && noteOf(el);
      if (n) { n.text = e.target.value; saveNotes(); }
    });
    // 空白備註失焦即移除
    ui.notes.addEventListener('focusout', (e) => {
      if (noteDragging || e.target.tagName !== 'TEXTAREA') return;
      const el = e.target.closest('.note');
      if (el && !e.target.value.trim()) removeNote(el);
    });
    ui.notes.addEventListener('click', (e) => {
      const del = e.target.closest('.note-del');
      if (del) removeNote(del.closest('.note'));
    });
    // 拖曳
    ui.notes.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.note-head');
      if (!head || e.target.closest('.note-del')) return;
      e.preventDefault();
      const el = head.closest('.note');
      const n = noteOf(el);
      const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
      noteDragging = true;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        n.x = Math.max(0, start.nx + ev.clientX - start.x);
        n.y = Math.max(0, start.ny + ev.clientY - start.y);
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';
      };
      const up = () => {
        noteDragging = false;
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        saveNotes();
        el.querySelector('textarea').focus({ preventScroll: true });
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  /* ------------------------------------------------------------------ *
   * 網頁截圖
   *   1. 優先使用同目錄的 h2c.js（HTML → Canvas），需要時才動態載入
   *   2. h2c 失敗時改用 Screen Capture API（需使用者選擇分享分頁）
   * ------------------------------------------------------------------ */
  // 需要的 h2c 最低版本：舊版只繪製 <body>，會漏掉本工具的繪圖筆跡、備註等。
  // 若頁面上已有舊版（或瀏覽器快取了舊檔），帶版本參數重新載入。
  const H2C_MIN = '1.2.3';
  const h2cOk = (h) => {
    if (!h || !h.version) return false;
    const a = h.version.split('.').map(Number), b = H2C_MIN.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
    return true;
  };
  let h2cLoading = null;
  function loadH2C() {
    if (h2cOk(window.h2c)) return Promise.resolve(window.h2c);
    if (!h2cLoading) {
      h2cLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = new URL('h2c.js?v=' + H2C_MIN, SCRIPT_SRC || location.href).href; // 版本參數避開舊快取
        s.onload = () => (h2cOk(window.h2c) ? resolve(window.h2c)
          : reject(new Error('h2c.js 版本過舊（' + ((window.h2c && window.h2c.version) || '未知') + '），請重新整理頁面')));
        s.onerror = () => reject(new Error('無法載入 h2c.js'));
        (document.head || document.documentElement).appendChild(s);
      }).catch((e) => { h2cLoading = null; throw e; });
    }
    return h2cLoading;
  }

  /* ---------- 部分截圖：拖曳選取範圍 ---------- */
  let selecting = null; // { start, rect }

  // 截圖前立刻關閉工具面板：直接結束收合動畫，避免截到滑動到一半的面板
  function closePanelNow() {
    if (panelOpen()) setPanel(false);
    ui.panel.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 無限動畫無法 finish，略過 */ } });
  }

  function startRegionSelect() {
    if (selecting || shooting) return;
    closePanelNow(); // 讓整個畫面都可以框選
    selecting = { start: null, rect: null };
    ui.shotSel.hidden = false;
    ui.shotBox.hidden = true;
    ui.shotHint.textContent = '拖曳選取截圖範圍・Esc 取消';
    refreshButtons();
  }
  function endRegionSelect() {
    selecting = null;
    ui.shotSel.hidden = true;
    refreshButtons();
  }
  function bindRegionSelect() {
    const sel = ui.shotSel;
    const norm = (a, b) => ({
      left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
    });
    sel.addEventListener('pointerdown', (e) => {
      if (!selecting) return;
      e.preventDefault();
      sel.setPointerCapture(e.pointerId);
      selecting.start = { x: e.clientX, y: e.clientY };
    });
    sel.addEventListener('pointermove', (e) => {
      if (!selecting || !selecting.start) return;
      const r = norm(selecting.start, { x: e.clientX, y: e.clientY });
      selecting.rect = r;
      ui.shotBox.hidden = false;
      Object.assign(ui.shotBox.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      ui.shotHint.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    });
    sel.addEventListener('pointerup', () => {
      if (!selecting) return;
      const r = selecting.rect;
      endRegionSelect();
      if (!r || r.width < 8 || r.height < 8) { toast('範圍太小，已取消截圖'); return; }
      const se = document.scrollingElement || document.documentElement;
      // 轉成文件座標交給 h2c
      capture('partial', { x: r.left + se.scrollLeft, y: r.top + se.scrollTop, width: r.width, height: r.height }, r);
    });
  }

  /* ---------- 擷取 ----------
   * 截圖前立刻關閉工具面板；其餘本工具的畫面（浮動按鈕、備註、標籤、繪圖、高亮框…）
   * 都位於 <html> 下的 Shadow DOM，h2c 會一併繪製。
   * 擷取期間另外暫時隱藏「截圖中」提示與選取框本身。 */
  let shooting = false;
  async function capture(kind, region, viewRect) {
    if (shooting) return;
    shooting = true;
    closePanelNow();
    toast(kind === 'full' ? '整頁截圖中…' : '截圖中…');
    // 擷取時暫時隱藏：「截圖中」提示、左下浮動按鈕、繪圖板上方工具列（筆跡本身保留）
    const hideSelf = () => {
      clearTimeout(toastTimer);
      ui.toast.classList.remove('show');
      ui.toast.style.visibility = 'hidden';
      ui.drawBar.style.visibility = 'hidden';
      ui.fab.style.visibility = 'hidden';
    };
    const restoreSelf = () => {
      ui.toast.style.visibility = '';
      ui.drawBar.style.visibility = '';
      ui.fab.style.visibility = '';
    };
    try {
      const h2c = await loadH2C();
      // h2c 讀取的是 computed style（設定後立即生效），不需等待重繪；
      // 不使用 requestAnimationFrame，避免分頁在背景時 rAF 暫停導致截圖卡住
      hideSelf();
      // 解析度：部分截圖 3 倍、整頁 2 倍（至少為螢幕像素比；過大時 h2c 會依瀏覽器上限自動調降）
      const dpr = window.devicePixelRatio || 1;
      const canvas = await h2c(document, kind === 'full'
        ? { mode: 'page', scale: Math.max(2, dpr) }
        : { region, scale: Math.max(3, dpr * 1.5) });
      restoreSelf();
      const blob = await h2c.canvasToBlob(canvas);
      download(blob, `${kind === 'full' ? 'fullpage' : 'screenshot'}-${stamp()}.png`);
      const failed = canvas.h2c.failedResources.length;
      toast(failed ? `截圖已下載（${failed} 個跨網域資源無法擷取）` : '截圖已下載');
    } catch (e) {
      restoreSelf();
      console.warn('[at-pro] h2c 截圖失敗：', e);
      if (kind === 'partial') await screenCapture(viewRect); // 部分截圖可改用螢幕擷取後裁切
      else toast('整頁截圖失敗：' + (e && e.message ? e.message : '未知錯誤'));
    } finally {
      restoreSelf();
      shooting = false;
    }
  }

  // 備援：Screen Capture API（使用者需選擇分享此分頁），可依可視區座標裁切
  async function screenCapture(viewRect) {
    const md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia) { toast('此瀏覽器不支援網頁截圖'); return; }
    let stream;
    try {
      stream = await md.getDisplayMedia({
        video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
      });
    } catch (e) {
      toast('已取消截圖');
      return;
    }
    try {
      ui.toast.style.visibility = 'hidden'; ui.drawBar.style.visibility = 'hidden'; ui.fab.style.visibility = 'hidden';
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 400));
      const k = video.videoWidth / innerWidth; // 影像像素 / CSS 像素
      const r = viewRect || { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(r.width * k);
      canvas.height = Math.round(r.height * k);
      canvas.getContext('2d').drawImage(video, r.left * k, r.top * k, r.width * k, r.height * k, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      download(blob, `screenshot-${stamp()}.png`);
      ui.toast.style.visibility = ''; ui.drawBar.style.visibility = ''; ui.fab.style.visibility = '';
      toast('截圖已下載');
    } catch (e) {
      ui.toast.style.visibility = ''; ui.drawBar.style.visibility = ''; ui.fab.style.visibility = '';
      toast('截圖失敗');
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ------------------------------------------------------------------ *
   * 全螢幕
   * ------------------------------------------------------------------ */
  function toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      return;
    }
    const el = d.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { toast('此瀏覽器不支援全螢幕'); return; }
    Promise.resolve(req.call(el)).catch(() => toast('無法進入全螢幕'));
  }

  /* ------------------------------------------------------------------ *
   * 繪圖板
   * ------------------------------------------------------------------ */
  // 畫布覆蓋整個頁面（full page）。瀏覽器對單一 canvas 尺寸有上限（iOS 約 1,677 萬像素），
  // 所以把頁面切成多條高度 TILE_H 的 canvas 疊起來，筆畫會同時畫到所有經過的分塊。
  const TILE_H = 2048;
  const pen = { color: '#e53935', tool: 'pen', size: 4, down: false, last: null };
  const board = { w: 0, h: 0, dpr: 1, tiles: [] }; // tiles: [{ canvas, ctx, top, height }]

  function docSize() {
    const de = document.documentElement, b = document.body;
    return {
      w: Math.max(de.scrollWidth, b.scrollWidth, de.clientWidth),
      h: Math.max(de.scrollHeight, b.scrollHeight, de.clientHeight),
    };
  }
  // 依頁面大小建立／擴充分塊（只會變大，保留既有筆跡）
  function sizeBoard() {
    const { w, h } = docSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w <= board.w && h <= board.h && dpr === board.dpr) return;
    const nw = Math.max(w, board.w), nh = Math.max(h, board.h);
    const old = board.tiles;
    const tiles = [];
    for (let top = 0; top < nh; top += TILE_H) {
      const height = Math.min(TILE_H, nh - top);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(nw * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.cssText = `top:${top}px;width:${nw}px;height:${height}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      old.forEach((o) => {
        if (o.top < top + height && o.top + o.height > top) ctx.drawImage(o.canvas, 0, o.top - top, board.w, o.height);
      });
      tiles.push({ canvas, ctx, top, height });
    }
    ui.drawLayer.replaceChildren(...tiles.map((t) => t.canvas));
    ui.drawLayer.style.width = nw + 'px';
    ui.drawLayer.style.height = nh + 'px';
    Object.assign(board, { w: nw, h: nh, dpr, tiles });
  }
  function toggleDraw(force) {
    drawOpen = typeof force === 'boolean' ? force : !drawOpen;
    ui.drawLayer.hidden = ui.drawBar.hidden = !drawOpen;
    if (drawOpen) {
      sizeBoard();
      setPanel(false);
      toast('繪圖板已開啟（整頁），可捲動到任何位置作畫；Esc 或「關閉」結束');
    }
    refreshButtons();
  }
  function strokeTo(x, y) {
    const width = pen.tool === 'marker' ? pen.size * 4 : pen.tool === 'eraser' ? pen.size * 5 : pen.size;
    const minY = Math.min(pen.last.y, y) - width, maxY = Math.max(pen.last.y, y) + width;
    board.tiles.forEach((t) => {
      if (t.top > maxY || t.top + t.height < minY) return;
      const ctx = t.ctx;
      ctx.globalCompositeOperation = pen.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.globalAlpha = pen.tool === 'marker' ? 0.35 : 1;
      ctx.strokeStyle = pen.color;
      ctx.lineWidth = width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pen.last.x, pen.last.y - t.top);
      ctx.lineTo(x, y - t.top);
      ctx.stroke();
    });
    pen.last = { x, y };
  }
  // 把所有分塊合成一張整頁 PNG（超過瀏覽器上限時等比例縮小）
  function saveBoard() {
    const MAX_AREA = 16000000, MAX_DIM = 16384;
    const scale = Math.min(board.dpr, Math.sqrt(MAX_AREA / (board.w * board.h)), MAX_DIM / board.w, MAX_DIM / board.h);
    const out = document.createElement('canvas');
    out.width = Math.floor(board.w * scale);
    out.height = Math.floor(board.h * scale);
    const octx = out.getContext('2d');
    octx.scale(scale, scale);
    board.tiles.forEach((t) => octx.drawImage(t.canvas, 0, t.top, board.w, t.height));
    out.toBlob((blob) => (blob ? download(blob, `drawing-${stamp()}.png`) : toast('下載失敗')), 'image/png');
  }
  function bindDraw() {
    const layer = ui.drawLayer;
    const pos = (e) => { const r = layer.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    layer.addEventListener('pointerdown', (e) => {
      pen.down = true;
      layer.setPointerCapture(e.pointerId);
      pen.last = pos(e);
      strokeTo(pen.last.x + 0.01, pen.last.y + 0.01);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!pen.down) return;
      const p = pos(e);
      strokeTo(p.x, p.y);
    });
    const up = () => { pen.down = false; };
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);

    ui.drawBar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) {
        pen.color = b.dataset.color;
        if (pen.tool === 'eraser' || pen.tool === 'scroll') setTool('pen');
        ui.drawBar.querySelectorAll('.color').forEach((x) => x.setAttribute('aria-pressed', x === b));
      } else if (b.dataset.tool) {
        setTool(b.dataset.tool);
      } else if (b.dataset.act === 'clear') {
        board.tiles.forEach((t) => { t.ctx.save(); t.ctx.setTransform(1, 0, 0, 1, 0, 0); t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height); t.ctx.restore(); });
        toast('已清除整頁繪圖');
      } else if (b.dataset.act === 'save') {
        saveBoard();
      } else if (b.dataset.act === 'close') {
        toggleDraw(false);
      }
    });
    ui.drawSize.addEventListener('input', (e) => { pen.size = +e.target.value; });

    // 頁面內容變長（延遲載入等）時自動擴充畫布
    if (window.ResizeObserver) new ResizeObserver(() => { if (drawOpen) sizeBoard(); }).observe(document.body);
  }
  function setTool(t) {
    pen.tool = t;
    ui.drawLayer.classList.toggle('pass', t === 'scroll'); // 「捲動」模式：暫停作畫，可操作／觸控捲動頁面
    ui.drawBar.querySelectorAll('[data-tool]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tool === t));
  }

  /* ------------------------------------------------------------------ *
   * 面板控制
   * ------------------------------------------------------------------ */
  // focusFirst：只有用鍵盤（Enter / 空白鍵）開啟時才把焦點移到第一顆按鈕；
  // 滑鼠點擊開啟時不移動焦點，避免 Safari 在「文字放大」按鈕上顯示焦點黃框
  function setPanel(open, focusFirst) {
    ui.panel.classList.toggle('open', open);
    ui.fab.setAttribute('aria-expanded', String(open));
    ui.fab.setAttribute('aria-label', open ? '關閉無障礙選單' : '開啟無障礙選單');
    if (open && focusFirst) setTimeout(() => { const f = ui.grid.querySelector('.btn'); if (f) f.focus({ preventScroll: true }); }, 50);
  }
  const panelOpen = () => ui.panel.classList.contains('open');

  function refreshButtons() {
    ui.grid.querySelectorAll('.btn').forEach((btn) => {
      const id = btn.dataset.id;
      if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(isActive(id)));
      if (id in CYCLES) {
        btn.querySelectorAll('.pips i').forEach((p, i) => p.classList.toggle('on', i < settings[id]));
      }
    });
  }

  function save() { store.set(STORE_KEY, settings); }

  function applyAll() {
    applyPageStyle();
    applyFontScale();
    updateReadingAids();
    renderLabels();
    renderNotes();
    refreshButtons();
  }

  function onButton(id, label) {
    const short = label.replace(/\s*\(.*\)$/, '');
    if (id in CYCLES) {
      settings[id] = (settings[id] + 1) % CYCLES[id].values.length;
      if (id === 'fontScale') applyFontScale(); else applyPageStyle();
      scheduleLabels();
      toast(settings[id] ? `${label}：${CYCLES[id].fmt(cyc(id))}` : `${label}：已恢復預設`);
      save();
    } else if (id === 'cursorWhite' || id === 'cursorBlack') {
      const c = id === 'cursorWhite' ? 'white' : 'black';
      settings.cursor = settings.cursor === c ? null : c;
      applyPageStyle();
      save();
    } else if (id in DEFAULTS) {
      settings[id] = !settings[id];
      save();
      if (id === 'readingGuide' || id === 'readingMask') updateReadingAids();
      else if (id === 'showLabels') renderLabels();
      else if (id === 'keyNav') {
        if (!settings.keyNav) { navEl = null; navWord = null; updateTracked(); }
        speak(settings.keyNav ? '開啟語音' : '關閉語音');
      } else if (id === 'notes') {
        renderNotes();
      } else applyPageStyle();
      const msg = id === 'notes' && settings.notes
        ? `備註：開啟，在頁面任一處點兩下新增${notes.length ? `（本頁已有 ${notes.length} 則）` : ''}`
        : `${short}：${settings[id] ? '開啟' : '關閉'}`;
      toast(msg);
    } else {
      switch (id) {
        case 'colorCheck': case 'measure': case 'layers': setHoverMode(id); break;
        case 'partialShot': if (selecting) endRegionSelect(); else startRegionSelect(); break;
        case 'fullShot': capture('full'); break;
        case 'clearNotes': clearAllNotes(); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'draw': toggleDraw(); break;
        case 'textTree': case 'imageReview': case 'audit': case 'cssColors': case 'zIndex': openInfo(id); break;
      }
    }
    refreshButtons();
  }

  function reset() {
    settings = Object.assign({}, DEFAULTS);
    if (zMarks) setZMarks(false);
    hoverMode = null;
    hoverEl = null;
    hideHover();
    closeInfo();
    toggleDraw(false);
    navEl = null; navWord = null;
    if (window.speechSynthesis) speechSynthesis.cancel();
    save();
    applyAll();
    updateTracked();
    toast('已恢復所有預設設定');
  }

  function handleEscape() {
    if (selecting) { endRegionSelect(); toast('已取消截圖'); return true; }
    const active = root.activeElement;
    if (active && active.closest && active.closest('.note')) { active.blur(); return true; }
    if (drawOpen) return toggleDraw(false), true;
    if (infoOpen) return closeInfo(), true;
    if (zMarks) { setZMarks(false); toast('已取消 z-index 標示'); return true; }
    if (hoverMode) return setHoverMode(hoverMode), refreshButtons(), true;
    if (navEl) { navEl = null; navWord = null; updateTracked(); if (window.speechSynthesis) speechSynthesis.cancel(); return true; }
    if (panelOpen()) { setPanel(false); ui.fab.focus(); return true; }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */
  function bindEvents() {
    // 滑鼠離開左側面板 → 自動收合（僅限滑鼠；移到浮動按鈕上不算離開；300ms 內移回會取消）
    // hovered：本次展開後滑鼠是否進入過面板，避免剛點完浮動按鈕、還沒進面板就被收合
    let leaveTimer = 0, hovered = false;
    const cancelLeave = () => { clearTimeout(leaveTimer); leaveTimer = 0; };
    // e.detail === 0 表示由鍵盤觸發的 click（滑鼠點擊時 detail ≥ 1）
    ui.fab.addEventListener('click', (e) => { hovered = false; cancelLeave(); setPanel(!panelOpen(), e.detail === 0); });
    const scheduleLeave = (e) => {
      if (e.pointerType !== 'mouse' || !panelOpen() || !hovered) return;
      cancelLeave();
      leaveTimer = setTimeout(() => { hovered = false; setPanel(false); }, 300);
    };
    ui.panel.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovered = true; cancelLeave(); } });
    ui.fab.addEventListener('pointerenter', cancelLeave);
    ui.panel.addEventListener('pointerleave', (e) => {
      if (e.relatedTarget === ui.fab || ui.fab.contains(e.relatedTarget)) return;
      scheduleLeave(e);
    });
    ui.fab.addEventListener('pointerleave', (e) => {
      if (e.relatedTarget && (e.relatedTarget === ui.panel || ui.panel.contains(e.relatedTarget))) return;
      scheduleLeave(e);
    });
    ui.reset.addEventListener('click', reset);
    ui.panelClose.addEventListener('click', () => { setPanel(false); ui.fab.focus(); });
    ui.grid.addEventListener('click', (e) => {
      const b = e.target.closest('.btn');
      if (b) onButton(b.dataset.id, BUTTONS.find((x) => x.id === b.dataset.id).label);
    });

    // 目前是鍵盤還是滑鼠操作（決定開啟面板時是否移動焦點）
    root.addEventListener('keydown', () => { keyboardMode = true; }, true);
    root.addEventListener('pointerdown', () => { keyboardMode = false; }, true);

    // 資訊面板
    ui.infoClose.addEventListener('click', closeInfo);
    // 滑鼠離開右側面板 → 往右自動收合（僅限滑鼠；需先進入過面板；300ms 內移回會取消）
    let infoLeaveTimer = 0, infoHovered = false;
    const cancelInfoLeave = () => { clearTimeout(infoLeaveTimer); infoLeaveTimer = 0; };
    ui.info.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { infoHovered = true; cancelInfoLeave(); } });
    ui.info.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse' || !infoOpen || !infoHovered) return;
      cancelInfoLeave();
      infoLeaveTimer = setTimeout(() => { infoHovered = false; if (infoOpen) closeInfo(); }, 300);
    });
    ui.infoActions.addEventListener('click', (e) => {
      if (e.target.dataset.act === 'refresh' && infoOpen) { const k = infoOpen; infoOpen = null; openInfo(k); }
    });
    const pick = (e) => {
      const t = e.target.closest('[data-ref]');
      if (t && t.dataset.ref !== '' && !isNaN(t.dataset.ref)) locate(infoRefs[+t.dataset.ref]);
    };
    ui.infoBody.addEventListener('click', pick);
    ui.infoBody.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
    // CSS 用色檢查：複製色碼、篩選、排序、定位
    ui.infoBody.addEventListener('click', (e) => {
      const t = e.target.closest('[data-copy],[data-cfilter],[data-csort],[data-cloc],[data-zfilter],[data-zmark]');
      if (!t) return;
      if (t.dataset.copy) copyText(t.dataset.copy);
      else if (t.dataset.cfilter) { ccFilter = t.dataset.cfilter; ccRerender(); }
      else if (t.dataset.csort) { ccSort = t.dataset.csort; ccRerender(); }
      else if (t.dataset.cloc) ccLocate(t.dataset.cloc);
      else if (t.dataset.zfilter) { const v = t.dataset.zfilter; zFilter = (v !== 'all' && zFilter === v) ? 'all' : v; zRerender(); if (zMarks) buildZMarks(); }
      else if (t.hasAttribute('data-zmark')) { setZMarks(!zMarks); toast(zMarks ? '已在頁面上標示 z-index 元素（Esc 取消）' : '已取消 z-index 標示'); }
    });

    bindNotes();
    bindDraw();
    bindRegionSelect();

    // 滑鼠
    window.addEventListener('pointermove', (e) => {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true;
      if (settings.readingGuide || settings.readingMask) updateReadingAids();
      if (!hoverMode) return;
      if (isOwnEvent(e)) { hoverEl = null; hideHover(); return; }
      hoverEl = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      renderHover();
    }, { passive: true });

    // 用色查核 / 元素量測時，點擊頁面＝複製資訊而非觸發連結
    document.addEventListener('click', (e) => {
      if ((hoverMode === 'colorCheck' || hoverMode === 'measure') && !isOwnEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        const text = ui.tip.innerText;
        if (navigator.clipboard && text) navigator.clipboard.writeText(text).then(() => toast('已複製到剪貼簿'), () => toast('無法複製'));
      }
    }, true);

    // 捲動 / 尺寸
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (hoverMode) {
          const el = document.elementFromPoint(mouse.x, mouse.y);
          hoverEl = el && el !== host ? el : null;
        }
        updateTracked();
      });
    };
    window.addEventListener('scroll', onMove, { passive: true, capture: true });
    window.addEventListener('resize', () => { onMove(); scheduleLabels(); if (drawOpen) sizeBoard(); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, refreshButtons));

    // 動態內容：新加入的元素也套用文字放大、更新標籤
    new MutationObserver((muts) => {
      const scale = cyc('fontScale');
      let changed = false;
      muts.forEach((m) => m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1 || node === host || node === ui.pageStyle) return;
        changed = true;
        if (scale !== 1 && document.body.contains(node)) scaleEls([node, ...node.querySelectorAll('*')], scale);
      }));
      if (changed) scheduleLabels();
    }).observe(document.body, { childList: true, subtree: true });

    // 鍵盤
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (handleEscape()) e.preventDefault(); return; }
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.composedPath ? e.composedPath()[0] : e.target;
      if (isEditable(target)) return;
      if (e.code === 'KeyX') { e.preventDefault(); onButton('notes', '備註'); return; }
      if (settings.keyNav && (e.code === 'KeyZ' || e.code === 'KeyA')) {
        e.preventDefault();
        navMove(e.code === 'KeyZ' ? 1 : -1);
        return;
      }
      if (settings.keyNav) {
        const m = e.code.match(/^(?:Digit|Numpad)([1-6])$/);
        if (m) { e.preventDefault(); headingJump(+m[1]); }
      }
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */
  function init() {
    buildUI();
    notes = store.get(notesKey(), []);
    bindEvents();
    applyAll();
    if (CFG.openOnLoad) setPanel(true);
    window.ATPro = {
      open: () => setPanel(true),
      close: () => setPanel(false),
      toggle: () => setPanel(!panelOpen()),
      reset,
      audit: runAudit,
      getSettings: () => Object.assign({}, settings),
      notes: () => notes.filter((n) => n.text.trim()).map((n) => Object.assign({}, n)),
      clearNotes: () => clearAllNotes(true),
    };
  }

  window.ATPro = { pending: true };
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
