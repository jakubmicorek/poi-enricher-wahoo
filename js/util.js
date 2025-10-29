export const $  = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));
export const setTopStatus = (m) => { const el = $("#status"); if (el) el.textContent = m || ""; };
export const setPoiStatus = (m) => { const el = $("#poi-status"); if (el) el.textContent = m || ""; };

export function debounce(fn, wait=150) { let t=null; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export const row = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
