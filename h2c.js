/*!
 * h2c.js — HTML to Canvas（純 JavaScript，無相依套件）
 *
 * 原理：
 *   1. 複製 DOM，並把每個元素的 computed style 寫成 inline style（只寫與瀏覽器預設不同的屬性）
 *   2. 圖片、背景圖、網頁字型轉成 data URL 內嵌（字型只內嵌頁面實際用到的字元區段）
 *   3. 包進 SVG <foreignObject>，以 <img> 載入後畫到 <canvas>
 *
 * 用法：
 *   const canvas = await h2c();                                   // 目前可視區（預設）
 *   const canvas = await h2c(document, { mode: 'page' });         // 整頁
 *   const canvas = await h2c(document.querySelector('.card'));    // 單一元素
 *   const blob   = await h2c.toBlob(target, options);             // PNG Blob
 *   const url    = await h2c.toDataURL(target, options);          // PNG data URL
 *   await h2c.download(target, 'screenshot.png', options);        // 直接下載
 *
 * options：
 *   mode            'viewport' | 'page'   target 為 document / <html> / <body> 時有效，預設 'viewport'
 *   region          { x, y, width, height } 文件座標的任意範圍（部分截圖），優先於 mode
 *   （頁面模式會繪製 <html> 底下所有元素，包含掛在 <html> 上、<body> 以外的 Shadow DOM 工具列）
 *   scale           輸出倍率，預設 max(2, devicePixelRatio)（超過瀏覽器 canvas 上限時自動降低）
 *   backgroundColor 背景色；頁面模式預設取頁面背景，元素模式預設透明；傳 null 為透明
 *   ignore(el)      回傳 true 的元素不繪製（也可在元素加上 data-h2c-ignore 屬性）
 *   imageTimeout    單一圖片／字型的載入逾時（毫秒），預設 8000
 *   fonts           是否內嵌網頁字型，預設 true
 *   scaleMethod     放大方式 'zoom' | 'transform'，預設自動（支援 zoom 時用 zoom）
 *
 * 回傳的 canvas 帶有 canvas.h2c = { x, y, width, height, scale }（擷取範圍的文件座標與倍率）
 *
 * 限制：
 *   - 跨網域且未開放 CORS 的圖片／字型無法內嵌（圖片會留白）；以 file:// 開啟頁面時無法讀取本機圖片
 *   - 跨網域 iframe 以灰色區塊代替
 *   - 內部捲動容器的捲動位置以 CSS translate 近似；CSS 動畫以擷取當下狀態定格
 *   - 部分舊版 Safari 會將含 foreignObject 的 SVG 視為污染來源，導致無法輸出圖片
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'SOURCE', 'TRACK']);
  const SKIP_PROPS = /^(--|transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|caret-color)/;
  const PSEUDOS = ['::before', '::after'];
  // canvas 尺寸上限：iOS 約 16.7M 像素；桌面瀏覽器可更大（另考量記憶體，取 64M 像素）
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const MAX_PIXELS = isIOS ? 16000000 : 64000000;
  const MAX_DIM = isIOS ? 16384 : 32767;
  const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const XML_NAME = /^[A-Za-z_][\w.-]*$/;
  const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]+))\s*\)/g;
  const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, delay(ms).then(() => { throw new Error('timeout'); })]);
  const cleanFamily = (f) => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const isTransparent = (c) => !c || c === 'transparent' || /rgba?\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const blobToDataURL = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

  /* ------------------------------------------------------------------ *
   * 瀏覽器預設樣式（以隱藏 iframe 取得，用來精簡 inline style）
   * ------------------------------------------------------------------ */
  let sandbox = null;
  const defaultsCache = new Map();
  function sandboxDoc() {
    if (!sandbox || !sandbox.isConnected) {
      sandbox = document.createElement('iframe');
      sandbox.setAttribute('aria-hidden', 'true');
      sandbox.setAttribute('data-h2c-ignore', '');
      sandbox.tabIndex = -1;
      sandbox.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none';
      document.documentElement.appendChild(sandbox);
      const d = sandbox.contentDocument;
      d.open();
      d.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>');
      d.close();
    }
    return sandbox.contentDocument;
  }
  function removeSandbox() {
    if (sandbox) { sandbox.remove(); sandbox = null; }
  }
  function defaultStyle(el) {
    const isSvg = el.namespaceURI === SVG_NS;
    const tag = el.localName;
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const key = (isSvg ? 'svg:' : '') + tag + (type ? ':' + type : '');
    let d = defaultsCache.get(key);
    if (d) return d;
    const doc = sandboxDoc();
    const probe = isSvg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    if (type) probe.setAttribute('type', type);
    let holder = probe;
    if (isSvg && tag !== 'svg') { holder = doc.createElementNS(SVG_NS, 'svg'); holder.appendChild(probe); }
    doc.body.appendChild(holder);
    const cs = doc.defaultView.getComputedStyle(probe);
    d = {};
    for (let i = 0; i < cs.length; i++) d[cs[i]] = cs.getPropertyValue(cs[i]);
    holder.remove();
    defaultsCache.set(key, d);
    return d;
  }

  // 只輸出「與預設不同」或「與父元素不同」的屬性（後者確保繼承屬性正確）
  function styleDiff(cs, base, parent) {
    let s = '';
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      if (SKIP_PROPS.test(p)) continue;
      const v = cs.getPropertyValue(p);
      if (base && v === base[p] && (!parent || v === parent.getPropertyValue(p))) continue;
      s += p + ':' + v + ';';
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 資源內嵌（圖片、字型 → data URL）
   * ------------------------------------------------------------------ */
  const resourceCache = new Map();
  async function fetchAsDataURL(url) {
    const u = new URL(url, document.baseURI);
    const same = u.origin === location.origin || u.protocol === 'blob:';
    const res = await fetch(u.href, { mode: same ? 'same-origin' : 'cors', credentials: same ? 'include' : 'omit', cache: 'force-cache' });
    if (!res.ok) throw new Error(String(res.status));
    return blobToDataURL(await res.blob());
  }
  function toDataURL(url, ctx) {
    if (!url) return Promise.resolve(null);
    if (url.startsWith('data:')) return Promise.resolve(url);
    if (resourceCache.has(url)) return resourceCache.get(url);
    const p = withTimeout(fetchAsDataURL(url), ctx.timeout).catch(() => {
      ctx.failed.add(url);
      return null;
    });
    resourceCache.set(url, p);
    // 失敗的資源不要永久快取，下次可重試
    p.then((v) => { if (!v) resourceCache.delete(url); });
    return p;
  }
  async function inlineCssUrls(text, ctx, base) {
    const urls = new Set();
    text.replace(URL_RE, (m, a, b, c) => { const u = a || b || c; if (u && !u.startsWith('data:')) urls.add(u); return m; });
    if (!urls.size) return text;
    const map = new Map(await Promise.all([...urls].map(async (u) => {
      let abs;
      try { abs = new URL(u, base || document.baseURI).href; } catch (e) { return [u, null]; }
      return [u, await toDataURL(abs, ctx)];
    })));
    return text.replace(URL_RE, (m, a, b, c) => {
      const d = map.get(a || b || c);
      return d ? 'url("' + d + '")' : m;
    });
  }

  /* ---------- 字型 ---------- */
  function parseRanges(ur) {
    return ur.split(',').map((s) => s.trim().replace(/^u\+/i, '')).filter(Boolean).map((s) => {
      if (s.includes('?')) return [parseInt(s.replace(/\?/g, '0'), 16), parseInt(s.replace(/\?/g, 'F'), 16)];
      const [a, b] = s.split('-');
      return [parseInt(a, 16), parseInt(b || a, 16)];
    });
  }
  function rangeUsed(ur, codePoints) {
    if (!ur) return true;
    const ranges = parseRanges(ur);
    for (const cp of codePoints) for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
    return false;
  }
  async function fontFaceCss(block, base, ctx) {
    const fam = (block.match(/font-family\s*:\s*([^;]+)/i) || [])[1];
    if (!fam || !ctx.families.has(cleanFamily(fam))) return '';
    const ur = (block.match(/unicode-range\s*:\s*([^;]+)/i) || [])[1];
    if (!rangeUsed(ur, ctx.codePoints)) return '';
    const src = (block.match(/src\s*:\s*([^;]+)/i) || [])[1];
    if (!src) return '';
    const urls = [...src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*(format\([^)]*\))?/g)];
    if (!urls.length) return '';
    const pick = urls.find((u) => /woff2/i.test(u[3] || u[2])) || urls[0];
    const data = await toDataURL(new URL(pick[2], base).href, ctx);
    if (!data) return '';
    const decls = block.replace(/src\s*:[^;]+;?/i, '').trim();
    return '@font-face{' + decls + (decls.endsWith(';') || !decls ? '' : ';') + 'src:url("' + data + '")' + (pick[3] ? ' ' + pick[3] : '') + ';}';
  }
  async function collectSheet(sheet, ctx, out, depth) {
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { rules = null; }
    const base = sheet.href || document.baseURI;
    if (rules) {
      for (const rule of Array.from(rules)) {
        if (rule.type === 3 /* IMPORT */ && rule.styleSheet && depth < 4) await collectSheet(rule.styleSheet, ctx, out, depth + 1);
        else if (rule.type === 5 /* FONT_FACE */) {
          const m = rule.cssText.match(/\{([\s\S]*)\}/);
          if (m) out.push(fontFaceCss(m[1], base, ctx));
        }
      }
    } else if (sheet.href) {
      // 跨網域樣式表（如 Google Fonts）：改以 fetch 取得文字再解析
      try {
        const text = await withTimeout(fetch(sheet.href, { mode: 'cors' }).then((r) => (r.ok ? r.text() : '')), ctx.timeout);
        for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) out.push(fontFaceCss(m[1], sheet.href, ctx));
      } catch (e) { /* 無法讀取則略過 */ }
    }
  }
  async function embedFonts(ctx) {
    const out = [];
    for (const sheet of Array.from(document.styleSheets)) await collectSheet(sheet, ctx, out, 0);
    return (await Promise.all(out)).filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 定位處理
   * ------------------------------------------------------------------ */
  // 祖先是否會成為 position:fixed 的包含區塊（transform、filter…）
  function createsFixedCB(cs) {
    return cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
      || (cs.backdropFilter && cs.backdropFilter !== 'none')
      || /paint|layout|strict|content/.test(cs.contain || '')
      || /transform|filter|perspective/.test(cs.willChange || '');
  }
  // 往上找父元素；遇到 Shadow Root 時跳到其宿主元素（host）
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  function hasFixedCBAncestor(el, win) {
    for (let p = parentOf(el); p; p = parentOf(p)) if (createsFixedCB(win.getComputedStyle(p))) return true;
    return false;
  }
  function positionedAncestor(el, dc, win) {
    for (let p = parentOf(el); p; p = parentOf(p)) {
      if (p === dc.stop) return dc.stopIsCB ? p : null;
      if (win.getComputedStyle(p).position !== 'static') return p;
    }
    return null;
  }
  // sticky：暫時改為 static 量出原始位置，算出目前的黏著位移
  function stickyOffset(el) {
    const r1 = el.getBoundingClientRect();
    const prev = el.style.getPropertyValue('position'), pri = el.style.getPropertyPriority('position');
    el.style.setProperty('position', 'static', 'important');
    const r0 = el.getBoundingClientRect();
    if (prev) el.style.setProperty('position', prev, pri); else el.style.removeProperty('position');
    return { x: r1.left - r0.left, y: r1.top - r0.top };
  }

  /* ------------------------------------------------------------------ *
   * DOM 複製
   * ------------------------------------------------------------------ */
  function finalizeStyle(clone, style, ctx, base) {
    clone.setAttribute('style', style);
    if (style.includes('url(')) ctx.tasks.push(inlineCssUrls(style, ctx, base).then((s) => clone.setAttribute('style', s)));
  }
  function addPseudos(el, clone, cs, ctx, win) {
    for (const p of PSEUDOS) {
      const ps = win.getComputedStyle(el, p);
      const content = ps.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') continue;
      const cls = 'h2c-' + (ctx.uid++).toString(36);
      clone.setAttribute('class', ((clone.getAttribute('class') || '') + ' ' + cls).trim());
      ctx.css.push('.' + cls + p + '{' + styleDiff(ps, ctx.spanDefaults || (ctx.spanDefaults = defaultStyle(ctx.doc.createElement('span'))), cs) + '}');
    }
  }
  function imageFrom(fn, fallbackUrl, ctx) {
    const img = ctx.doc.createElement('img');
    let src = null;
    try { src = fn(); } catch (e) { src = null; }
    img.setAttribute('src', src || BLANK_IMG);
    if (!src && fallbackUrl) ctx.tasks.push(toDataURL(fallbackUrl, ctx).then((d) => d && img.setAttribute('src', d)));
    return img;
  }

  function cloneTree(node, ctx, parentCS, extraStyle, dc) {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(INVALID_XML_CHARS, '');
      for (const ch of t) ctx.codePoints.add(ch.codePointAt(0));
      return ctx.doc.createTextNode(t);
    }
    if (node.nodeType !== 1) return null;
    const el = node;
    const TAG = el.localName.toUpperCase();
    if (SKIP_TAGS.has(TAG) || el.hasAttribute('data-h2c-ignore') || (ctx.ignore && ctx.ignore(el))) return null;
    const win = el.ownerDocument.defaultView;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') return null;
    const tag = el.localName;
    const isSvg = el.namespaceURI === SVG_NS;
    const isRoot = el === ctx.rootEl;
    cs.fontFamily.split(',').forEach((f) => ctx.families.add(cleanFamily(f)));

    // 建立複本（canvas / video 轉成圖片；iframe 轉成 div）
    let clone, skipChildren = false, extra = extraStyle || '';
    if (tag === 'canvas') {
      clone = imageFrom(() => el.toDataURL(), null, ctx);
      skipChildren = true;
    } else if (tag === 'video') {
      clone = imageFrom(() => {
        if (!el.videoWidth) return null;
        const c = document.createElement('canvas');
        c.width = el.videoWidth; c.height = el.videoHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        return c.toDataURL();
      }, el.poster, ctx);
      extra += 'object-fit:' + cs.objectFit + ';';
      skipChildren = true;
    } else if (tag === 'iframe') {
      clone = cloneIframe(el, ctx);
      extra += 'overflow:hidden;' + (clone.hasAttribute('data-h2c-placeholder') ? 'background:#e5e5e5;' : '');
      skipChildren = true;
    } else {
      clone = ctx.doc.importNode(el, false); // 匯入到空白文件，避免觸發 custom element
      for (const a of Array.from(clone.attributes)) {
        if (a.name === 'style' || /^on/i.test(a.name) || (!a.namespaceURI && !XML_NAME.test(a.name))) clone.removeAttribute(a.name);
      }
    }

    // 各類元素的狀態
    if (tag === 'img') {
      ['srcset', 'sizes', 'loading', 'decoding'].forEach((a) => clone.removeAttribute(a));
      const src = el.currentSrc || el.src;
      clone.setAttribute('src', BLANK_IMG);
      if (src) ctx.tasks.push(toDataURL(src, ctx).then((d) => clone.setAttribute('src', d || BLANK_IMG)));
    } else if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) clone.setAttribute('checked', ''); else clone.removeAttribute('checked');
      } else if (el.type !== 'file' && el.type !== 'password') {
        clone.setAttribute('value', el.value);
      }
    } else if (tag === 'textarea') {
      clone.textContent = el.value;
      skipChildren = true;
    } else if (isSvg && tag === 'image') {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
      if (href) {
        ctx.tasks.push(toDataURL(new URL(href, document.baseURI).href, ctx).then((d) => {
          if (!d) return;
          clone.setAttribute('href', d);
          clone.setAttributeNS(XLINK_NS, 'xlink:href', d);
        }));
      }
    } else if (isSvg && tag === 'use') {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href') || '';
      if (href.startsWith('#')) ctx.useRefs.add(href.slice(1));
    }

    // 樣式
    let style = styleDiff(cs, defaultStyle(clone), parentCS);

    if (!isRoot && dc.boxFixed && cs.position === 'fixed' && !hasFixedCBAncestor(el, win)) {
      // 固定定位：包一層「視窗大小」的盒子，放在擷取當下的視窗位置
      const P = positionedAncestor(el, dc, win);
      const pr = P ? P.getBoundingClientRect() : null;
      const pDocX = P ? pr.left + dc.sx + P.clientLeft : dc.originX;
      const pDocY = P ? pr.top + dc.sy + P.clientTop : dc.originY;
      const box = ctx.doc.createElement('div');
      // overflow:hidden 模擬視窗裁切：位於視窗外的 fixed 元素（隱藏的 toast、收合的側欄）不會出現
      box.setAttribute('style', 'position:absolute;margin:0;padding:0;border:0;overflow:hidden;'
        + 'left:' + (dc.fixedAt.x - pDocX) + 'px;top:' + (dc.fixedAt.y - pDocY) + 'px;'
        + 'width:' + dc.vw + 'px;height:' + dc.vh + 'px;transform:translate(0,0);z-index:' + cs.zIndex + ';');
      finishElement(el, clone, cs, style + extra, ctx, dc, win, skipChildren);
      box.appendChild(clone);
      return box;
    }
    if (!isRoot && (cs.position === 'sticky' || cs.position === '-webkit-sticky')) {
      // 整頁模式：sticky 元素畫在原本位置（等同捲動到最上方）；其餘模式畫在目前黏著的位置
      const o = dc.page ? { x: 0, y: 0 } : stickyOffset(el);
      extra += 'position:relative;left:' + o.x + 'px;top:' + o.y + 'px;right:auto;bottom:auto;';
    }
    finishElement(el, clone, cs, style + extra, ctx, dc, win, skipChildren);
    return clone;
  }

  function finishElement(el, clone, cs, style, ctx, dc, win, skipChildren) {
    finalizeStyle(clone, style, ctx);
    addPseudos(el, clone, cs, ctx, win);
    if (skipChildren) return;
    // 內部捲動容器：以 translate 位移子元素模擬捲動位置
    const shift = (el.scrollTop || el.scrollLeft) ? 'translate:' + (-el.scrollLeft) + 'px ' + (-el.scrollTop) + 'px;' : '';
    let kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    if (el.localName === 'slot' && el.assignedNodes) {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) kids = assigned;
    }
    for (const k of Array.from(kids)) {
      const c = cloneTree(k, ctx, cs, k.nodeType === 1 ? shift : '', dc);
      if (c) clone.appendChild(c);
    }
    if (el.localName === 'select') {
      const opts = clone.querySelectorAll('option');
      Array.from(el.options).forEach((o, i) => {
        if (!opts[i]) return;
        if (o.selected) opts[i].setAttribute('selected', ''); else opts[i].removeAttribute('selected');
      });
    }
  }

  // 整份文件（<html> + <body>）→ div 結構
  function buildDocument(doc, ctx, dc, W, H, ox, oy, docW, docH) {
    const win = doc.defaultView, de = doc.documentElement, body = doc.body;
    const hcs = win.getComputedStyle(de), bcs = win.getComputedStyle(body);
    const root = ctx.doc.createElement('div');
    let rootStyle = styleDiff(hcs, null, null);
    if (isTransparent(hcs.backgroundColor) && !isTransparent(bcs.backgroundColor)) rootStyle += 'background-color:' + bcs.backgroundColor + ';';
    rootStyle += 'margin:0;padding:0;border:0;position:relative;overflow:hidden;transform:none;filter:none;'
      + 'width:' + W + 'px;height:' + H + 'px;';
    finalizeStyle(root, rootStyle, ctx);

    const inner = ctx.doc.createElement('div');
    inner.setAttribute('style', 'position:absolute;left:0;top:0;margin:0;padding:0;border:0;'
      + 'width:' + docW + 'px;height:' + docH + 'px;transform:translate(' + (-ox) + 'px,' + (-oy) + 'px);');

    const b = ctx.doc.createElement('div');
    finalizeStyle(b, styleDiff(bcs, null, null), ctx);
    addPseudos(body, b, bcs, ctx, win);
    bcs.fontFamily.split(',').forEach((f) => ctx.families.add(cleanFamily(f)));
    for (const k of Array.from(body.childNodes)) {
      const c = cloneTree(k, ctx, bcs, '', dc);
      if (c) b.appendChild(c);
    }
    inner.appendChild(b);
    // <html> 底下、<body> 以外的元素（例如掛在 <html> 上的工具列 Shadow DOM）也一併繪製，順序與原頁面相同
    let afterBody = false;
    for (const k of Array.from(de.children)) {
      if (k === body) { afterBody = true; continue; }
      const c = cloneTree(k, ctx, hcs, '', dc);
      if (!c) continue;
      if (afterBody) inner.appendChild(c); else inner.insertBefore(c, b);
    }
    root.appendChild(inner);
    return root;
  }

  function cloneIframe(el, ctx) {
    const box = ctx.doc.createElement('div');
    let d = null;
    try { d = el.contentDocument; } catch (e) { d = null; }
    if (d && d.body && d.defaultView) {
      const de = d.documentElement, se = d.scrollingElement || de;
      const w = de.clientWidth, h = de.clientHeight;
      const dW = Math.max(de.scrollWidth, d.body.scrollWidth, w), dH = Math.max(de.scrollHeight, d.body.scrollHeight, h);
      const dc = {
        sx: se.scrollLeft, sy: se.scrollTop, vw: w, vh: h, fixedAt: { x: se.scrollLeft, y: se.scrollTop },
        originX: 0, originY: 0, stop: de, stopIsCB: false, boxFixed: true,
      };
      box.appendChild(buildDocument(d, ctx, dc, w, h, se.scrollLeft, se.scrollTop, dW, dH));
    } else {
      box.setAttribute('data-h2c-placeholder', '');
    }
    return box;
  }

  function pageBackground() {
    const h = getComputedStyle(document.documentElement).backgroundColor;
    const b = getComputedStyle(document.body).backgroundColor;
    return !isTransparent(h) ? h : !isTransparent(b) ? b : '#ffffff';
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.decoding = 'sync';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('h2c：SVG 影像載入失敗'));
      img.src = src;
    });
  }

  /* ------------------------------------------------------------------ *
   * 主函式
   * ------------------------------------------------------------------ */
  async function h2c(target, options) {
    const opts = Object.assign({
      mode: 'viewport', scale: Math.max(2, global.devicePixelRatio || 1), imageTimeout: 8000, fonts: true, ignore: null,
    }, options || {});
    const de = document.documentElement, body = document.body;
    const docMode = !target || target === document || target === de || target === body;
    const ctx = {
      doc: document.implementation.createHTMLDocument(''),
      tasks: [], css: [], uid: 0, families: new Set(), codePoints: new Set(), useRefs: new Set(), failed: new Set(),
      timeout: opts.imageTimeout, ignore: opts.ignore, rootEl: null, spanDefaults: null,
    };
    const se = document.scrollingElement || de;
    const sx = se.scrollLeft, sy = se.scrollTop;
    const vw = de.clientWidth, vh = de.clientHeight;

    try {
      let root, W, H, ox, oy, bg;
      if (docMode) {
        const docW = Math.max(de.scrollWidth, body.scrollWidth, vw);
        const docH = Math.max(de.scrollHeight, body.scrollHeight, vh);
        const page = opts.mode === 'page' && !opts.region;
        // 擷取範圍（文件座標）：region > 整頁 > 可視區
        let rg = opts.region
          ? { x: opts.region.x, y: opts.region.y, width: opts.region.width, height: opts.region.height }
          : page ? { x: 0, y: 0, width: docW, height: docH } : { x: sx, y: sy, width: vw, height: vh };
        rg.x = Math.max(0, Math.min(rg.x, docW - 1));
        rg.y = Math.max(0, Math.min(rg.y, docH - 1));
        rg.width = Math.min(rg.width, docW - rg.x);
        rg.height = Math.min(rg.height, docH - rg.y);
        W = Math.ceil(rg.width);
        H = Math.ceil(rg.height);
        ox = rg.x;
        oy = rg.y;
        const dc = {
          // 整頁模式：fixed 元素畫在頁面頂端（等同捲動到最上方時的樣子）；其餘模式畫在擷取當下的視窗位置
          sx, sy, vw, vh, fixedAt: page ? { x: 0, y: 0 } : { x: sx, y: sy }, page,
          originX: 0, originY: 0, stop: de, stopIsCB: false, boxFixed: true,
        };
        root = buildDocument(document, ctx, dc, W, H, ox, oy, docW, docH);
        bg = opts.backgroundColor !== undefined ? opts.backgroundColor : pageBackground();
      } else {
        const el = target;
        const r = el.getBoundingClientRect();
        W = Math.ceil(r.width);
        H = Math.ceil(r.height);
        ox = r.left + sx;
        oy = r.top + sy;
        const dc = {
          sx, sy, vw, vh, fixedAt: { x: sx, y: sy },
          originX: ox, originY: oy, stop: el, stopIsCB: true, boxFixed: true,
        };
        ctx.rootEl = el;
        root = ctx.doc.createElement('div');
        root.setAttribute('style', 'position:relative;margin:0;padding:0;border:0;overflow:hidden;width:' + W + 'px;height:' + H + 'px;');
        const c = cloneTree(el, ctx, null,
          'margin:0;position:relative;left:auto;top:auto;right:auto;bottom:auto;transform:none;translate:none;', dc);
        if (c) root.appendChild(c);
        bg = opts.backgroundColor !== undefined ? opts.backgroundColor : null;
      }
      if (!W || !H) throw new Error('h2c：擷取範圍大小為 0');

      // 等待圖片／背景圖內嵌
      await Promise.all(ctx.tasks);

      // 偽元素規則 + 字型
      let css = ctx.css.join('\n');
      if (css.includes('url(')) css = await inlineCssUrls(css, ctx);
      if (opts.fonts) css = (await embedFonts(ctx)) + '\n' + css;
      if (css.trim()) {
        const st = ctx.doc.createElement('style');
        st.textContent = css;
        root.insertBefore(st, root.firstChild);
      }

      // <use href="#id"> 參照的 symbol 一併放入
      if (ctx.useRefs.size) {
        const defs = ctx.doc.createElementNS(SVG_NS, 'svg');
        defs.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
        ctx.useRefs.forEach((id) => {
          const ref = document.getElementById(id);
          if (ref) defs.appendChild(ctx.doc.importNode(ref, true));
        });
        root.insertBefore(defs, root.firstChild);
      }

      // 輸出解析度（受瀏覽器 canvas 上限約束）
      const scale = Math.min(opts.scale, Math.sqrt(MAX_PIXELS / (W * H)), MAX_DIM / W, MAX_DIM / H);
      const CW = Math.max(1, Math.round(W * scale));
      const CH = Math.max(1, Math.round(H * scale));

      // 在 HTML 內以 CSS transform 放大，再讓 SVG 本身就是輸出像素大小：
      // 文字與向量會以目標解析度繪製，而不是先畫成 1x 點陣再放大（Safari 尤其明顯）
      // 放大方式：優先用 CSS zoom（版面層級放大，陰影、模糊等效果位置正確）；
      // 不支援 zoom 的瀏覽器（Firefox 126 以前）改用 transform:scale。
      // 註：WebKit 在 foreignObject 內以 transform 放大時，box-shadow 的模糊會變成偏移的矩形。
      const method = opts.scaleMethod || (global.CSS && CSS.supports && CSS.supports('zoom', '2') ? 'zoom' : 'transform');
      const scaler = ctx.doc.createElement('div');
      const base = 'margin:0;padding:0;border:0;width:' + W + 'px;height:' + H + 'px;';
      scaler.setAttribute('style', method === 'zoom'
        ? base + 'zoom:' + scale + ';'
        : base + 'transform:scale(' + (CW / W) + ',' + (CH / H) + ');transform-origin:0 0;');
      scaler.appendChild(root);

      // 序列化成 SVG
      const xhtml = new XMLSerializer().serializeToString(scaler);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + CW + '" height="' + CH + '" viewBox="0 0 ' + CW + ' ' + CH + '">'
        + '<foreignObject x="0" y="0" width="' + CW + '" height="' + CH + '">' + xhtml + '</foreignObject></svg>';
      const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

      const img = await loadImage(svgUrl);
      if (img.decode) { try { await img.decode(); } catch (e) { /* 部分瀏覽器對 SVG decode 會失敗，可忽略 */ } }

      // 畫到 canvas（1:1，不再縮放）
      const canvas = document.createElement('canvas');
      canvas.width = CW;
      canvas.height = CH;
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const paint = () => {
        g.clearRect(0, 0, CW, CH);
        if (bg) { g.fillStyle = bg; g.fillRect(0, 0, CW, CH); }
        g.drawImage(img, 0, 0, CW, CH);
      };
      paint();
      if (isSafari) {
        // Safari：SVG 的 onload 觸發時，foreignObject 內的 <img>（含繪圖板快照、背景圖）還在非同步載入，
        // 第一次繪製會是空白；同一個 Image 物件稍後重畫即可呈現（實測約 200ms 後）。
        // 1) 依內嵌資料量先等待  2) 之後每 200ms 重畫一次，直到畫面指紋連續兩次相同（或達上限）
        const mb = xhtml.length / 1e6;
        await delay(Math.min(4000, 250 + mb * 400));
        const probe = document.createElement('canvas');
        probe.width = probe.height = 48;
        const pg = probe.getContext('2d', { willReadFrequently: true });
        const fingerprint = () => {
          pg.clearRect(0, 0, 48, 48);
          pg.drawImage(canvas, 0, 0, 48, 48);
          const d = pg.getImageData(0, 0, 48, 48).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647;
          return h;
        };
        paint();
        let prev = fingerprint();
        for (let i = 0; i < 10; i++) {
          await delay(200);
          paint();
          const f = fingerprint();
          if (f === prev) break;
          prev = f;
        }
      }
      canvas.h2c = { x: ox, y: oy, width: W, height: H, scale, failedResources: [...ctx.failed] };
      return canvas;
    } finally {
      removeSandbox();
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((res, rej) => {
      try {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('h2c：無法輸出圖片'))), type || 'image/png', quality);
      } catch (e) {
        rej(new Error('h2c：瀏覽器拒絕輸出圖片（' + e.name + '）'));
      }
    });
  }

  h2c.toBlob = async (target, options, type, quality) => canvasToBlob(await h2c(target, options), type, quality);
  h2c.toDataURL = async (target, options, type, quality) => (await h2c(target, options)).toDataURL(type || 'image/png', quality);
  h2c.download = async (target, filename, options) => {
    const blob = await h2c.toBlob(target, options);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'screenshot.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return blob;
  };
  h2c.canvasToBlob = canvasToBlob;
  // 1.2.3：改用 CSS zoom 放大（修正 WebKit 陰影錯位）
  // 1.2.2：Safari 內嵌圖片首次繪製空白的修正（等待並重畫至穩定）
  // 1.2.0：繪製 <html> 下 <body> 以外的元素（工具列 Shadow DOM）、region、高解析度、整頁 sticky 修正
  h2c.version = '1.2.3';

  global.h2c = h2c;
})(typeof window !== 'undefined' ? window : this);
