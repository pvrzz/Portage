// ---------------------------------------
// portage by pvrz
// github: https://github.com/pvrzz/portage
// file name: popup.js
// ---------------------------------------


// ---------------------------------------
// state
// ---------------------------------------

const state = {
  type: "extensions",
  mode: "installed",
  selectedIds: new Set(),
  expandedDomains: new Set(),
  data: {
    extensionsInstalled: [],
    extensionsImported: [],
    cookiesInstalled: {},
    cookiesImported: {},
  },
};


// ---------------------------------------
// constants
// ---------------------------------------

const WEBSTORE_BASE = "https://chromewebstore.google.com/detail";
const SELF_ID = chrome.runtime.id;
const PBKDF2_ITERATIONS = 250000;
const COOKIES_FORMAT = "portage-cookies";
const COOKIES_VERSION = 1;
const EXTENSIONS_FORMAT = "portage-extensions";


// ---------------------------------------
// dom refs
// ---------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  list: $("ext-list"),
  emptyState: $("empty-state"),
  emptyTitle: $("empty-title"),
  emptySub: $("empty-sub"),
  subtitle: $("subtitle"),
  selectedCount: $("selected-count"),
  primaryBtn: $("primary-btn"),
  primaryLabel: $("primary-label"),
  statusEl: $("status"),
  importInput: $("import-input"),
  modal: $("modal-backdrop"),
  modalTitle: $("modal-title"),
  modalDesc: $("modal-desc"),
  modalPass: $("modal-passphrase"),
  modalPassConfirm: $("modal-passphrase-confirm"),
  modalSkipWrap: $("modal-skip-encrypt-wrap"),
  modalSkip: $("modal-skip-encrypt"),
  modalWarn: $("modal-warn"),
  modalConfirm: $("modal-confirm"),
  modalCancel: $("modal-cancel"),
  modalClose: $("modal-close"),
};


// ---------------------------------------
// initialization
// ---------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadExtensions();
  await loadCookies();
  attachEventListeners();
  render();
});


// ---------------------------------------
// data loading
// ---------------------------------------

async function loadExtensions() {
  const all = await chrome.management.getAll();
  state.data.extensionsInstalled = all
    .filter((ext) => ext.type === "extension" && ext.id !== SELF_ID)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadCookies() {
  const all = await chrome.cookies.getAll({});
  state.data.cookiesInstalled = groupCookiesByDomain(all);
}

function groupCookiesByDomain(cookies) {
  const grouped = {};
  for (const c of cookies) {
    const key = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  }
  const sorted = {};
  for (const k of Object.keys(grouped).sort()) {
    sorted[k] = grouped[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  return sorted;
}


// ---------------------------------------
// current view helpers
// ---------------------------------------

function currentList() {
  if (state.type === "extensions") {
    return state.mode === "installed"
      ? state.data.extensionsInstalled
      : state.data.extensionsImported;
  } else {
    return state.mode === "installed"
      ? state.data.cookiesInstalled
      : state.data.cookiesImported;
  }
}

function currentItemIds() {
  const list = currentList();
  if (state.type === "extensions") {
    return list.map((e) => e.id);
  } else {
    return Object.keys(list);
  }
}


// ---------------------------------------
// render
// ---------------------------------------

function render() {
  updateSubtitle();
  updateTabsActive();
  updatePrimaryButton();
  updateImportAccept();

  const list = currentList();
  const empty = state.type === "extensions"
    ? list.length === 0
    : Object.keys(list).length === 0;

  if (empty) {
    els.list.innerHTML = "";
    els.emptyState.classList.remove("hidden");
    updateEmptyState();
  } else {
    els.emptyState.classList.add("hidden");
    if (state.type === "extensions") {
      renderExtensionList(list);
    } else {
      renderCookieGroups(list);
    }
  }

  updateSelectionUi();
}

function updateSubtitle() {
  const list = currentList();
  if (state.type === "extensions") {
    els.subtitle.textContent = `${list.length} ${state.mode === "installed" ? "installed" : "imported"}`;
  } else {
    const domainCount = Object.keys(list).length;
    let cookieCount = 0;
    for (const k of Object.keys(list)) cookieCount += list[k].length;
    els.subtitle.textContent = `${cookieCount} cookies · ${domainCount} domains`;
  }
}

function updateTabsActive() {
  document.querySelectorAll(".type-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.type === state.type);
  });
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === state.mode);
  });
}

function updatePrimaryButton() {
  const hasSelection = state.selectedIds.size > 0;
  els.primaryBtn.disabled = !hasSelection;

  if (state.type === "extensions") {
    els.primaryLabel.textContent = "open in tab group";
  } else if (state.mode === "installed") {
    els.primaryLabel.textContent = "export selected";
  } else {
    els.primaryLabel.textContent = "apply to browser";
  }
}

function updateImportAccept() {
  els.importInput.accept = state.type === "extensions" ? ".html,.htm" : ".json";
}

function updateEmptyState() {
  if (state.type === "extensions") {
    els.emptyTitle.textContent = state.mode === "imported" ? "no imported extensions" : "no extensions found";
    els.emptySub.textContent = state.mode === "imported" ? "import an html export to see it here" : "you have no installable extensions";
  } else {
    els.emptyTitle.textContent = state.mode === "imported" ? "no imported cookies" : "no cookies found";
    els.emptySub.textContent = state.mode === "imported" ? "import a cookies json file to see them here" : "your browser has no cookies stored";
  }
}

function renderExtensionList(list) {
  els.list.innerHTML = "";
  for (const ext of list) {
    const li = document.createElement("li");
    li.className = "ext-item";
    li.dataset.id = ext.id;
    if (state.selectedIds.has(ext.id)) li.classList.add("selected");

    const iconUrl = getBestIcon(ext);
    const isDisabled = ext.enabled === false;
    const isSideload =
      ext.installType && ext.installType !== "normal" && ext.installType !== "admin";

    li.innerHTML = `
      <input type="checkbox" class="ext-checkbox" ${state.selectedIds.has(ext.id) ? "checked" : ""}>
      ${iconUrl ? `<img class="ext-icon" src="${escapeAttr(iconUrl)}" alt="">` : `<div class="ext-icon"></div>`}
      <div class="ext-info">
        <div class="ext-name">${escapeHtml(ext.name)}</div>
        <div class="ext-meta">
          <span class="ext-id" title="${escapeAttr(ext.id)}">${escapeHtml(ext.id)}</span>
          ${isDisabled ? '<span class="badge badge-disabled">off</span>' : ""}
          ${isSideload ? '<span class="badge badge-sideload">sideload</span>' : ""}
        </div>
      </div>
    `;

    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("ext-checkbox")) return;
      toggleSelection(ext.id);
    });
    li.querySelector(".ext-checkbox").addEventListener("change", () => {
      toggleSelection(ext.id);
    });

    els.list.appendChild(li);
  }
}

function renderCookieGroups(grouped) {
  els.list.innerHTML = "";
  for (const domain of Object.keys(grouped)) {
    const cookies = grouped[domain];
    const isSelected = state.selectedIds.has(domain);
    const isExpanded = state.expandedDomains.has(domain);

    const groupLi = document.createElement("li");
    groupLi.className = "domain-group";

    const header = document.createElement("div");
    header.className = "domain-header";
    if (isSelected) header.classList.add("selected");
    header.dataset.domain = domain;

    header.innerHTML = `
      <input type="checkbox" class="ext-checkbox" ${isSelected ? "checked" : ""}>
      <svg class="domain-chevron ${isExpanded ? "open" : ""}" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18l6-6-6-6"/>
      </svg>
      <span class="domain-name" title="${escapeAttr(domain)}">${escapeHtml(domain)}</span>
      <span class="domain-count">${cookies.length}</span>
    `;

    header.addEventListener("click", (e) => {
      if (e.target.classList.contains("ext-checkbox")) return;
      if (e.target.classList.contains("domain-chevron") || e.target.closest(".domain-chevron")) {
        toggleDomainExpansion(domain);
      } else {
        toggleSelection(domain);
      }
    });

    header.querySelector(".ext-checkbox").addEventListener("change", () => {
      toggleSelection(domain);
    });

    groupLi.appendChild(header);

    if (isExpanded) {
      const cookieList = document.createElement("ul");
      cookieList.className = "cookie-list";
      for (const c of cookies) {
        const cookieLi = document.createElement("li");
        cookieLi.className = "cookie-item";
        const flags = [];
        if (c.secure) flags.push('<span class="cookie-flag secure">s</span>');
        if (c.httpOnly) flags.push('<span class="cookie-flag httponly">h</span>');
        if (c.session) flags.push('<span class="cookie-flag">session</span>');
        const truncatedValue = c.value.length > 30 ? c.value.slice(0, 30) + "…" : c.value;
        cookieLi.innerHTML = `
          <span class="cookie-name" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</span>
          <span class="cookie-value" title="${escapeAttr(c.value)}">${escapeHtml(truncatedValue)}</span>
          <span class="cookie-flags">${flags.join("")}</span>
        `;
        cookieList.appendChild(cookieLi);
      }
      groupLi.appendChild(cookieList);
    }

    els.list.appendChild(groupLi);
  }
}

function getBestIcon(ext) {
  if (!ext.icons || ext.icons.length === 0) return null;
  return (ext.icons.find((i) => i.size === 48) || ext.icons.find((i) => i.size === 32) || ext.icons[ext.icons.length - 1]).url;
}


// ---------------------------------------
// selection
// ---------------------------------------

function toggleSelection(id) {
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
  } else {
    state.selectedIds.add(id);
  }
  render();
}

function toggleDomainExpansion(domain) {
  if (state.expandedDomains.has(domain)) {
    state.expandedDomains.delete(domain);
  } else {
    state.expandedDomains.add(domain);
  }
  render();
}

function selectAll() {
  state.selectedIds = new Set(currentItemIds());
  render();
}

function selectNone() {
  state.selectedIds.clear();
  render();
}

function selectInvert() {
  const ids = currentItemIds();
  const next = new Set();
  for (const id of ids) {
    if (!state.selectedIds.has(id)) next.add(id);
  }
  state.selectedIds = next;
  render();
}

function updateSelectionUi() {
  els.selectedCount.textContent = state.selectedIds.size;
  updatePrimaryButton();
}


// ---------------------------------------
// primary action dispatcher
// ---------------------------------------

async function handlePrimaryAction() {
  if (state.type === "extensions") {
    await openSelectedInTabGroup();
  } else if (state.mode === "installed") {
    await exportCookies();
  } else {
    await applyCookies();
  }
}


// ---------------------------------------
// extension tab group action
// ---------------------------------------

async function openSelectedInTabGroup() {
  const list = currentList();
  const selected = list.filter((e) => state.selectedIds.has(e.id));
  if (selected.length === 0) return;

  if (selected.length > 10) {
    if (!confirm(`open ${selected.length} tabs at once?`)) return;
  }

  showStatus(`opening ${selected.length} tab${selected.length === 1 ? "" : "s"}...`);

  try {
    const tabs = [];
    for (const ext of selected) {
      const tab = await chrome.tabs.create({
        url: `${WEBSTORE_BASE}/${ext.id}`,
        active: false,
      });
      tabs.push(tab);
    }

    const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
    await chrome.tabGroups.update(groupId, {
      title: state.mode === "imported" ? `portage: migrate ${selected.length}` : `portage (${selected.length})`,
      color: "cyan",
      collapsed: false,
    });

    showStatus(`opened ${tabs.length} tabs in a group`, "success");
  } catch (err) {
    console.error(err);
    showStatus(`error: ${err.message}`, "error");
  }
}


// ---------------------------------------
// export dispatcher
// ---------------------------------------

function handleExport() {
  if (state.type === "extensions") {
    exportExtensionsToHtml();
  } else {
    exportCookies();
  }
}


// ---------------------------------------
// extension export
// ---------------------------------------

function exportExtensionsToHtml() {
  const list = currentList();
  const toExport = state.selectedIds.size > 0
    ? list.filter((e) => state.selectedIds.has(e.id))
    : list;

  if (toExport.length === 0) {
    showStatus("nothing to export", "error");
    return;
  }

  const exportData = toExport.map((ext) => ({
    id: ext.id,
    name: ext.name,
    version: ext.version || "",
    enabled: ext.enabled !== false,
    homepageUrl: ext.homepageUrl || "",
  }));

  const html = buildExportHtml(exportData);
  downloadBlob(new Blob([html], { type: "text/html" }), `portage-extensions-${dateStamp()}.html`);
  showStatus(`exported ${toExport.length} extensions`, "success");
}

function buildExportHtml(data) {
  const jsonBlob = JSON.stringify({
    type: EXTENSIONS_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    extensions: data,
  }, null, 2);

  const rows = data.map((ext, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="name">${escapeHtml(ext.name)}</td>
      <td class="id"><code>${escapeHtml(ext.id)}</code></td>
      <td class="version">${escapeHtml(ext.version)}</td>
      <td class="status">${ext.enabled ? "" : "off"}</td>
      <td class="link"><a href="${WEBSTORE_BASE}/${escapeAttr(ext.id)}" target="_blank" rel="noopener">install →</a></td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>portage export</title>
<style>
  :root { --bg:#0e1014;--surface:#181b22;--border:#2a2f3a;--text:#e8eaef;--dim:#a4abbc;--muted:#6b7387;--accent:#5eead4; }
  * { margin:0;padding:0;box-sizing:border-box; }
  body { background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.5;padding:32px 24px;min-height:100vh; }
  .container { max-width:900px;margin:0 auto; }
  h1 { font-size:22px;font-weight:600;margin-bottom:4px; }
  .meta { color:var(--muted);font-size:13px;margin-bottom:24px; }
  .toolbar { display:flex;gap:12px;margin-bottom:16px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px; }
  button, .btn { padding:8px 14px;background:var(--accent);color:var(--bg);border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block; }
  button:hover, .btn:hover { opacity:0.9; }
  .btn-secondary { background:transparent;color:var(--dim);border:1px solid var(--border); }
  table { width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden; }
  th, td { padding:10px 12px;text-align:left;font-size:13px; }
  th { background:var(--bg);color:var(--dim);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border); }
  tr { border-bottom:1px solid var(--border); }
  tr:last-child { border-bottom:none; }
  tr:hover td { background:rgba(94,234,212,0.04); }
  .num { color:var(--muted);width:32px; }
  .name { font-weight:500; }
  code { font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dim); }
  .version { color:var(--muted);font-size:12px; }
  .status { color:#f87171;font-size:11px; }
  a { color:var(--accent);text-decoration:none; }
  a:hover { text-decoration:underline; }
  .footer { margin-top:24px;color:var(--muted);font-size:11px;text-align:center; }
</style>
</head>
<body>
<div class="container">
  <h1>portage export</h1>
  <p class="meta">${data.length} extension${data.length === 1 ? "" : "s"} · exported ${new Date().toLocaleString()}</p>
  <div class="toolbar">
    <button onclick="openAll()">open all install pages</button>
    <button class="btn-secondary" onclick="copyJson()">copy json</button>
    <span style="flex:1"></span>
    <span style="color:var(--muted);font-size:12px;align-self:center;">re-import this file in portage to use the tab-group flow</span>
  </div>
  <table>
    <thead><tr><th>#</th><th>name</th><th>id</th><th>version</th><th>state</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">generated by portage by pvrz</div>
</div>
<script id="portage-payload" type="application/json">
${jsonBlob}
</script>
<script>
function openAll() {
  const ext = JSON.parse(document.getElementById("portage-payload").textContent);
  if (!confirm("open " + ext.extensions.length + " tabs?")) return;
  ext.extensions.forEach(e => window.open("${WEBSTORE_BASE}/" + e.id, "_blank"));
}
function copyJson() {
  const t = document.getElementById("portage-payload").textContent.trim();
  navigator.clipboard.writeText(t).then(() => alert("copied"));
}
</script>
</body>
</html>`;
}


// ---------------------------------------
// cookie export
// ---------------------------------------

async function exportCookies() {
  if (state.selectedIds.size === 0) {
    showStatus("select at least one domain", "error");
    return;
  }

  const grouped = state.data.cookiesInstalled;
  const collected = [];
  for (const domain of state.selectedIds) {
    if (grouped[domain]) collected.push(...grouped[domain]);
  }

  if (collected.length === 0) {
    showStatus("no cookies in selection", "error");
    return;
  }

  openModal({
    title: "encrypt cookies?",
    description: `${collected.length} cookies from ${state.selectedIds.size} domain${state.selectedIds.size === 1 ? "" : "s"} will be exported. encryption is strongly recommended — this file contains your login sessions.`,
    mode: "encrypt",
    onConfirm: async ({ passphrase, skip }) => {
      const payload = {
        type: COOKIES_FORMAT,
        version: COOKIES_VERSION,
        exportedAt: new Date().toISOString(),
        encrypted: !skip,
      };

      if (skip) {
        payload.cookies = collected;
      } else {
        try {
          const encrypted = await encryptJson({ cookies: collected }, passphrase);
          Object.assign(payload, encrypted);
        } catch (err) {
          showStatus(`encryption failed: ${err.message}`, "error");
          return;
        }
      }

      const json = JSON.stringify(payload, null, 2);
      downloadBlob(new Blob([json], { type: "application/json" }), `portage-cookies-${dateStamp()}.json`);
      showStatus(`exported ${collected.length} cookies${skip ? " (unencrypted)" : ""}`, "success");
    },
  });
}


// ---------------------------------------
// import dispatcher
// ---------------------------------------

function handleImport(file) {
  if (state.type === "extensions") {
    importExtensionsFromHtml(file);
  } else {
    importCookiesFromJson(file);
  }
}


// ---------------------------------------
// extension import
// ---------------------------------------

function importExtensionsFromHtml(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const html = e.target.result;
      const match = html.match(/<script id="portage-payload"[^>]*>([\s\S]*?)<\/script>/) ||
                    html.match(/<script id="ext-migrator-payload"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) {
        showStatus("not a valid portage export file", "error");
        return;
      }
      const data = JSON.parse(match[1]);
      if (!data.extensions || !Array.isArray(data.extensions)) {
        showStatus("invalid file format", "error");
        return;
      }
      state.data.extensionsImported = data.extensions;
      state.type = "extensions";
      state.mode = "imported";
      state.selectedIds = new Set(data.extensions.map((e) => e.id));
      render();
      showStatus(`imported ${data.extensions.length} extensions`, "success");
    } catch (err) {
      showStatus(`parse error: ${err.message}`, "error");
    }
  };
  reader.onerror = () => showStatus("failed to read file", "error");
  reader.readAsText(file);
}


// ---------------------------------------
// cookie import
// ---------------------------------------

function importCookiesFromJson(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const payload = JSON.parse(e.target.result);
      if (payload.type !== COOKIES_FORMAT && payload.type !== "extension-migrator-cookies") {
        showStatus("not a valid cookies export file", "error");
        return;
      }

      if (payload.encrypted) {
        openModal({
          title: "decrypt cookies",
          description: "this file is encrypted. enter the passphrase used to export it.",
          mode: "decrypt",
          onConfirm: async ({ passphrase }) => {
            try {
              const decrypted = await decryptJson(payload, passphrase);
              if (!decrypted.cookies || !Array.isArray(decrypted.cookies)) {
                showStatus("decrypted but invalid format", "error");
                return;
              }
              loadImportedCookies(decrypted.cookies);
            } catch (err) {
              showStatus("decryption failed — wrong passphrase?", "error");
            }
          },
        });
      } else {
        if (!Array.isArray(payload.cookies)) {
          showStatus("invalid file format", "error");
          return;
        }
        loadImportedCookies(payload.cookies);
      }
    } catch (err) {
      showStatus(`parse error: ${err.message}`, "error");
    }
  };
  reader.readAsText(file);
}

function loadImportedCookies(cookies) {
  state.data.cookiesImported = groupCookiesByDomain(cookies);
  state.type = "cookies";
  state.mode = "imported";
  state.selectedIds = new Set(Object.keys(state.data.cookiesImported));
  render();
  showStatus(`imported ${cookies.length} cookies from ${state.selectedIds.size} domains`, "success");
}


// ---------------------------------------
// apply cookies to browser
// ---------------------------------------

async function applyCookies() {
  const grouped = state.data.cookiesImported;
  const cookies = [];
  for (const domain of state.selectedIds) {
    if (grouped[domain]) cookies.push(...grouped[domain]);
  }

  if (cookies.length === 0) {
    showStatus("no cookies in selection", "error");
    return;
  }

  if (!confirm(`apply ${cookies.length} cookies to the current browser? this will overwrite existing cookies with the same name+domain+path.`)) {
    return;
  }

  showStatus(`applying ${cookies.length} cookies...`);

  let success = 0;
  let failed = 0;
  const errors = [];

  for (const cookie of cookies) {
    try {
      await setCookie(cookie);
      success++;
    } catch (err) {
      failed++;
      if (errors.length < 5) errors.push(`${cookie.domain}/${cookie.name}: ${err.message}`);
    }
  }

  if (failed === 0) {
    showStatus(`applied ${success} cookies`, "success");
  } else {
    console.warn("failed cookies:", errors);
    showStatus(`applied ${success}, failed ${failed} (see console)`, failed > success ? "error" : "");
  }
}

async function setCookie(cookie) {
  const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const protocol = cookie.secure ? "https" : "http";
  const url = `${protocol}://${domain}${cookie.path || "/"}`;

  const details = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };

  if (!cookie.hostOnly) {
    details.domain = cookie.domain;
  }

  const validSameSite = ["no_restriction", "lax", "strict", "unspecified"];
  if (cookie.sameSite && validSameSite.includes(cookie.sameSite)) {
    details.sameSite = cookie.sameSite;
  }

  if (!cookie.session && cookie.expirationDate) {
    if (cookie.expirationDate * 1000 < Date.now()) {
      throw new Error("expired");
    }
    details.expirationDate = cookie.expirationDate;
  }

  if (details.sameSite === "no_restriction" && !details.secure) {
    details.secure = true;
  }

  await chrome.cookies.set(details);
}


// ---------------------------------------
// crypto (web crypto api)
// ---------------------------------------

async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJson(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson(payload, passphrase) {
  const salt = base64ToBuf(payload.salt);
  const iv = base64ToBuf(payload.iv);
  const ciphertext = base64ToBuf(payload.ciphertext);
  const iterations = payload.iterations || PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function bufToBase64(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}


// ---------------------------------------
// modal
// ---------------------------------------

let modalCallback = null;

function openModal({ title, description, mode, onConfirm }) {
  els.modalTitle.textContent = title;
  els.modalDesc.textContent = description;
  els.modalPass.value = "";
  els.modalPassConfirm.value = "";
  els.modalSkip.checked = false;
  els.modalWarn.classList.add("hidden");

  if (mode === "encrypt") {
    els.modalPassConfirm.classList.remove("hidden");
    els.modalSkipWrap.classList.remove("hidden");
  } else {
    els.modalPassConfirm.classList.add("hidden");
    els.modalSkipWrap.classList.add("hidden");
  }

  modalCallback = { mode, onConfirm };
  els.modal.classList.remove("hidden");
  setTimeout(() => els.modalPass.focus(), 50);
}

function closeModal() {
  els.modal.classList.add("hidden");
  modalCallback = null;
}

async function confirmModal() {
  if (!modalCallback) return;
  const { mode, onConfirm } = modalCallback;

  if (mode === "encrypt" && els.modalSkip.checked) {
    if (!confirm("export cookies as plain json? anyone with this file can use your sessions.")) return;
    closeModal();
    onConfirm({ passphrase: null, skip: true });
    return;
  }

  const passphrase = els.modalPass.value;
  if (!passphrase || passphrase.length < 8) {
    showModalWarn("passphrase must be at least 8 characters");
    return;
  }

  if (mode === "encrypt") {
    if (passphrase !== els.modalPassConfirm.value) {
      showModalWarn("passphrases don't match");
      return;
    }
  }

  closeModal();
  onConfirm({ passphrase, skip: false });
}

function showModalWarn(message) {
  els.modalWarn.textContent = message;
  els.modalWarn.classList.remove("hidden");
}


// ---------------------------------------
// status toast
// ---------------------------------------

let statusTimer = null;

function showStatus(message, type = "") {
  els.statusEl.textContent = message;
  els.statusEl.className = `status ${type}`;
  els.statusEl.classList.remove("hidden");
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.statusEl.classList.add("hidden"), 3000);
}


// ---------------------------------------
// utils
// ---------------------------------------

function dateStamp() {
  return new Date().toISOString().split("T")[0];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}


// ---------------------------------------
// tab switching
// ---------------------------------------

function switchType(type) {
  if (state.type === type) return;
  state.type = type;
  state.selectedIds.clear();
  state.expandedDomains.clear();
  render();
}

function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.selectedIds.clear();
  state.expandedDomains.clear();
  render();
}


// ---------------------------------------
// event listeners
// ---------------------------------------

function attachEventListeners() {
  $("refresh-btn").addEventListener("click", async () => {
    if (state.type === "extensions") {
      await loadExtensions();
    } else {
      await loadCookies();
    }
    if (state.mode === "installed") {
      state.selectedIds.clear();
    }
    render();
    showStatus("refreshed", "success");
  });

  $("select-all").addEventListener("click", selectAll);
  $("select-none").addEventListener("click", selectNone);
  $("select-invert").addEventListener("click", selectInvert);

  els.primaryBtn.addEventListener("click", handlePrimaryAction);
  $("export-btn").addEventListener("click", handleExport);

  $("import-btn").addEventListener("click", () => els.importInput.click());
  els.importInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleImport(file);
    e.target.value = "";
  });

  document.querySelectorAll(".type-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchType(tab.dataset.type));
  });
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  els.modalConfirm.addEventListener("click", confirmModal);
  els.modalCancel.addEventListener("click", closeModal);
  els.modalClose.addEventListener("click", closeModal);
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });
  [els.modalPass, els.modalPassConfirm].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmModal();
      if (e.key === "Escape") closeModal();
    });
  });
}
