/*
Portage by pvrz
https://github.com/pvrzz/Portage/
File Name: theme.js
*/

(function () {
  const KEY = "portage:theme";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

  const state = Object.assign({ mode: "system", accent: null }, load());

  function hexToRgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    const t = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
    return "#" + t(r) + t(g) + t(b);
  }
  function hexToHsl(hex) {
    let { r, g, b } = hexToRgb(hex);
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }
  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  const LIGHT = { "--bg": 98, "--paper": 100, "--line": 91, "--ink-100": 96, "--ink-200": 90, "--ink-300": 83, "--ink-400": 64, "--ink-500": 46, "--ink-600": 37, "--ink-700": 28, "--ink-800": 18, "--ink-900": 11 };
  const DARK = { "--bg": 8, "--paper": 11, "--line": 19, "--ink-100": 16, "--ink-200": 25, "--ink-300": 34, "--ink-400": 46, "--ink-500": 63, "--ink-600": 74, "--ink-700": 83, "--ink-800": 90, "--ink-900": 96 };

  function effectiveDark() {
    if (state.mode === "dark") return true;
    if (state.mode === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function apply() {
    const root = document.documentElement;
    const dark = effectiveDark();
    root.setAttribute("data-mode", dark ? "dark" : "light");

    const accent = state.accent;
    const stops = dark ? DARK : LIGHT;
    const hsl = accent ? hexToHsl(accent) : { h: 0, s: 0, l: 0.5 };
    const tint = accent ? Math.min(hsl.s * 0.5, 0.14) : 0;

    for (const k in stops) {
      const isSurface = k === "--bg" || k === "--paper";
      const s = isSurface ? tint * 0.6 : tint;
      root.style.setProperty(k, hslToHex(hsl.h, s, stops[k] / 100));
    }

    let aHex, aContrast;
    if (accent) {
      aHex = hslToHex(hsl.h, clamp(hsl.s, 0.45, 0.95), clamp(hsl.l, 0.42, 0.64));
      aContrast = luminance(aHex) > 0.42 ? "#101012" : "#ffffff";
    } else {
      aHex = dark ? hslToHex(0, 0, DARK["--ink-900"] / 100) : hslToHex(0, 0, LIGHT["--ink-900"] / 100);
      aContrast = dark ? hslToHex(0, 0, DARK["--bg"] / 100) : hslToHex(0, 0, LIGHT["--bg"] / 100);
    }
    root.style.setProperty("--accent", aHex);
    root.style.setProperty("--accent-contrast", aContrast);
  }

  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.mode === "system") { apply(); refresh(); } });
  } catch {}

  apply();

  let els = null;
  function refresh() {
    if (!els) return;
    els.modePills.forEach((p) => p.classList.toggle("active", p.dataset.mode === state.mode));
    els.defaultPill.classList.toggle("active", !state.accent);
    const c = state.accent || "#18181b";
    els.accentInput.value = c;
    els.preview.style.background = state.accent ? c : "linear-gradient(135deg, var(--ink-300), var(--ink-700))";
  }

  function initControls() {
    const btn = document.getElementById("themeBtn");
    const pop = document.getElementById("themePop");
    if (!btn || !pop) return;
    els = {
      modePills: Array.from(pop.querySelectorAll("[data-mode]")),
      defaultPill: pop.querySelector("#accentDefault"),
      accentInput: pop.querySelector("#accentInput"),
      preview: pop.querySelector("#accentPreview"),
    };

    btn.addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add("hidden"); });
    pop.addEventListener("click", (e) => e.stopPropagation());

    els.modePills.forEach((p) => p.addEventListener("click", () => { state.mode = p.dataset.mode; save(state); apply(); refresh(); }));
    els.defaultPill.addEventListener("click", () => { state.accent = null; save(state); apply(); refresh(); });
    els.accentInput.addEventListener("input", () => { state.accent = els.accentInput.value; save(state); apply(); refresh(); });

    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initControls);
  else initControls();

  window.PortageTheme = { apply, set(p) { Object.assign(state, p); save(state); apply(); refresh(); }, get() { return Object.assign({}, state); } };
})();
