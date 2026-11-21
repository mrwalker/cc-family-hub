/* Family trip app engine — shared by every trip page (/<trip>/).
 *
 * window.TRIP (each trip's trip-data.js) may set storagePrefix to keep the
 * localStorage key stable across renames (default "family-trip").
 *
 * Each trip folder has its own index.html, trip-data.js (window.TRIP), sw.js,
 * and img/. This file is the app:
 * routing, rendering, scoring, and an offline-first sync engine.
 *
 * Sync model: every quest check-in gets a random id and is saved locally
 * first. When the phone is online it is pushed to /api/trip/:id/checkins
 * (Workers KV), and the full family list comes back. Packing checklists
 * sync the same way (newest timestamp wins per person).
 */
(() => {
  "use strict";

  const T = window.TRIP;
  const API = `/api/trip/${T.id}`;
  const KEY = `${T.storagePrefix || "family-trip"}:${T.id}`;
  const SYNC_EVERY_MS = 2 * 60 * 1000;
  const REMOTE_DELETE_GRACE_MS = 3 * 60 * 1000; // KV list() can lag ~60s

  const MEMBER = Object.fromEntries(T.members.map(m => [m.id, m]));
  const CAT    = Object.fromEntries(T.categories.map(c => [c.id, c]));
  const QUEST  = Object.fromEntries(T.quests.map(q => [q.id, q]));

  // ── State ──────────────────────────────────────────────────────────────
  const blank = () => ({
    me: null,
    mine: {},        // check-ins created on this device, by id
    sentAt: {},      // id → when the server confirmed it
    deleted: {},     // id → true (tombstones, local)
    pendUp: {},      // id → true (needs upload)
    pendDel: {},     // id → true (needs delete on server)
    server: [],      // last full list from the server
    packing: {},     // member → {checked:[], ts} edited on this device
    packPend: {},    // member → true
    serverPacking: {},
    asks: {},        // questions for the assistant written on this device, by id
    askPend: {},     // id → true (not sent yet)
    inbox: null,     // the last { threads, notes, name } from the hub, or null without an assistant
    lastSync: 0,
  });

  let state = load();
  let sync = { status: "idle", busy: false, last: 0 };
  let ui = { questCat: "all", day: null, packFor: null, offlineReady: false };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch { return blank(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode / full */ }
  }

  // ── Small helpers ──────────────────────────────────────────────────────
  const $ = sel => document.querySelector(sel);
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);

  const qs = new URLSearchParams(location.search);
  const DEBUG_DATE = qs.get("date"); // ?date=2026-11-25 to preview a trip day
  const DEBUG_TIME = qs.get("time"); // ?time=14:30

  function tzParts(d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: T.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour) * 60 + (+p.minute) };
  }
  const today = () => DEBUG_DATE || tzParts().date;
  const nowMinutes = () => {
    if (DEBUG_TIME) { const [hh, mm] = DEBUG_TIME.split(":").map(Number); return hh * 60 + (mm || 0); }
    return tzParts().minutes;
  };
  const isoToUTC = iso => new Date(iso + "T12:00:00Z");
  const daysBetween = (a, b) => Math.round((isoToUTC(b) - isoToUTC(a)) / 86400000);
  const fmtDay = (iso, opts = { weekday: "short", month: "short", day: "numeric" }) =>
    new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(isoToUTC(iso));
  const toMin = t => { if (!t) return null; const [hh, mm] = t.split(":").map(Number); return hh * 60 + mm; };
  const fmtTime = t => {
    const m = toMin(t); if (m == null) return "";
    const hh = Math.floor(m / 60), mm = m % 60, ap = hh >= 12 ? "PM" : "AM";
    return `${((hh + 11) % 12) + 1}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${ap}`;
  };
  const ago = ts => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return fmtDay(tzParts(new Date(ts)).date, { weekday: "short" });
  };

  function phase() {
    const d = today();
    if (d < T.start) return "before";
    if (d > T.end) return "after";
    return "during";
  }
  const dayIndex = () => daysBetween(T.start, today()) + 1;
  const tripLength = () => daysBetween(T.start, T.end) + 1;

  const av = (id, cls = "") => {
    const m = MEMBER[id]; if (!m) return "";
    return `<span class="av ${cls}" style="--c:${m.color}" title="${h(m.name)}">${h(m.name[0])}</span>`;
  };

  // ── Check-ins + scoring ────────────────────────────────────────────────
  function allCheckins() {
    const map = new Map();
    for (const c of state.server) map.set(c.id, c);
    for (const c of Object.values(state.mine)) map.set(c.id, c);
    for (const id of Object.keys(state.deleted)) map.delete(id);
    return [...map.values()].filter(c => QUEST[c.quest] && MEMBER[c.member]);
  }

  function computeScores() {
    const cis = allCheckins().sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const firstTs = {};
    const done = Object.fromEntries(T.members.map(m => [m.id, new Map()]));
    for (const c of cis) {
      if (firstTs[c.quest] == null) firstTs[c.quest] = c.ts;
      if (!done[c.member].has(c.quest)) done[c.member].set(c.quest, c);
    }
    const rows = T.members.map(m => {
      const quests = [...done[m.id].values()];
      let base = 0, firsts = 0;
      const catCount = {};
      for (const c of quests) {
        const q = QUEST[c.quest];
        base += q.pts;
        if (c.ts === firstTs[c.quest]) firsts++;
        catCount[q.cat] = (catCount[q.cat] || 0) + 1;
      }
      const allCats = T.categories.every(cat => catCount[cat.id]);
      const badges = T.categories.filter(cat => (catCount[cat.id] || 0) >= cat.badgeAt);
      const total = base + firsts * T.scoring.firstBonus + (allCats ? T.scoring.varietyBonus : 0);
      return { id: m.id, total, base, firsts, allCats, catCount, badges, count: quests.length, done: done[m.id] };
    });
    rows.sort((a, b) => b.total - a.total || b.count - a.count || a.id.localeCompare(b.id));
    const familyDone = new Set(cis.map(c => c.quest));
    return { rows, firstTs, familyDone, cis };
  }

  function whoDid(questId) {
    const seen = new Map();
    for (const c of allCheckins().sort((a, b) => a.ts - b.ts)) {
      if (c.quest === questId && !seen.has(c.member)) seen.set(c.member, c);
    }
    return [...seen.values()];
  }

  function logQuest(questId, members) {
    const ts = Date.now();
    const before = computeScores();
    const isFirst = !before.familyDone.has(questId);
    for (const m of members) {
      const id = newId();
      state.mine[id] = { id, member: m, quest: questId, ts };
      state.pendUp[id] = true;
    }
    save();
    const q = QUEST[questId];
    const bonus = isFirst ? ` — first +${T.scoring.firstBonus}` : "";
    const whoTxt = members.length === 1 ? MEMBER[members[0]].name : `${members.length} players`;
    toast(`+${q.pts} ${whoTxt}${bonus}`);
    confetti();
    // The variety bonus is the headline moment — call it out.
    const after = computeScores();
    for (const m of members) {
      const was = before.rows.find(r => r.id === m), now = after.rows.find(r => r.id === m);
      if (!was.allCats && now.allCats) setTimeout(() => toast(`${MEMBER[m].name} — every category +${T.scoring.varietyBonus}`), 2200);
    }
    doSync(true);
  }

  function undoCheckin(id) {
    state.deleted[id] = true;
    if (state.pendUp[id]) { delete state.pendUp[id]; delete state.mine[id]; }
    else state.pendDel[id] = true;
    save();
    doSync(true);
  }

  // ── Packing ────────────────────────────────────────────────────────────
  function packItemsFor(member) {
    return T.packing.map(g => ({ ...g, items: g.items.filter(i => !i.who || i.who.includes(member)) }))
      .filter(g => g.items.length);
  }
  function packChecked(member) {
    const a = state.packing[member], b = state.serverPacking[member];
    const pick = !a ? b : !b ? a : (a.ts >= b.ts ? a : b);
    return new Set(pick ? pick.checked : []);
  }
  function packProgress(member) {
    const items = packItemsFor(member).flatMap(g => g.items);
    const checked = packChecked(member);
    const n = items.filter(i => checked.has(i.id)).length;
    return { n, total: items.length, pct: items.length ? Math.round((n / items.length) * 100) : 0 };
  }
  function togglePack(member, itemId) {
    const set = packChecked(member);
    set.has(itemId) ? set.delete(itemId) : set.add(itemId);
    state.packing[member] = { checked: [...set], ts: Date.now() };
    state.packPend[member] = true;
    save();
    clearTimeout(togglePack._t);
    togglePack._t = setTimeout(() => doSync(true), 1500);
  }

  // ── Sync ───────────────────────────────────────────────────────────────
  async function api(path, body) {
    const opts = { credentials: "same-origin", cache: "no-store", redirect: "manual", headers: {} };
    if (body) { opts.method = "POST"; opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    const r = await fetch(API + path, opts);
    // Cloudflare Access redirects to its login page when the session lapses.
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) throw Object.assign(new Error("auth"), { auth: true });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function doSync(force = false) {
    if (sync.busy) { sync.again = true; return; }
    if (!force && Date.now() - sync.last < 20000) return;
    if (!navigator.onLine) { sync.status = "offline"; renderSync(); return; }
    sync.busy = true; sync.last = Date.now(); sync.status = "syncing"; renderSync();
    try {
      // Check-ins
      const up = Object.keys(state.pendUp).map(id => state.mine[id]).filter(Boolean);
      const del = Object.keys(state.pendDel);
      const data = await api("/checkins", (up.length || del.length) ? { upserts: up, deletes: del } : null);
      const now = Date.now();
      for (const c of up) { delete state.pendUp[c.id]; state.sentAt[c.id] = now; }
      for (const id of del) delete state.pendDel[id];
      state.server = Array.isArray(data.checkins) ? data.checkins : [];
      // If someone else removed one of ours, stop resurrecting it.
      const onServer = new Set(state.server.map(c => c.id));
      for (const id of Object.keys(state.mine)) {
        if (!state.pendUp[id] && !onServer.has(id) && state.sentAt[id] && now - state.sentAt[id] > REMOTE_DELETE_GRACE_MS) {
          delete state.mine[id]; delete state.sentAt[id];
        }
      }
      if (!state.me && data.viewer && MEMBER[data.viewer]) state.me = data.viewer;

      // Packing
      const lists = {};
      for (const m of Object.keys(state.packPend)) if (state.packing[m]) lists[m] = state.packing[m];
      const pk = await api("/packing", Object.keys(lists).length ? { lists } : null);
      state.serverPacking = pk.lists || {};
      for (const m of Object.keys(lists)) {
        const s = state.serverPacking[m];
        if (s && s.ts >= lists[m].ts) delete state.packPend[m];
      }

      // Questions for the assistant. A hub without one (or an older hub) answers 404: skip it.
      try {
        for (const id of Object.keys(state.askPend)) {
          const a = state.asks[id];
          if (a) state.inbox = await api("/inbox", { id: a.id, body: a.body, threadId: a.threadId || undefined });
          delete state.askPend[id];
        }
        state.inbox = await api("/inbox");
        const answered = new Set((state.inbox.threads || []).flatMap(t => t.messages.map(m => m.id)));
        for (const id of Object.keys(state.asks)) if (answered.has(id) && !state.askPend[id]) delete state.asks[id];
      } catch (e) {
        if (e.auth) throw e;
        if (/HTTP 404/.test(e.message)) state.inbox = null;
      }

      state.lastSync = Date.now();
      sync.status = "ok";
      save();
    } catch (e) {
      sync.status = e.auth ? "auth" : (navigator.onLine ? "error" : "offline");
    } finally {
      sync.busy = false;
      renderSync();
      render(false);
      if (sync.again) { sync.again = false; doSync(true); }
    }
  }

  function pendingCount() {
    return Object.keys(state.pendUp).length + Object.keys(state.pendDel).length + Object.keys(state.packPend).length + Object.keys(state.askPend).length;
  }

  function renderSync() {
    const el = $("#sync");
    const p = pendingCount();
    const ready = ui.offlineReady ? "Offline ready" : "";
    let txt, st = "ok";
    switch (sync.status) {
      case "syncing": txt = "Syncing"; break;
      case "ok":      txt = p ? `${p} queued` : (ready || "Synced"); break;
      case "auth":    txt = p ? `Sign in to sync ${p}` : "Saved on device"; st = "warn"; break;
      case "offline":
      case "error":   txt = p ? `${p} queued — offline` : (ready || "Offline"); st = p ? "warn" : "ok"; break;
      default:        txt = ready;
    }
    el.textContent = txt;
    el.dataset.state = st;
    el.title = state.lastSync ? `Last synced ${ago(state.lastSync)}` : "Not synced yet";
  }

  // ── UI chrome ──────────────────────────────────────────────────────────
  const svg = p => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const ICON = {
    today:    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    schedule: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    quests:   '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    board:    '<path d="M5.5 20v-7M12 20V4.5M18.5 20v-10"/>',
    pack:     '<path d="M6 8.5h12l-1 11.5H7z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
  };
  const CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
  const TABS = [["today", "Today"], ["schedule", "Plan"], ["quests", "Quests"], ["board", "Scores"], ["pack", "Pack"]];
  const pad2 = n => String(n).padStart(2, "0");

  function renderTabs() {
    $("#tabs").innerHTML = TABS.map(([id, label]) =>
      `<a href="#${id}" data-tab="${id}">${svg(ICON[id])}<span>${label}</span></a>`).join("");
  }

  function renderChrome() {
    const bg = $(".bg");
    // The gradient layer gets the same size/position as the photo, so its bottom
    // edge always fades into the page color (no seam when the photo doesn't
    // fill the screen, e.g. a wide photo on a tall tablet).
    if (T.photo && !bg.style.backgroundImage) {
      bg.style.backgroundImage = `linear-gradient(to bottom, transparent 60%, var(--sea-900) 100%), url("${T.photo.src}")`;
    }
    const ph = phase();
    const k = $("#heroKicker"), s = $("#heroSub");
    if (ph === "before") {
      const n = daysBetween(today(), T.start);
      k.textContent = n === 1 ? "Tomorrow" : `T-minus ${n} days`;
    } else if (ph === "during") {
      k.textContent = `Day ${dayIndex()} / ${tripLength()} — ${fmtDay(today(), { weekday: "long" })}`;
    } else {
      k.textContent = "Trip complete";
    }
    const sameMonth = T.start.slice(0, 7) === T.end.slice(0, 7);
    s.textContent = `${T.resort} — ${fmtDay(T.start, { month: "short", day: "numeric" })}–${fmtDay(T.end, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
    $("#heroTitle").innerHTML = `${h(T.title)}<span>${h(T.titleAccent || "")}</span>`;

    const me = MEMBER[state.me];
    $("#meChip").innerHTML = me ? `${av(me.id, "sm")}<span>${h(me.name)}</span>` : `<span>Choose player</span>`;

    $("#credit").innerHTML = T.photo
      ? `Photo <a href="${h(T.photo.url)}" target="_blank" rel="noopener">${h(T.photo.credit)}</a> / ${h(T.photo.license)}`
      : "";
  }

  function currentTab() {
    const t = (location.hash || "#today").slice(1);
    return ["today", "schedule", "quests", "board", "pack"].includes(t) ? t : "today";
  }

  function render(scrollTop = false) {
    renderChrome();
    const tab = currentTab();
    document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
    const view = $("#view");
    view.innerHTML = ({ today: viewToday, schedule: viewSchedule, quests: viewQuests, board: viewBoard, pack: viewPack })[tab]();
    if (scrollTop) window.scrollTo({ top: 0 });
  }

  // ── Building blocks ────────────────────────────────────────────────────
  const panel = (label, body, link, cls = "") => `<section class="panel ${cls}">
    ${label ? `<header class="ph"><span class="label">${h(label)}</span>${link ? `<a class="more" href="${link[1]}">${h(link[0])} →</a>` : ""}</header>` : ""}
    ${body}</section>`;

  const factsHtml = () => `<dl class="facts">${T.quickFacts.map(f =>
    `<div><dt>${h(f.label)}</dt><dd>${h(f.value)}</dd></div>`).join("")}</dl>`;

  function tipHtml(i) {
    const tip = T.tips[((i % T.tips.length) + T.tips.length) % T.tips.length];
    return panel("", `<span class="label accent">Field note</span><h3 class="tip-h">${h(tip.title)}</h3><p class="tip-p">${h(tip.text)}</p>`);
  }

  // Strip the "Title:" colon used in overview data → label column.
  const infoList = rows => `<dl class="info">${rows.map(([k, v]) =>
    `<div><dt>${h(String(k).replace(/:$/, ""))}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

  function dayList() {
    const t = today();
    return `<div class="rows">${T.days.map(d => `<a class="dayrow ${d.date === t ? "today" : ""}" href="#schedule" data-day="${d.date}">
      <span class="label">${h(fmtDay(d.date, { weekday: "short" }))} ${h(fmtDay(d.date, { day: "numeric" }))}</span>
      <span class="t">${h(d.title)}<span class="s">${h(d.summary)}</span></span></a>`).join("")}</div>`;
  }

  function miniBoard() {
    const { rows } = computeScores();
    if (!rows.some(r => r.total)) return "";
    return panel("Leaders", rows.slice(0, 3).map((r, i) => rankRow(r, i, rows[0].total)).join(""), ["All scores", "#board"]);
  }

  // ── Views ──────────────────────────────────────────────────────────────
  // ── Ask the assistant ──────────────────────────────────────────────────
  // Questions go to the family's assistant in its chat; answers come back on the next
  // sync. Written offline, they wait on this device until there's a connection.
  function askPanel() {
    const box = state.inbox;
    if (!box) return "";
    const name = box.name || "the assistant";
    const note = (box.notes || [])[0];
    const waiting = Object.values(state.asks).filter(a => state.askPend[a.id]);
    const threads = (box.threads || []).slice(0, 3);
    return panel(`Ask ${name}`, `
      ${note ? `<p class="note top ask-note">${h(note.body)}</p>` : ""}
      ${waiting.map(a => `<div class="ask-msg"><b>You:</b> ${h(a.body)}<small>${navigator.onLine ? "Sending…" : "Sends when you’re online"}</small></div>`).join("")}
      ${threads.map(t => `<div class="ask-thread">${t.messages.slice(-3).map(m => `<div class="ask-msg ${m.kind === "reply" ? "reply" : ""}"><b>${h(m.mine ? "You" : m.by)}:</b> ${h(m.body)}</div>`).join("")}
        ${t.messages[t.messages.length - 1].kind === "reply" ? "" : `<small class="ask-wait">${h(name)} is on it…</small>`}</div>`).join("")}
      <div class="actions"><button class="btn ghost" data-action="ask">Ask a question</button></div>`);
  }

  function askSheet() {
    const name = (state.inbox && state.inbox.name) || "the assistant";
    openSheet(`<div class="sheet-head"><span class="label">Ask ${h(name)}</span></div>
      <p>Ask anything about the trip, or ask ${h(name)} to add a restaurant, something to do, or an idea. It answers here in a minute or two, and the trip’s chat sees it too.</p>
      <textarea id="askText" class="ask-input" maxlength="1000" rows="4" placeholder="Is there a good taco place near the hotel?"></textarea>
      <div class="actions"><button class="btn" data-action="ask-send">Send</button><button class="btn ghost" data-close>Close</button></div>`);
    setTimeout(() => { const t = $("#askText"); if (t) t.focus(); }, 50);
  }

  function sendAsk() {
    const text = ($("#askText")?.value || "").trim();
    if (!text) return;
    const id = "ask-" + newId().slice(0, 20);
    state.asks[id] = { id, body: text.slice(0, 1000), ts: Date.now() };
    state.askPend[id] = true;
    save(); closeSheet(); render();
    toast(navigator.onLine ? "Sent" : "Saved. It sends when you’re online");
    doSync(true);
  }

  function viewToday() {
    const ph = phase();
    const dayNum = daysBetween(T.start, today());
    if (ph === "before") {
      const n = daysBetween(today(), T.start);
      const totalPts = T.quests.reduce((s, q) => s + q.pts, 0);
      return `
        ${panel("", `<div class="count"><div class="count-num">${pad2(n)}</div>
          <div class="count-meta"><span class="label hi">${n === 1 ? "day" : "days"} ${h(T.text.countdown)}</span>
          <span class="muted">${h(fmtDay(T.start, { weekday: "long", month: "long", day: "numeric" }))} — ${h(T.departNote)}</span></div></div>
          ${factsHtml()}`)}
        ${panel("Packing", `<div class="who-row inset">${T.members.map(m => packRing(m.id, false)).join("")}</div>
          <p class="note">Progress syncs across everyone’s phones. Bags packed by <b>${h(T.packBy)}</b>.</p>`, ["My list", "#pack"])}
        ${panel("The plan", dayList(), ["Details", "#schedule"])}
        ${askPanel()}
        ${panel("Quests", `<p class="note top">${T.quests.length} quests, ${totalPts} points. ${h(T.text.questPitch)}</p>
          <div class="rows">${T.quests.filter(q => q.featured).slice(0, 4).map(questRow).join("")}</div>`, ["Browse", "#quests"])}
        ${tipHtml(new Date().getDate())}`;
    }
    if (ph === "during") {
      const d = T.days.find(x => x.date === today());
      const dayQuests = (d?.quests || []).map(id => QUEST[id]).filter(Boolean);
      return `
        ${d ? panel("", `${dayHeader(d)}${timeline(d, true)}`) : ""}
        ${dayQuests.length ? panel("Today’s quests", `<div class="rows">${dayQuests.map(questRow).join("")}</div>`, ["All", "#quests"]) : ""}
        ${askPanel()}
        ${miniBoard()}
        ${tipHtml(dayNum)}
        ${panel(T.text.conditions.replace(/^[^\w]+/, ""), factsHtml().replace('class="facts"', 'class="facts flush"'))}`;
    }
    const { rows, familyDone } = computeScores();
    return `
      ${panel("Final standings", `<p class="note top">${familyDone.size} of ${T.quests.length} quests completed together.</p>
        ${rows.map((r, i) => rankRow(r, i, rows[0].total || 1)).join("")}`)}
      ${askPanel()}
      ${tipHtml(0)}`;
  }

  function dayHeader(d) {
    return `<div class="dayhead"><span class="label">${h(fmtDay(d.date, { weekday: "long", month: "short", day: "numeric" }))}</span>
      <h2>${h(d.title)}</h2>${d.summary ? `<p>${h(d.summary)}</p>` : ""}</div>`;
  }

  function timeline(d, live) {
    const isToday = live && d.date === today();
    const now = nowMinutes();
    let nowIdx = -1;
    if (isToday) d.items.forEach((it, i) => { const m = toMin(it.time); if (m != null && m <= now) nowIdx = i; });
    return `<ol class="tl">${d.items.map((it, i) => {
      const cls = isToday ? (i === nowIdx ? "now" : i < nowIdx ? "past" : "") : "";
      const tags = (it.tags || []).map(t => `<span class="tag ${t.startsWith("!") ? "warn" : ""}">${h(t.replace(/^!/, ""))}</span>`).join("");
      return `<li class="${cls}"><time>${i === nowIdx ? "Now" : h(it.when || fmtTime(it.time))}</time><div>
        <div class="h">${h(it.title)}${tags}</div>
        ${it.detail ? `<div class="d">${h(it.detail)}</div>` : ""}</div></li>`;
    }).join("")}</ol>`;
  }

  function viewSchedule() {
    const t = today();
    if (!ui.day) ui.day = T.days.some(d => d.date === t) ? t : T.days[0].date;
    const d = T.days.find(x => x.date === ui.day) || T.days[0];
    const dayQuests = (d.quests || []).map(id => QUEST[id]).filter(Boolean);
    return `
      <div class="daytabs">${T.days.map(x => `<button class="daytab ${x.date === d.date ? "on" : ""} ${x.date === t ? "today" : ""}" data-day="${x.date}">
        <small>${h(fmtDay(x.date, { weekday: "short" }))}</small><b>${h(pad2(fmtDay(x.date, { day: "numeric" })))}</b></button>`).join("")}</div>
      ${panel("", `${dayHeader(d)}${timeline(d, true)}`)}
      ${d.notes?.length ? panel("Notes", `<ul class="notes">${d.notes.map(n => `<li>${h(n)}</li>`).join("")}</ul>`) : ""}
      ${dayQuests.length ? panel("Quests to try", `<div class="rows">${dayQuests.map(questRow).join("")}</div>`) : ""}
      ${panel("Trip info", infoList(T.overview.map(o => [o.title, h(o.text)])))}`;
  }

  function questRow(q) {
    const me = state.me;
    const did = whoDid(q.id);
    const mine = me && did.some(c => c.member === me);
    return `<button class="q ${mine ? "done" : ""}" data-quest="${q.id}">
      <span><span class="qt">${h(q.title)}</span>
        <span class="qm">${h(CAT[q.cat].name)}${q.where ? ` — ${h(q.where)}` : ""}</span></span>
      <span class="stack">${did.slice(0, 5).map(c => av(c.member, "sm")).join("")}</span>
      <span class="pts">${mine ? "Done" : `+${q.pts}`}</span></button>`;
  }

  function viewQuests() {
    const me = state.me;
    const { rows } = computeScores();
    const myRow = rows.find(r => r.id === me);
    const cats = [{ id: "all", name: "All" }, { id: "todo", name: "Open" }, ...T.categories];
    let list = T.quests;
    if (ui.questCat === "todo") list = list.filter(q => !(me && whoDid(q.id).some(c => c.member === me)));
    else if (ui.questCat !== "all") list = list.filter(q => q.cat === ui.questCat);
    const catInfo = CAT[ui.questCat];
    const left = myRow ? T.categories.length - Object.keys(myRow.catCount).length : 0;
    return `
      ${me && myRow ? panel(`${MEMBER[me].name}`, `<div class="score"><div class="score-num">${myRow.total}<small>pts</small></div>
          <span class="label">${myRow.count}/${T.quests.length}</span></div>
          <div class="progress"><i style="width:${Math.round(myRow.count / T.quests.length * 100)}%"></i></div>
          <div class="statline">${myRow.firsts} first finds — ${myRow.allCats ? `all categories +${T.scoring.varietyBonus}` : `${left} ${left === 1 ? "category" : "categories"} left for +${T.scoring.varietyBonus}`}</div>`)
        : panel("No player selected", `<p class="note top">Choose who’s using this device so quests count.</p><div class="actions"><button class="btn" data-action="pick-me">Choose player</button></div>`)}
      <div class="chips">${cats.map(c => `<button class="chip ${ui.questCat === c.id ? "on" : ""}" data-cat="${c.id}">${h(c.name)}</button>`).join("")}</div>
      ${panel("", `${catInfo ? `<p class="note top">${h(catInfo.blurb)} ${catInfo.badgeAt} for the ${h(catInfo.badge)} badge.</p>` : ""}
        ${list.length ? `<div class="rows">${list.map(questRow).join("")}</div>` : `<div class="empty">All done here</div>`}`)}`;
  }

  function rankRow(r, i, top) {
    const pct = top ? Math.round(r.total / top * 100) : 0;
    const extras = [`${r.count} ${r.count === 1 ? "quest" : "quests"}`, `${r.firsts} ${r.firsts === 1 ? "first" : "firsts"}`]
      .concat(r.allCats ? ["all categories"] : [], r.badges.map(b => b.badge));
    return `<div class="rank ${i === 0 && r.total ? "lead" : ""}"><span class="rk">${pad2(i + 1)}</span>
      <span class="who">${av(r.id)}<span class="nm">${h(MEMBER[r.id].name)}</span></span>
      <span class="total">${r.total}</span>
      <span class="meta"><span class="bar"><i style="width:${pct}%"></i></span><span class="stats">${extras.map(h).join(" — ")}</span></span></div>`;
  }

  function viewBoard() {
    const { rows, familyDone, cis } = computeScores();
    const recent = [...cis].sort((a, b) => b.ts - a.ts).slice(0, 15);
    const pct = Math.round(familyDone.size / T.quests.length * 100);
    const s = T.scoring;
    const top = rows[0]?.total || 0;
    return `
      ${panel(`Leaderboard${sync.status === "ok" && state.lastSync ? ` — ${ago(state.lastSync)}` : ""}`, rows.map((r, i) => rankRow(r, i, top)).join(""))}
      ${panel(T.text.team, `<div class="score"><div class="score-num">${pct}<small>%</small></div><span class="label">${familyDone.size}/${T.quests.length}</span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="statline">Quests completed by at least one of us</div>`)}
      ${panel("Latest", recent.length ? `<ul class="feed">${recent.map(c => `<li>${av(c.member, "sm")}<span><b>${h(MEMBER[c.member].name)}</b> ${h(QUEST[c.quest].title)}</span><span class="when">${ago(c.ts)}</span></li>`).join("")}</ul>`
        : `<div class="empty">Nothing logged yet</div>`)}
      ${panel("Scoring", infoList([
        ["Points", "Each quest pays out <b>once per person</b>. Bigger adventures and rarer sightings pay more."],
        [`First +${s.firstBonus}`, "First in the group to log a quest. Logged together? Everyone shares it."],
        [`Variety +${s.varietyBonus}`, `At least one quest in every category: ${T.categories.map(c => h(c.name)).join(", ")}.`],
        ["Badges", "For going deep in one category. Bragging rights only."],
        ["Rules", "Honor system. Parents referee and can undo any entry."],
        ["Offline", "Log it anyway. It syncs the next time you’re on Wi-Fi."],
      ]))}`;
  }

  function packRing(m, on) {
    const p = packProgress(m);
    return `<button class="who-btn ${on ? "on" : ""}" data-packfor="${m}">
      <span class="ring" style="--p:${p.pct}">${av(m, "lg")}</span><span class="nm">${h(MEMBER[m].name)}</span><span class="pc">${p.pct}%</span></button>`;
  }

  function viewPack() {
    if (!ui.packFor) ui.packFor = state.me || T.members[2].id;
    const m = ui.packFor;
    const groups = packItemsFor(m);
    const checked = packChecked(m);
    const p = packProgress(m);
    return `
      ${panel("Who’s packing", `<div class="who-row inset">${T.members.map(x => packRing(x.id, x.id === m)).join("")}</div>`)}
      ${panel(`${MEMBER[m].name}’s bag`, `<div class="score"><div class="score-num">${p.n}<small>/ ${p.total}</small></div><span class="label">${p.pct}%</span></div>
        <div class="progress"><i style="width:${p.pct}%"></i></div>
        <div class="statline">${p.pct === 100 ? "All packed — ask a parent for a final check" : `Check items as they go in the bag — by ${h(T.packBy)}`}</div>`)}
      ${groups.map(g => panel(g.name, `<div class="rows">${g.items.map(i => `<button class="pack-item ${checked.has(i.id) ? "on" : ""}" data-pack="${i.id}">
          <span class="box">${CHECK}</span>
          <span class="pt">${h(i.text)}${i.note ? `<small>${h(i.note)}</small>` : ""}</span></button>`).join("")}</div>`)).join("")}`;
  }

  // ── Sheets ─────────────────────────────────────────────────────────────
  function openSheet(html) {
    $("#sheet").innerHTML = html;
    $("#sheetWrap").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    $("#sheetWrap").hidden = true;
    document.body.style.overflow = "";
  }

  let pickSel = new Set();
  function questSheet(id, keepSel) {
    const q = QUEST[id];
    const did = whoDid(id);
    const doneBy = new Set(did.map(c => c.member));
    const me = state.me;
    if (!keepSel) { pickSel = new Set(me && !doneBy.has(me) ? [me] : []); }
    const cat = CAT[q.cat];
    const firstBonus = did.length === 0;
    const sel = [...pickSel];
    const tags = [q.where, ...(q.fit || [])].filter(Boolean).map(f => `<span class="tag">${h(f)}</span>`).join("");
    const label = sel.length
      ? `${sel.length > 1 ? `Log for ${sel.length}` : sel[0] === me ? "I did it" : `${h(MEMBER[sel[0]].name)} did it`} — +${q.pts}${firstBonus ? ` +${T.scoring.firstBonus} first` : ""}`
      : (doneBy.size === T.members.length ? "Everyone’s done this" : "Select who did it");
    openSheet(`
      <div class="sheet-head"><span class="label">${h(cat.name)}</span><span class="big-pts">+${q.pts}</span></div>
      <h2>${h(q.title)}</h2>
      ${tags ? `<div class="tags">${tags}</div>` : ""}
      <p>${h(q.desc)}</p>
      ${q.tip ? `<div class="callout"><span class="label accent">Tip</span>${h(q.tip)}</div>` : ""}
      ${did.length ? `<h3 class="label">Done by</h3><div class="rows">${did.map(c => `<div class="done-row">${av(c.member, "sm")}<span><b>${h(MEMBER[c.member].name)}</b>${c.ts === did[0].ts ? ` <span class="tag">First</span>` : ""}</span>
        <span class="when">${ago(c.ts)}</span><button class="linkbtn" data-undo="${c.id}" data-q="${id}">Undo</button></div>`).join("")}</div>` : ""}
      <h3 class="label">Who did it</h3>
      <div class="who-pick">${T.members.map(m => `<button data-pick="${m.id}" data-q="${id}" class="${pickSel.has(m.id) ? "on" : ""}" ${doneBy.has(m.id) ? "disabled" : ""}>${av(m.id, "sm")}<span>${h(m.name)}</span></button>`).join("")}</div>
      <div class="actions">
        <button class="btn" data-log="${id}" ${sel.length ? "" : "disabled"}>${label}</button>
        <button class="btn ghost" data-close>Close</button>
      </div>`);
  }

  function meSheet() {
    openSheet(`
      <span class="label">Player</span>
      <h2>Who’s using this device?</h2>
      <p>Quests and packing follow this choice. Switch any time from the top-right corner.</p>
      <div class="people">${T.members.map(m => `<button data-setme="${m.id}" class="${state.me === m.id ? "on" : ""}">${av(m.id, "xl")}<span>${h(m.name)}</span></button>`).join("")}</div>
      <div class="actions"><button class="btn ghost" data-close>Close</button></div>`);
  }

  // ── Toast + confetti ───────────────────────────────────────────────────
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }
  // Restrained burst: thin slivers in the trip accent + white.
  function confetti() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const c = $("#confetti"), ctx = c.getContext("2d");
    const dpr = devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--sea-300").trim() || "#fff";
    const colors = [accent, accent, "#ffffff"];
    const P = Array.from({ length: 46 }, () => ({
      x: innerWidth / 2, y: innerHeight * .6, vx: (Math.random() - .5) * 10, vy: -Math.random() * 12 - 4,
      w: Math.random() * 7 + 4, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6, va: (Math.random() - .5) * .3,
    }));
    const t0 = performance.now();
    (function frame(t) {
      const el = t - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of P) {
        p.vy += .42; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.globalAlpha = Math.max(0, .9 - el / 1500);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -.75, p.w, 1.5); ctx.restore();
      }
      if (el < 1500) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(t0);
  }

  // ── Events ─────────────────────────────────────────────────────────────
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-quest],[data-cat],[data-day],[data-pack],[data-packfor],[data-pick],[data-log],[data-undo],[data-setme],[data-close],[data-action],#meChip");
    if (!t) return;
    const d = t.dataset;
    if (t.id === "meChip" || d.action === "pick-me") return meSheet();
    if (d.action === "ask") return askSheet();
    if (d.action === "ask-send") return sendAsk();
    if ("close" in d) return closeSheet();
    if (d.quest) return questSheet(d.quest);
    if (d.cat) { ui.questCat = d.cat; return render(); }
    if (d.day) { ui.day = d.day; return render(); }
    if (d.packfor) { ui.packFor = d.packfor; if (currentTab() !== "pack") location.hash = "#pack"; else render(); return; }
    if (d.pack) { togglePack(ui.packFor, d.pack); return render(); }
    if (d.pick) { pickSel.has(d.pick) ? pickSel.delete(d.pick) : pickSel.add(d.pick); return questSheet(d.q, true); }
    if (d.log) {
      if (!pickSel.size) return;
      logQuest(d.log, [...pickSel]);
      closeSheet(); return render();
    }
    if (d.undo) {
      const c = allCheckins().find(x => x.id === d.undo);
      if (c && confirm(`Remove ${MEMBER[c.member].name}’s “${QUEST[c.quest].title}”?`)) { undoCheckin(d.undo); questSheet(d.q); render(); }
      return;
    }
    if (d.setme) {
      state.me = d.setme; ui.packFor = d.setme; save(); closeSheet(); render();
      toast(`Playing as ${MEMBER[d.setme].name}`);
    }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
  addEventListener("hashchange", () => render(true));
  addEventListener("online", () => doSync(true));
  addEventListener("offline", () => { sync.status = "offline"; renderSync(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); doSync(); } });
  setInterval(() => { if (document.visibilityState === "visible") { doSync(); render(); } }, SYNC_EVERY_MS);

  // ── Offline support ────────────────────────────────────────────────────
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(async () => {
      try {
        const keys = await caches.keys();
        for (const k of keys) {
          const hit = await (await caches.open(k)).match(new URL(T.photo.src, location.href).href);
          if (hit) { ui.offlineReady = true; break; }
        }
      } catch { /* ignore */ }
      renderSync();
    }).catch(() => { /* no SW: still works online */ });
    navigator.serviceWorker.addEventListener("message", e => {
      if (e.data?.type === "cached") { ui.offlineReady = true; renderSync(); }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  renderTabs();
  render();
  renderSync();
  doSync(true);
  if (!state.me) setTimeout(meSheet, 400);
})();
