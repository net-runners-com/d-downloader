// Runs on every dpub.jp page.
//  - /library/ : checkbox on each purchased-course card + a bottom action bar to
//    download the selected courses. A per-card ⬇ downloads just that one.
//  - /products/<id>/index/ : a "⬇ この講座を保存" button (enumerates locally), and
//    when opened by the background for a pending batch, it enumerates and reports
//    the PART list back, then the tab closes.
//
// Enumeration must read the *rendered* product-page DOM (the index HTML has no
// /contents/ links and X-Frame-Options: DENY blocks iframing). Each content page's
// HTML embeds the Wistia id, fetched same-origin so the login session applies.
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

  // Collect every content link. Subscription courses group chapters into a Radix
  // accordion whose collapsed sections aren't in the DOM, so expand them all
  // (multiple-type: sections stay open) before scraping. Normal courses have no
  // triggers and just return the links already present.
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
    const map = new Map(); // href -> best title text (document order preserved)
    for (const a of document.querySelectorAll('a[href*="/contents/"]')) {
      const href = a.getAttribute('href'); if (!href || !same(href)) continue;
      const t = (a.textContent || '').trim().replace(/\s+/g, ' ');
      const good = t && !/^\d+:\d+$/.test(t);
      const prev = map.get(href);
      if (prev === undefined) map.set(href, good ? t : '');
      else if (good && t.length > prev.length) map.set(href, t);
    }
    return [...map.entries()].map(([href, domTitle]) => ({ href, domTitle }));
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
        const id = mediaIdFrom(html);
        if (!id) continue; // locked / coming-soon / non-video (e.g. PDF)
        results[i] = { title: list[i].domTitle || titleFrom(html) || `PART${i + 1}`, masterUrl: `https://fast.wistia.com/embed/medias/${id}.m3u8` };
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    const parts = [];
    results.forEach((r) => { if (r) parts.push({ index: parts.length + 1, title: r.title, masterUrl: r.masterUrl }); });
    if (!parts.length) throw new Error('視聴可能な動画が見つかりません（未購入 / 公開前 / 書籍講座）');
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
      const title = (img && img.alt.trim()) || (a.textContent || '').trim().replace(/\s+/g, ' ') || `product_${pid}`;
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
