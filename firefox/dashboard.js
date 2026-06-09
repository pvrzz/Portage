/*
Portage by pvrz
https://github.com/pvrzz/Portage/
File Name: dashboard.js
*/

const api = typeof browser !== "undefined" ? browser : chrome;
const IS_FIREFOX = navigator.userAgent.includes("Firefox");
const SOURCE = IS_FIREFOX ? "firefox" : "chrome";
const SOURCE_LABEL = IS_FIREFOX ? "Firefox" : "Chrome";
const HAS_READINGLIST = typeof api.readingList !== "undefined" && typeof api.readingList?.query === "function";

document.getElementById("srcBadge").textContent = SOURCE_LABEL;
document.getElementById("exHeroTitle").textContent = `Scan ${SOURCE_LABEL}, then carry your data across`;
document.getElementById("scanLabel").textContent = `Scan ${SOURCE_LABEL}`;

const SVG = {
  bookmarks: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  cookies: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/>',
  tabs: '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M3 9h18"/>',
  sessions: '<path d="M3 3v5h5"/><path d="M3 8a9 9 0 1 0 3-6.7L3 4"/><path d="M12 7v5l3 2"/>',
  reading: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  extensions: '<path d="M14 7h2a2 2 0 0 1 2 2v2m-4 7H6a2 2 0 0 1-2-2v-4m0-4a2 2 0 0 1 2-2 2 2 0 0 0 2-2 2 2 0 0 1 4 0 2 2 0 0 0 2 2"/><circle cx="18" cy="16" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
};
const iconSvg = (i) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${i}</svg>`;
const tick = () => new Promise((r) => setTimeout(r, 0));
const IMPORTABLE = /^(https?|ftp):/i;

function saveFile(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function humanSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function countBookmarks(tree) {
  let n = 0; (function w(a) { for (const x of a) { if (x.url) n++; if (x.children) w(x.children); } })(tree); return n;
}
function countSessions(list) {
  let n = 0; for (const s of list) n += s.type === "window" ? (s.tabs?.length || 0) : 1; return n;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
function extensionsTxt(list) {
  const L = [];
  L.push("Portage — extension reinstall checklist");
  L.push(`Exported from ${SOURCE_LABEL} · ${new Date().toLocaleString()} · ${list.length} extensions`);
  L.push("");
  L.push("Tip: paste this whole list into an AI assistant and ask it to find each one as an");
  L.push("add-on for your new browser — or search the names yourself with the links below.");
  L.push("");
  list.forEach((e, i) => {
    L.push(`${i + 1}. ${e.name}  (v${e.version || "?"})`);
    if (e.description) L.push(`   ${e.description}`);
    if (e.homepageUrl) L.push(`   Home:    ${e.homepageUrl}`);
    L.push(`   Firefox: https://addons.mozilla.org/firefox/search/?q=${encodeURIComponent(e.name)}`);
    L.push(`   Chrome:  https://chromewebstore.google.com/search/${encodeURIComponent(e.name)}`);
    L.push("");
  });
  return L.join("\n");
}
function toast(msg, icon) {
  const wrap = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = iconSvg(SVG[icon] || SVG.check) + `<span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .3s, transform .3s"; el.style.opacity = "0"; el.style.transform = "translateX(20px)"; }, 3400);
  setTimeout(() => el.remove(), 3800);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKey(passphrase, salt, iterations) {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptBundle(obj, passphrase) {
  const iterations = 250000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify({ meta: obj.meta, data: obj.data }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    portage: {
      format: "portage-bundle-encrypted", version: 1,
      source: obj.portage.source, generator: obj.portage.generator, exportedAt: obj.portage.exportedAt,
      cipher: "AES-GCM", keyLength: 256, kdf: "PBKDF2", hash: "SHA-256", iterations,
      salt: bufToB64(salt), iv: bufToB64(iv),
    },
    ciphertext: bufToB64(ct),
  };
}
async function decryptBundle(wrapper, passphrase) {
  const p = wrapper.portage;
  const salt = new Uint8Array(b64ToBuf(p.salt));
  const iv = new Uint8Array(b64ToBuf(p.iv));
  const key = await deriveKey(passphrase, salt, p.iterations || 250000);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBuf(wrapper.ciphertext));
  const inner = JSON.parse(new TextDecoder().decode(pt));
  return { portage: { format: "portage-bundle", version: 1, source: p.source, generator: p.generator, exportedAt: p.exportedAt }, meta: inner.meta, data: inner.data };
}
function passStrength(p) {
  if (!p) return { pct: 0, label: "—" };
  let s = Math.min(p.length * 4, 40);
  if (/[a-z]/.test(p)) s += 10;
  if (/[A-Z]/.test(p)) s += 10;
  if (/[0-9]/.test(p)) s += 10;
  if (/[^A-Za-z0-9]/.test(p)) s += 15;
  if (p.length >= 16) s += 15;
  s = Math.min(s, 100);
  return { pct: s, label: s < 35 ? "Weak" : s < 60 ? "Fair" : s < 80 ? "Good" : "Strong" };
}

async function collectBookmarks() { const tree = await api.bookmarks.getTree(); return { data: tree, count: countBookmarks(tree) }; }
async function collectHistory() {
  const items = await api.history.search({ text: "", startTime: 0, maxResults: 1000000 });
  const data = items.map((i) => ({ url: i.url, title: i.title || "", lastVisitTime: i.lastVisitTime || 0, visitCount: i.visitCount || 0, typedCount: i.typedCount || 0 }));
  return { data, count: data.length };
}
async function collectCookies() {
  const all = await api.cookies.getAll({});
  const data = all.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate, hostOnly: c.hostOnly, session: c.session }));
  return { data, count: data.length };
}
async function collectTabs() {
  const tabs = await api.tabs.query({});
  const data = tabs.map((t) => ({ url: t.url || t.pendingUrl, title: t.title || "", pinned: t.pinned, index: t.index, windowId: t.windowId })).filter((t) => t.url);
  return { data, count: data.length };
}
async function collectSessions() {
  const s = await api.sessions.getRecentlyClosed({ maxResults: 25 });
  const data = s.map((x) => {
    if (x.tab) return { type: "tab", url: x.tab.url, title: x.tab.title || "" };
    if (x.window) return { type: "window", tabs: (x.window.tabs || []).map((t) => ({ url: t.url, title: t.title || "" })) };
    return null;
  }).filter(Boolean);
  return { data, count: countSessions(data) };
}
async function collectReadingList() {
  const items = await api.readingList.query({});
  const data = items.map((i) => ({ url: i.url, title: i.title || "", hasBeenRead: i.hasBeenRead, creationTime: i.creationTime, lastUpdateTime: i.lastUpdateTime }));
  return { data, count: data.length };
}
async function collectExtensions() {
  const all = await api.management.getAll();
  const data = all.filter((e) => e.type === "extension" && e.id !== api.runtime.id)
    .map((e) => ({ id: e.id, name: e.name, version: e.version, enabled: e.enabled, description: e.description, homepageUrl: e.homepageUrl, installType: e.installType }));
  return { data, count: data.length };
}

async function importBookmarks(tree, onProg) {
  const total = countBookmarks(tree); let done = 0, imported = 0, skipped = 0;
  const root = await api.bookmarks.create({ title: `Portage Import — ${new Date().toLocaleString()}` });
  async function walk(nodes, parentId) {
    for (const node of nodes) {
      if (node.url) {
        try { if (!IMPORTABLE.test(node.url)) skipped++; else { await api.bookmarks.create({ parentId, title: node.title || node.url, url: node.url }); imported++; } }
        catch { skipped++; }
        if (++done % 50 === 0) { onProg(done, total); await tick(); }
      } else if (node.children) {
        let pid = parentId;
        if (node.title) { const f = await api.bookmarks.create({ parentId, title: node.title }); pid = f.id; }
        await walk(node.children, pid);
      }
    }
  }
  await walk(tree, root.id); onProg(total, total); return { imported, skipped };
}
async function importHistory(items, onProg) {
  const total = items.length; let imported = 0, skipped = 0;
  for (let i = 0; i < total; i++) {
    const it = items[i];
    try {
      if (!IMPORTABLE.test(it.url)) skipped++;
      else {
        const details = IS_FIREFOX ? { url: it.url, title: it.title || undefined, visitTime: it.lastVisitTime || Date.now() } : { url: it.url };
        await api.history.addUrl(details); imported++;
      }
    } catch { skipped++; }
    if (i % 100 === 0) { onProg(i, total); await tick(); }
  }
  onProg(total, total); return { imported, skipped };
}
function mapSameSite(s) { return s === "strict" ? "strict" : s === "lax" ? "lax" : "no_restriction"; }
async function importCookies(items, onProg) {
  const total = items.length; let imported = 0, skipped = 0;
  for (let i = 0; i < total; i++) {
    const c = items[i];
    try {
      const host = (c.domain || "").replace(/^\./, "");
      if (!host) skipped++;
      else {
        const url = (c.secure ? "https" : "http") + "://" + host + (c.path || "/");
        const d = { url, name: c.name, value: c.value, path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: mapSameSite(c.sameSite) };
        if (!c.hostOnly) d.domain = c.domain;
        if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
        await api.cookies.set(d); imported++;
      }
    } catch { skipped++; }
    if (i % 100 === 0) { onProg(i, total); await tick(); }
  }
  onProg(total, total); return { imported, skipped };
}
async function importTabs(items, onProg) {
  const total = items.length; let imported = 0, skipped = 0;
  for (let i = 0; i < total; i++) {
    const t = items[i];
    try { if (!IMPORTABLE.test(t.url)) skipped++; else { await api.tabs.create({ url: t.url, pinned: !!t.pinned, active: false }); imported++; } }
    catch { skipped++; }
    onProg(i + 1, total); if (i % 10 === 0) await tick();
  }
  return { imported, skipped };
}
async function importSessions(list, onProg) {
  const flat = [];
  for (const s of list) { if (s.type === "window") for (const t of (s.tabs || [])) flat.push(t); else flat.push(s); }
  return importTabs(flat, onProg);
}
async function importReadingList(items, onProg) {
  const total = items.length; let imported = 0, skipped = 0;
  if (HAS_READINGLIST && api.readingList.addEntry) {
    for (let i = 0; i < total; i++) {
      const it = items[i];
      try { if (!IMPORTABLE.test(it.url)) skipped++; else { await api.readingList.addEntry({ url: it.url, title: it.title || it.url, hasBeenRead: !!it.hasBeenRead }); imported++; } }
      catch { skipped++; }
      onProg(i + 1, total); if (i % 50 === 0) await tick();
    }
  } else {
    const folder = await api.bookmarks.create({ title: "Reading List (from Portage)" });
    for (let i = 0; i < total; i++) {
      const it = items[i];
      try { if (!IMPORTABLE.test(it.url)) skipped++; else { await api.bookmarks.create({ parentId: folder.id, title: it.title || it.url, url: it.url }); imported++; } }
      catch { skipped++; }
      onProg(i + 1, total); if (i % 50 === 0) await tick();
    }
  }
  return { imported, skipped };
}

const CATS = {
  bookmarks: { label: "Bookmarks", unit: "bookmarks", icon: SVG.bookmarks, level: "full", desc: "Full bookmark tree, folders and all", importFx: "Created in a 'Portage Import' folder", collect: collectBookmarks, count: countBookmarks, importRun: importBookmarks },
  history:   { label: "History", unit: "pages", icon: SVG.history, level: "full", desc: "Pages you've visited, with timestamps", importFx: IS_FIREFOX ? "Re-added with titles & times" : "Re-added as visits", collect: collectHistory, count: (d) => d.length, importRun: importHistory },
  cookies:   { label: "Cookies", unit: "cookies", icon: SVG.cookies, level: "full", desc: "Site cookies — keeps you signed in", importFx: "Re-set so logins carry over", collect: collectCookies, count: (d) => d.length, importRun: importCookies },
  tabs:      { label: "Open tabs", unit: "tabs", icon: SVG.tabs, level: "full", desc: "Tabs open right now, every window", importFx: "Reopened in this window", collect: collectTabs, count: (d) => d.length, importRun: importTabs },
  sessions:  { label: "Recently closed", unit: "sessions", icon: SVG.sessions, level: "partial", desc: "Tabs & windows you closed recently", importFx: "Reopened as tabs", collect: collectSessions, count: countSessions, importRun: importSessions },
  readingList: { label: "Reading list", unit: "entries", icon: SVG.reading, level: HAS_READINGLIST ? "full" : "partial", desc: "Pages saved to read later", importFx: HAS_READINGLIST ? "Added to the reading list" : "Saved to a bookmark folder", collect: collectReadingList, count: (d) => d.length, importRun: importReadingList, needsReadingList: true },
  extensions: { label: "Extensions", unit: "installed", icon: SVG.extensions, level: "checklist", desc: "Installed add-ons → reinstall checklist", importFx: "Can't auto-install — use the .txt checklist", collect: collectExtensions, count: (d) => d.length, importRun: null, special: true },
};
const ORDER = ["bookmarks", "history", "cookies", "tabs", "sessions", "readingList", "extensions"];

const exState = {};
let scanned = false;
const exGrid = document.getElementById("exportGrid");

function exportCategoryIds() { return ORDER.filter((id) => !(CATS[id].needsReadingList && !HAS_READINGLIST)); }

function makeCard(id, c, opts) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="card-toggle">
      <label class="switch" title="Include"><input type="checkbox" data-toggle="${id}" ${opts.checked ? "checked" : ""} ${opts.toggleDisabled ? "disabled" : ""}><span class="track"></span></label>
    </div>
    <div class="card-top">
      <div class="card-icon">${iconSvg(c.icon)}</div>
      <div class="card-title"><h3>${c.label}</h3><div class="desc">${opts.desc}</div></div>
    </div>
    <div class="card-count"><span class="n" data-n="${id}">${opts.count ?? 0}</span><span class="u">${c.unit}</span></div>
    <div class="card-bar"><i data-bar="${id}"></i></div>
    <div class="card-state"><span class="dot ${opts.dot}" data-dot="${id}"></span><span data-msg="${id}">${opts.msg}</span></div>
    <div class="card-state">${iconSvg(SVG.arrow)}<span class="muted">${opts.fx}</span></div>
    <div data-extra="${id}"></div>`;
  return el;
}

function renderExportCards() {
  exGrid.innerHTML = "";
  exportCategoryIds().forEach((id, idx) => {
    const c = CATS[id];
    exState[id] = { data: null, count: 0, selected: true, status: "idle" };
    const el = makeCard(id, c, { checked: true, toggleDisabled: true, desc: c.desc, count: 0, dot: "empty", msg: "Not scanned yet", fx: c.special ? "Saved as a .txt checklist" : c.importFx });
    el.style.animationDelay = idx * 45 + "ms";
    exGrid.appendChild(el);
  });
  exGrid.addEventListener("change", (e) => {
    const id = e.target.dataset?.toggle; if (!id) return;
    exState[id].selected = e.target.checked;
    exGrid.querySelector(`.card[data-id="${id}"]`).classList.toggle("disabled", !e.target.checked);
    updateExportTotals();
  });
}

function setBar(id, pct) { const e = document.querySelector(`[data-bar="${id}"]`); if (e) e.style.width = pct + "%"; }
function setDot(id, cls) { const e = document.querySelector(`[data-dot="${id}"]`); if (e) e.className = "dot " + cls; }
function setMsg(id, m) { const e = document.querySelector(`[data-msg="${id}"]`); if (e) e.textContent = m; }
function countUp(id, to) {
  const el = document.querySelector(`[data-n="${id}"]`); const t0 = performance.now();
  (function f(t) { const p = Math.min(1, (t - t0) / 600); el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * to).toLocaleString(); if (p < 1) requestAnimationFrame(f); })(performance.now());
}

async function scanAll() {
  document.getElementById("scan").disabled = true;
  document.getElementById("scanbarWrap").classList.remove("hidden");
  document.getElementById("exStats").classList.remove("hidden");
  document.getElementById("actionbar").classList.remove("show");
  const ids = exportCategoryIds();
  let done = 0;
  for (const id of ids) {
    const c = CATS[id], st = exState[id];
    setDot(id, "scanning"); setMsg(id, "Scanning…"); setBar(id, 18);
    document.getElementById("scanStage").textContent = "Scanning " + c.label.toLowerCase() + "…";
    try {
      const { data, count } = await c.collect();
      st.data = data; st.count = count; st.status = "done"; setBar(id, 100); countUp(id, count);
      if (count === 0) { setDot(id, "empty"); setMsg(id, "Nothing found"); }
      else { setDot(id, "done"); setMsg(id, `Collected ${count.toLocaleString()} ${c.unit}`); }
      if (c.special && count > 0) addExtTxtButton(id, data);
    } catch (err) {
      st.status = "error"; st.data = null; st.count = 0; setBar(id, 100); setDot(id, "error"); setMsg(id, "Unavailable — " + err.message); st.selected = false;
    }
    const cb = document.querySelector(`[data-toggle="${id}"]`);
    const ok = st.status === "done" && st.count > 0;
    cb.disabled = !ok; cb.checked = ok; st.selected = ok;
    document.querySelector(`.card[data-id="${id}"]`).classList.toggle("disabled", !ok);
    done++;
    const pct = Math.round((done / ids.length) * 100);
    document.getElementById("scanFill").style.width = pct + "%";
    document.getElementById("scanPct").textContent = pct + "%";
  }
  scanned = true;
  document.getElementById("scanStage").textContent = "Scan complete";
  document.getElementById("scan").disabled = false;
  document.getElementById("scanLabel").textContent = "Re-scan";
  document.getElementById("actionbar").classList.add("show");
  updateExportTotals();
  toast("Scan complete — review and export", "check");
}

function addExtTxtButton(id, list) {
  const slot = document.querySelector(`[data-extra="${id}"]`);
  slot.innerHTML = `<div class="ext-actions"><button class="btn btn-ghost" id="extTxtNow">${iconSvg(SVG.download)} Save list (.txt)</button></div>`;
  document.getElementById("extTxtNow").addEventListener("click", () => {
    saveFile(`portage-${SOURCE}-extensions-${stamp()}.txt`, extensionsTxt(list), "text/plain");
    toast("Extension checklist saved", "download");
  });
}

function buildBundle() {
  const data = {}, counts = {};
  for (const id of exportCategoryIds()) {
    const st = exState[id];
    if (st.selected && st.data != null) { data[id] = st.data; counts[id] = st.count; }
  }
  return { portage: { format: "portage-bundle", version: 1, source: SOURCE, generator: `Portage ${SOURCE_LABEL} 2.0.0`, exportedAt: new Date().toISOString(), userAgent: navigator.userAgent }, meta: { counts }, data };
}

function updateExportTotals() {
  let items = 0, migratable = 0, cats = 0;
  for (const id of exportCategoryIds()) {
    const st = exState[id], c = CATS[id];
    if (st.selected && st.count > 0) { cats++; items += st.count; if (c.importRun) migratable += st.count; }
  }
  document.getElementById("totItems").textContent = items.toLocaleString();
  document.getElementById("totMigratable").textContent = migratable.toLocaleString();
  document.getElementById("totSelected").textContent = cats;
  document.getElementById("abItems").textContent = items.toLocaleString();
  document.getElementById("abCats").textContent = cats;
  document.getElementById("totSize").textContent = humanSize(new Blob([JSON.stringify(buildBundle())]).size);
  document.getElementById("export").disabled = cats === 0;
}

function clearScannedData() {
  for (const id of exportCategoryIds()) {
    const st = exState[id];
    st.data = null; st.count = 0; st.selected = false; st.status = "cleared";
    setBar(id, 0); setDot(id, "empty"); setMsg(id, "Cleared from memory — re-scan to export again");
    const n = document.querySelector(`[data-n="${id}"]`); if (n) n.textContent = "0";
    const cb = document.querySelector(`[data-toggle="${id}"]`); if (cb) { cb.checked = false; cb.disabled = true; }
    const card = document.querySelector(`.card[data-id="${id}"]`); if (card) card.classList.add("disabled");
    const extra = document.querySelector(`[data-extra="${id}"]`); if (extra) extra.innerHTML = "";
  }
  scanned = false;
  document.getElementById("scanLabel").textContent = `Scan ${SOURCE_LABEL}`;
  document.getElementById("actionbar").classList.remove("show");
  updateExportTotals();
}

async function exportBundle() {
  const encOn = document.getElementById("encToggle").checked;
  const pass = document.getElementById("encPass").value;
  const pass2 = document.getElementById("encPass2").value;
  if (encOn) {
    if (!pass) { toast("Enter a passphrase, or switch off encryption", "lock"); document.getElementById("encPass").focus(); return; }
    if (pass.length < 6) { toast("Use a longer passphrase (6+ characters)", "lock"); return; }
    if (pass !== pass2) { toast("Passphrases don't match", "lock"); document.getElementById("encPass2").focus(); return; }
  }
  const btn = document.getElementById("export"); const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + (encOn ? "Encrypting…" : "Building…");
  let ok = false, extra = "";
  try {
    const obj = buildBundle();
    const json = encOn ? JSON.stringify(await encryptBundle(obj, pass)) : JSON.stringify(obj, null, 2);
    saveFile(`portage-${SOURCE}-${stamp()}.portage.json`, json, "application/json");
    const ext = exState.extensions;
    if (ext && ext.selected && ext.count > 0) {
      saveFile(`portage-${SOURCE}-extensions-${stamp()}.txt`, extensionsTxt(ext.data), "text/plain");
      extra = " + extension checklist";
    }
    ok = true;
  } catch (err) { toast("Export failed: " + err.message, "lock"); }
  btn.innerHTML = orig;
  if (ok) {
    document.getElementById("encPass").value = ""; document.getElementById("encPass2").value = "";
    document.getElementById("encStrengthBar").style.width = "0%"; document.getElementById("encStrengthLabel").textContent = "—";
    clearScannedData();
    toast(`Bundle saved${encOn ? " (encrypted)" : ""}${extra} — data wiped from memory`, "check");
  } else { btn.disabled = false; }
}
async function copyJson() {
  try { await navigator.clipboard.writeText(JSON.stringify(buildBundle(), null, 2)); }
  catch (err) { toast("Copy failed: " + err.message, "check"); return; }
  clearScannedData(); toast("Plaintext bundle copied — data wiped from memory", "check");
}

function initEncryption() {
  const toggle = document.getElementById("encToggle");
  const body = document.getElementById("encBody");
  const pass = document.getElementById("encPass");
  const bar = document.getElementById("encStrengthBar");
  const label = document.getElementById("encStrengthLabel");
  toggle.addEventListener("change", () => body.classList.toggle("hidden", !toggle.checked));
  document.getElementById("encReveal").addEventListener("click", () => { pass.type = pass.type === "password" ? "text" : "password"; });
  pass.addEventListener("input", () => { const s = passStrength(pass.value); bar.style.width = s.pct + "%"; label.textContent = s.label; });
}

let bundle = null;
const imState = {};
const imGrid = document.getElementById("importGrid");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file");

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

async function loadFile(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast("Couldn't read that file — is it a Portage bundle?", "check"); return; }
  const fmt = parsed?.portage?.format;
  if (fmt === "portage-bundle") { bundle = parsed; showReview(); toast("Bundle loaded — review and import", "check"); }
  else if (fmt === "portage-bundle-encrypted") { openDecryptModal(parsed); }
  else { toast("Not a Portage bundle.", "check"); }
}

function openDecryptModal(wrapper) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const src = (wrapper.portage.source || "another browser").replace(/^./, (m) => m.toUpperCase());
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-icon">${iconSvg(SVG.lock)}</div>
      <h3>Encrypted bundle</h3>
      <p>This bundle from ${escapeHtml(src)} is encrypted with AES-256. Enter the passphrase to open it.</p>
      <div class="pass-row">
        <input class="input" type="password" id="decPass" placeholder="Passphrase" autocomplete="off" spellcheck="false">
        <button class="reveal" id="decReveal" type="button" aria-label="Show or hide">${iconSvg(SVG.eye)}</button>
      </div>
      <div class="err" id="decErr">Incorrect passphrase — try again.</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="decCancel">Cancel</button>
        <button class="btn btn-primary" id="decGo">Decrypt &amp; open</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#decPass");
  const err = overlay.querySelector("#decErr");
  const go = overlay.querySelector("#decGo");
  setTimeout(() => input.focus(), 50);
  overlay.querySelector("#decReveal").addEventListener("click", () => { input.type = input.type === "password" ? "text" : "password"; });
  overlay.querySelector("#decCancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  async function attempt() {
    if (!input.value) return;
    err.classList.remove("show");
    go.disabled = true; const orig = go.innerHTML; go.innerHTML = '<span class="spinner"></span> Decrypting…';
    try {
      bundle = await decryptBundle(wrapper, input.value);
      overlay.remove(); showReview(); toast("Bundle decrypted — review and import", "check");
    } catch { go.disabled = false; go.innerHTML = orig; err.classList.add("show"); input.select(); }
  }
  go.addEventListener("click", attempt);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
}

function showReview() {
  document.getElementById("loadStep").classList.add("hidden");
  document.getElementById("reviewStep").classList.remove("hidden");
  const p = bundle.portage;
  document.getElementById("bundleTitle").textContent = `Bundle from ${(p.source || "?").replace(/^./, (m) => m.toUpperCase())}`;
  document.getElementById("bundleMeta").textContent = `exported ${new Date(p.exportedAt).toLocaleString()} · ${p.generator || "Portage"}`;

  imGrid.innerHTML = ""; let totalItems = 0;
  ORDER.forEach((id, idx) => {
    const c = CATS[id]; const data = bundle.data?.[id];
    const present = Array.isArray(data) ? data.length > 0 : !!data;
    if (!present) return;
    const count = c.count(data); totalItems += count;
    const importable = !!c.importRun;
    imState[id] = { count, selected: importable };
    const el = makeCard(id, c, {
      checked: importable, toggleDisabled: !importable, desc: c.desc,
      count: count.toLocaleString(), dot: importable ? "done" : "empty",
      msg: importable ? "Ready to import" : "Reinstall manually", fx: c.importFx,
    });
    el.style.animationDelay = idx * 45 + "ms";
    if (!importable) el.classList.add("disabled");
    imGrid.appendChild(el);
    if (c.special) renderExtList(id, data);
  });

  imGrid.addEventListener("change", (e) => {
    const id = e.target.dataset?.toggle; if (!id || !imState[id]) return;
    imState[id].selected = e.target.checked;
    imGrid.querySelector(`.card[data-id="${id}"]`).classList.toggle("disabled", !e.target.checked);
    updateImportTotals();
  });

  document.getElementById("imItems").textContent = totalItems.toLocaleString();
  updateImportTotals();
}

function renderExtList(id, list) {
  const card = imGrid.querySelector(`.card[data-id="${id}"]`);
  card.classList.add("wide");
  const slot = card.querySelector(`[data-extra="${id}"]`);
  const rows = list.map((e, i) => `
    <div class="ext-row"><span class="idx">${i + 1}</span>
      <span style="flex:1"><span class="nm">${escapeHtml(e.name)}</span> <span class="ver">v${escapeHtml(e.version || "?")}</span></span>
      <a href="https://addons.mozilla.org/firefox/search/?q=${encodeURIComponent(e.name)}" target="_blank" rel="noopener">Firefox</a>
      <a href="https://chromewebstore.google.com/search/${encodeURIComponent(e.name)}" target="_blank" rel="noopener">Chrome</a>
    </div>`).join("");
  slot.innerHTML = `
    <div class="ext-actions"><button class="btn btn-ghost" id="extTxtDl">${iconSvg(SVG.download)} Download checklist (.txt)</button></div>
    <div class="ext-list">${rows}</div>`;
  document.getElementById("extTxtDl").addEventListener("click", () => {
    saveFile(`portage-extensions-${stamp()}.txt`, extensionsTxt(list), "text/plain");
    toast("Extension checklist saved", "download");
  });
}

function updateImportTotals() {
  let sel = 0;
  for (const id in imState) if (imState[id].selected) sel += imState[id].count;
  document.getElementById("imSelected").textContent = sel.toLocaleString();
  document.getElementById("importBtn").disabled = sel === 0;
}

async function runImport() {
  const btn = document.getElementById("importBtn"); const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Importing…';
  document.getElementById("impbarWrap").classList.remove("hidden");
  const todo = ORDER.filter((id) => imState[id]?.selected && CATS[id].importRun);
  let imported = 0, skipped = 0, ci = 0;
  for (const id of todo) {
    const c = CATS[id];
    setDot(id, "scanning"); setMsg(id, "Importing…");
    document.getElementById("impStage").textContent = "Importing " + c.label.toLowerCase() + "…";
    try {
      const res = await c.importRun(bundle.data[id], (d, t) => setBar(id, t ? Math.round((d / t) * 100) : 100));
      imported += res.imported; skipped += res.skipped;
      setBar(id, 100); setDot(id, "done"); setMsg(id, `Imported ${res.imported.toLocaleString()}` + (res.skipped ? ` · ${res.skipped} skipped` : ""));
    } catch (err) { setDot(id, "error"); setMsg(id, "Failed — " + err.message); }
    ci++;
    const pct = Math.round((ci / todo.length) * 100);
    document.getElementById("impFill").style.width = pct + "%";
    document.getElementById("impPct").textContent = pct + "%";
    document.getElementById("imImported").textContent = imported.toLocaleString();
    document.getElementById("imSkipped").textContent = skipped.toLocaleString();
  }
  bundle = null;
  document.getElementById("impStage").textContent = "Import complete · bundle wiped from memory";
  btn.innerHTML = orig; btn.disabled = true;
  toast(`Done — ${imported.toLocaleString()} items imported into ${SOURCE_LABEL}; bundle wiped`, "check");
}

function resetImport() {
  bundle = null; fileInput.value = "";
  document.getElementById("reviewStep").classList.add("hidden");
  document.getElementById("loadStep").classList.remove("hidden");
  document.getElementById("impbarWrap").classList.add("hidden");
}

function setMode(mode) {
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const exporting = mode === "export";
  document.getElementById("exportPanel").classList.toggle("hidden", !exporting);
  document.getElementById("importPanel").classList.toggle("hidden", exporting);
  document.getElementById("actionbar").classList.toggle("show", exporting && scanned);
}

document.getElementById("modeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.mode); });
document.getElementById("scan").addEventListener("click", scanAll);
document.getElementById("export").addEventListener("click", exportBundle);
document.getElementById("copyJson").addEventListener("click", copyJson);
document.getElementById("importBtn").addEventListener("click", runImport);
document.getElementById("reset").addEventListener("click", resetImport);

renderExportCards();
initEncryption();
