// Service worker. Opens the downloader page IMMEDIATELY, then enumerates each
// course in the background (opening its product page in a hidden tab to read the
// client-rendered chapter list) and streams the resolved PART lists into the page.
const jobs = new Map();       // jobId -> {courses:[{pid,title,parts,error,status}]}
const pending = new Map();    // productId -> {jobId, title}
let prepTabId = null;
let prepQueue = [];           // [{jobId, pid, title}]
let prepJobId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'downloadCourses') {
    const jobId = newId();
    jobs.set(jobId, { courses: msg.courses.map((c) => ({ pid: String(c.pid), title: c.title, parts: null, error: null, status: 'pending' })) });
    openDownloader(jobId);
    for (const c of msg.courses) prepQueue.push({ jobId, pid: String(c.pid), title: c.title });
    if (prepTabId == null) startNextPrep();
    return;
  }

  if (msg.type === 'downloadResolved') {
    const jobId = newId();
    jobs.set(jobId, { courses: msg.courses.map((c) => ({ pid: String(c.pid), title: c.title, parts: c.parts, error: (c.parts && c.parts.length) ? null : 'no video', status: 'done' })) });
    openDownloader(jobId);
    return;
  }

  if (msg.type === 'checkPending') {
    const rec = pending.get(String(msg.productId));
    sendResponse({ pending: !!rec, title: rec && rec.title });
    return true;
  }

  if (msg.type === 'courseParts') {
    const pid = String(msg.productId);
    const rec = pending.get(pid);
    pending.delete(pid);
    const jobId = rec ? rec.jobId : prepJobId;
    const job = jobs.get(jobId);
    if (job) {
      const c = job.courses.find((x) => x.pid === pid);
      if (c) {
        c.parts = msg.parts || [];
        c.error = msg.error || (c.parts.length ? null : 'no video');
        c.status = 'done';
        chrome.runtime.sendMessage({ type: 'jobUpdate', jobId, pid, course: c }).catch(() => {});
      }
    }
    if (prepTabId != null) { const t = prepTabId; prepTabId = null; setTimeout(() => chrome.tabs.remove(t).catch(() => {}), 400); }
    startNextPrep();
    return;
  }

  if (msg.type === 'getJob') {
    sendResponse(jobs.get(msg.jobId) || null);
    return true;
  }
});

function startNextPrep() {
  if (!prepQueue.length) { prepJobId = null; return; }
  const item = prepQueue.shift();
  prepJobId = item.jobId;
  pending.set(item.pid, { jobId: item.jobId, title: item.title });
  chrome.tabs.create({ url: `https://dpub.jp/products/${item.pid}/index/`, active: false }, (tab) => {
    prepTabId = tab ? tab.id : null;
  });
  const pid = item.pid;
  setTimeout(() => {
    if (pending.has(pid)) {
      const rec = pending.get(pid); pending.delete(pid);
      const job = jobs.get(rec.jobId);
      const c = job && job.courses.find((x) => x.pid === pid);
      if (c && c.status === 'pending') { c.error = 'timeout'; c.status = 'done'; chrome.runtime.sendMessage({ type: 'jobUpdate', jobId: rec.jobId, pid, course: c }).catch(() => {}); }
      if (prepTabId != null) { const t = prepTabId; prepTabId = null; chrome.tabs.remove(t).catch(() => {}); }
      startNextPrep();
    }
  }, 180000);
}

function openDownloader(jobId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`downloader.html#${jobId}`), active: true });
}

function newId() { return Math.random().toString(36).slice(2, 10); }
