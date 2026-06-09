/*
Portage by pvrz
https://github.com/pvrzz/Portage/
File Name: popup.js
*/

const api = typeof browser !== "undefined" ? browser : chrome;
const IS_FIREFOX = navigator.userAgent.includes("Firefox");
document.getElementById("sub").textContent = "Export & Import · " + (IS_FIREFOX ? "Firefox" : "Chrome");

function fmt(n) {
  if (n === null || n === undefined) return "·";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

async function quickCounts() {
  try {
    const tree = await api.bookmarks.getTree();
    let books = 0;
    (function walk(nodes) { for (const n of nodes) { if (n.url) books++; if (n.children) walk(n.children); } })(tree);
    document.getElementById("s-book").textContent = fmt(books);
  } catch { document.getElementById("s-book").textContent = "—"; }

  try {
    const since = Date.now() - 90 * 864e5;
    const items = await api.history.search({ text: "", startTime: since, maxResults: 100000 });
    document.getElementById("s-hist").textContent = fmt(items.length);
  } catch { document.getElementById("s-hist").textContent = "—"; }

  try {
    const tabs = await api.tabs.query({});
    document.getElementById("s-tabs").textContent = fmt(tabs.length);
  } catch { document.getElementById("s-tabs").textContent = "—"; }
}

document.getElementById("open").addEventListener("click", async () => {
  await api.tabs.create({ url: api.runtime.getURL("dashboard.html") });
  window.close();
});

quickCounts();
