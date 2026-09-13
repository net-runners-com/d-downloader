// Runs on every dpub.jp page.
//  - /library/ : checkbox on each purchased-course card + a bottom action bar to
//    download the selected courses. A per-card ⬇ downloads just that one.
//  - /products/<id>/index/ : a "⬇ この講座を保存" button (enumerates locally), and
//    when opened by the background for a pending batch, it enumerates and reports
//    the PART list back, then the tab closes.
//
// Enumeration must read the *rendered* product-page DOM (the index HTML has no
// /contents/ links and X-Frame-Options: DENY blocks iframing). Each content page's
// HTML embeds the Wistia id and the「関連教材・資料」file URLs, fetched same-origin
// so the login session applies. Accordion section titles become folder names.
// Actual downloading/saving happens in the extension's downloader page.
(() => {
  const RX_PID = /\/products\/(\d+)\//;
  const productId = () => (location.pathname.match(/^\/products\/(\d+)\/index\/?$/) || [])[1];
  const isLibrary = () => /^\/library\/?$/.test(location.pathname);

  function courseTitle() {
    const h = document.querySelector('h1');
    if (h && h.textContent.trim()) return h.textContent.trim();
    return (document.title || '').split(/[｜|]/)[0].trim() || 'course';
  }

  async function fetchText(path) {
    const r = await fetch(path, { credentials: 'include' });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.text();
  }
  function mediaIdFrom(html) {
    const s = html.replace(/\\+/g, '');
    const m = s.match(/(?:videoId|hashedId)":"([A-Za-z0-9]{8,16})/) ||
              s.match(/medias\/([A-Za-z0-9]{8,16})/) ||
              s.match(/wistia_async_([A-Za-z0-9]{8,16})/);
    return m ? m[1] : null;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---------------- 関連教材・資料 ----------------
  // The content page ships its data inside the Next.js RSC payload, so material
  // URLs are scraped out of the raw HTML rather than the DOM. Site chrome that
  // happens to match (logos, thumbnails, icons) is filtered here; anything that
  // still slips through repeats on most PARTs and is dropped in enumerate().
  const EXTS = 'pdf|zip|rar|7z|docx?|xlsx?|pptx?|csv|txt|epub|key|pages|numbers|mp3|m4a|wav|png|jpe?g|gif|webp';
  const RX_EXT = new RegExp(`\\.(?:${EXTS})$`, 'i');
  const RX_ABS = new RegExp(`https?://[^\\s"'<>()\\\\\\]]+?\\.(?:${EXTS})(?:\\?[^\\s"'<>()\\\\\\]]*)?`, 'gi');
  const RX_REL = new RegExp(`"(/[^"\\s<>]+?\\.(?:${EXTS})(?:\\?[^"\\s<>]*)?)"`, 'gi');
  // a flat JSON object that carries both a display name and a link, for files
  // whose URL is a signed/extension-less endpoint
  const RX_OBJ = /\{[^{}]{0,1200}\}/g;
  const RX_NAME = new RegExp(`"(?:file_?name|original_?name|display_?name|name|title|label)"\\s*:\\s*"([^"\\\\]{1,200}\\.(?:${EXTS}))"`, 'i');
  const RX_HREF = /"(?:url|file_?url|download_?url|file_?path|src|href|path|location)"\s*:\s*"((?:https?:)?\/\/[^"\s]+|\/[^"\s]+)"/i;
  const NOISE = /(?:_next\/|\/static\/|\/_nuxt\/|favicon|apple-touch|android-chrome|manifest|\/icons?\/|icon[-_.]|logo|ogp|og[-_]image|thumbnail|thumb[-_.]|avatar|placeholder|sprite|banner|gstatic|googleapis|gravatar|wistia|fontawesome|\/fonts?\/)/i;
  // the「関連教材・資料」heading sits next to its file list in the RSC payload, so
  // scanning from there keeps other lessons' files (sidebars, prefetched routes)
  // out of this PART
  const RX_HEADING = /関連教材\s*[・･]?\s*資料|関連教材|教材\s*[・･]\s*資料|ダウンロード資料/;
  const WINDOW = 8000;
  const MAX_ATT = 20;

  function unesc(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\\//g, '/').replace(/\\"/g, '"');
  }

  // base64/hash asset names carry no meaning and are never course material
  function isHashName(name) {
    const stem = String(name).replace(RX_EXT, '');
    if (/[=]$/.test(stem)) return true;
    return stem.length >= 14 && !/[\u3000-\u9fff\uff00-\uffef _.\-()[\]]/.test(stem) &&
           /[a-z]/.test(stem) && /[A-Z]/.test(stem) && /\d/.test(stem);
  }

  function scanFiles(text, baseHref, seen, out) {
    const add = (raw, name) => {
      if (out.length >= MAX_ATT) return;
      let abs;
      try { abs = new URL(raw, baseHref).href; } catch (_) { return; }
      if (!/^https?:/i.test(abs) || seen.has(abs) || NOISE.test(abs)) return;
      let base;
      try { base = decodeURIComponent(abs.split('?')[0].split('/').pop() || ''); } catch (_) { base = abs.split('?')[0].split('/').pop() || ''; }
      const named = name && RX_EXT.test(name);
      if (!named && (!base || !RX_EXT.test(base))) return;   // URL must look like a file unless named
      if (NOISE.test(base)) return;
      const final = named ? name : base;
      if (isHashName(final)) return;   // CDN asset like f2y0kMyr6LTyNL2v1gFbCA==.png
      seen.add(abs);
      out.push({ name: final, url: abs });
    };
    let m;
    RX_ABS.lastIndex = 0;
    while ((m = RX_ABS.exec(text))) add(m[0]);
    RX_REL.lastIndex = 0;
    while ((m = RX_REL.exec(text))) add(m[1]);
    RX_OBJ.lastIndex = 0;
    while ((m = RX_OBJ.exec(text))) {
      const nm = m[0].match(RX_NAME), hf = m[0].match(RX_HREF);
      if (nm && hf) add(hf[1], nm[1]);
    }
  }

  function attachmentsFrom(html, baseHref) {
    const s = unesc(html);
    const out = [];
    const seen = new Set();
    const h = s.search(RX_HEADING);
    if (h >= 0) scanFiles(s.slice(h, h + WINDOW), baseHref, seen, out);
    if (!out.length) scanFiles(s, baseHref, seen, out);   // heading missing or list sits before it
    return out;
  }

  // Collect every content link with the accordion section it lives under.
  // Subscription courses group chapters into a Radix accordion whose collapsed
  // sections aren't in the DOM, so expand them all (multiple-type: sections stay
  // open) before scraping. Normal courses have no triggers and return a single
  // unnamed section.
  async function collectAllContents(timeoutMs = 20000) {
    const pid = productId();
    const same = (href) => !pid || href.includes(`/products/${pid}/contents/`);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs && !document.querySelector('a[href*="/contents/"]') &&
           !document.querySelector('button[aria-controls][aria-expanded]')) {
      await sleep(400);
    }
    for (let pass = 0; pass < 6; pass++) {
      const closed = [...document.querySelectorAll('button[aria-controls][aria-expanded="false"]')];
      if (!closed.length) break;
      for (const b of closed) { try { b.click(); } catch (_) {} await sleep(80); }
      await sleep(300);
    }

    // panel element id -> its trigger's label (= chapter name shown on the page)
    const panelTitle = new Map();
    for (const b of document.querySelectorAll('button[aria-controls]')) {
      const id = b.getAttribute('aria-controls');
      const t = clean(b.textContent).replace(/\s*\d+\s*(?:本|件|コンテンツ)$/, '');
      if (id && t) panelTitle.set(id, t);
    }
    const sectionOf = (a) => {
      for (let el = a.parentElement; el; el = el.parentElement) {
        const t = el.id && panelTitle.get(el.id);
        if (t) return t;                       // nearest enclosing panel wins
      }
      return '';
    };

    const map = new Map(); // href -> {title, section} (document order preserved)
    for (const a of document.querySelectorAll('a[href*="/contents/"]')) {
      const href = a.getAttribute('href'); if (!href || !same(href)) continue;
      const t = clean(a.textContent);
      const good = t && !/^\d+:\d+$/.test(t);
      const prev = map.get(href);
      if (prev === undefined) map.set(href, { domTitle: good ? t : '', section: sectionOf(a) });
      else {
        if (good && t.length > prev.domTitle.length) prev.domTitle = t;
        if (!prev.section) prev.section = sectionOf(a);
      }
    }
    return [...map.entries()].map(([href, v]) => ({ href, domTitle: v.domTitle, section: v.section }));
  }

  function titleFrom(html) {
    const m = html.match(/<title>([^<]*)<\/title>/);
    return m ? m[1].split(/[｜|]/)[0].trim() : null;
  }

  async function enumerate() {
    const list = await collectAllContents();
    if (!list.length) throw new Error('コンテンツ一覧を検出できませんでした');
    const results = new Array(list.length);
    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++; if (i >= list.length) return;
        let html; try { html = await fetchText(list[i].href); } catch (_) { continue; }
        const base = new URL(list[i].href, location.href).href;
        const id = mediaIdFrom(html);
        const attachments = attachmentsFrom(html, base);
        if (!id && !attachments.length) continue; // locked / coming-soon / empty
        results[i] = {
          title: list[i].domTitle || titleFrom(html) || `PART${i + 1}`,
          section: list[i].section,
          masterUrl: id ? `https://fast.wistia.com/embed/medias/${id}.m3u8` : null,
          attachments,
        };
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));

    const kept = results.filter(Boolean);
    // A file linked from nearly every PART is site chrome, not course material.
    if (kept.length >= 3) {
      const freq = new Map();
      for (const r of kept) for (const a of r.attachments) freq.set(a.url, (freq.get(a.url) || 0) + 1);
      const limit = Math.max(2, Math.floor(kept.length * 0.6));
      for (const r of kept) r.attachments = r.attachments.filter((a) => freq.get(a.url) <= limit);
    }

    const perSection = new Map();
    const parts = kept.map((r, i) => {
      const n = (perSection.get(r.section) || 0) + 1;
      perSection.set(r.section, n);
      return { index: i + 1, sectionIndex: n, section: r.section, title: r.title, masterUrl: r.masterUrl, attachments: r.attachments };
    });
    if (!parts.length) throw new Error('視聴可能な動画・資料が見つかりません（未購入 / 公開前 / 書籍講座）');
    return parts;
  }

  // ---------------- library: checkboxes + action bar ----------------
  const selected = new Map(); // pid -> title

  function bar() {
    let b = document.getElementById('dpd-bar');
    if (b) return b;
    b = document.createElement('div'); b.id = 'dpd-bar'; b.hidden = true;
    b.innerHTML = '<span id="dpd-count">0 講座</span>' +
      '<button id="dpd-go" class="dpd-go">選択した講座をダウンロード</button>' +
      '<button id="dpd-clear" class="dpd-clear">クリア</button>';
    document.body.appendChild(b);
    b.querySelector('#dpd-go').onclick = () => {
      if (!selected.size) return;
      const courses = [...selected.entries()].map(([pid, title]) => ({ pid, title }));
      chrome.runtime.sendMessage({ type: 'downloadCourses', courses });
      toast(`${courses.length} 講座を解析中… ダウンローダーが開きます`);
    };
    b.querySelector('#dpd-clear').onclick = () => {
      selected.clear();
      document.querySelectorAll('.dpd-chk').forEach((c) => (c.checked = false));
      refreshBar();
    };
    return b;
  }
  function refreshBar() {
    const b = bar();
    b.querySelector('#dpd-count').textContent = `${selected.size} 講座`;
    b.hidden = selected.size === 0;
  }

  function injectCards() {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/products/"]')) {
      const href = a.getAttribute('href') || '';
      if (!/\/products\/\d+\/index\/?$/.test(href)) continue;
      const pid = (href.match(RX_PID) || [])[1]; if (!pid) continue;
      if (!seen.has(pid) || a.querySelector('img')) seen.set(pid, a);
    }
    for (const [pid, a] of seen) {
      const host = a.closest('div') || a.parentElement || a;
      const img = a.querySelector('img[alt]');
      const title = (img && img.alt.trim()) || clean(a.textContent) || `product_${pid}`;
      if (!host.querySelector(`.dpd-chk[data-pid="${pid}"]`)) {
        host.classList.add('dpd-card-rel');
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.className = 'dpd-chk'; chk.dataset.pid = pid;
        chk.title = '選択';
        chk.addEventListener('click', (e) => e.stopPropagation());
        chk.addEventListener('change', () => {
          if (chk.checked) selected.set(pid, title); else selected.delete(pid);
          refreshBar();
        });
        host.appendChild(chk);
      }
      if (!host.querySelector(`.dpd-btn[data-pid="${pid}"]`)) {
        const btn = document.createElement('button');
        btn.className = 'dpd-btn'; btn.dataset.pid = pid; btn.textContent = '⬇';
        btn.title = 'この講座だけダウンロード';
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          chrome.runtime.sendMessage({ type: 'downloadCourses', courses: [{ pid, title }] });
          toast('解析中… ダウンローダーが開きます');
        });
        host.appendChild(btn);
      }
    }
  }

  // ---------------- product page button ----------------
  function injectProductButton() {
    if (document.getElementById('dpd-all')) return;
    const btn = document.createElement('button');
    btn.id = 'dpd-all'; btn.className = 'dpd-btn dpd-fab'; btn.textContent = '⬇ この講座を保存';
    btn.addEventListener('click', async () => {
      const course = courseTitle();
      btn.disabled = true; btn.textContent = '解析中…';
      try {
        const parts = await enumerate();
        chrome.runtime.sendMessage({ type: 'downloadResolved', courses: [{ pid: productId(), title: course, parts }] });
        toast('ダウンローダーが開きます');
      } catch (e) { toast('エラー: ' + (e.message || e)); }
      finally { btn.disabled = false; btn.textContent = '⬇ この講座を保存'; }
    });
    document.body.appendChild(btn);
  }

  function toast(text) {
    let t = document.getElementById('dpd-toast');
    if (!t) { t = document.createElement('div'); t.id = 'dpd-toast'; document.body.appendChild(t); }
    t.textContent = text; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4000);
  }

  // ---------------- material fetch proxy ----------------
  // Materials may sit behind the dpub.jp login. A fetch from the extension page is
  // cross-site, so SameSite cookies are dropped there; the downloader falls back
  // to this handler, which runs in the page's own origin and does carry them.
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'dpdFetchBinary') {
      (async () => {
        try {
          const r = await fetch(msg.url, { credentials: 'include' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const b = new Uint8Array(await r.arrayBuffer());
          sendResponse({ ok: true, b64: toB64(b), type: r.headers.get('content-type') || '' });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      })();
      return true;
    }
  });

  // ---------------- init ----------------
  async function initProduct() {
    injectProductButton();
    const pid = productId();
    let rec = null;
    try { rec = await chrome.runtime.sendMessage({ type: 'checkPending', productId: pid }); } catch (_) {}
    if (rec && rec.pending) {
      try {
        const parts = await enumerate();
        chrome.runtime.sendMessage({ type: 'courseParts', productId: pid, title: rec.title || courseTitle(), parts });
      } catch (e) {
        chrome.runtime.sendMessage({ type: 'courseParts', productId: pid, error: String(e.message || e) });
      }
    }
  }

  function boot() {
    if (productId()) initProduct();
    else if (isLibrary()) {
      injectCards();
      new MutationObserver(() => injectCards()).observe(document.documentElement, { childList: true, subtree: true });
      setInterval(injectCards, 1500);
    }
  }
  boot();
})();
