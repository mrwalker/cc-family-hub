/*
 * Family Hub on a Samsung TV: rotates through the hub's stream (docs/stream.md).
 *
 * window.FAMILY_HUB (config.js, written by build.sh): { hubUrl, view, clientId, clientSecret }.
 * Requests send the Cloudflare Access service token as headers. An <img> can't send
 * headers, so images are fetched and shown from blob: URLs.
 *
 * Remote: Left/Right change whose hub (family, then each member), OK refreshes, Back exits.
 */
(function () {
  "use strict";

  var CFG = window.FAMILY_HUB || {};
  var REFRESH_MS = 5 * 60 * 1000;
  var RETRY_MS = 60 * 1000;
  var CACHE_KEY = "family-hub-tv:stream:";
  var VIEW_KEY = "family-hub-tv:view";

  var state = {
    view: load(VIEW_KEY) || CFG.view || "family",
    data: null,          // the last good stream
    offlineSince: null,
    error: null,
    i: -1,               // index of the card on screen
    timer: null,
    front: 0,            // which of the two slides is showing
    images: {},          // image URL → blob: URL
    drift: 0,
  };

  // ─── Storage ────────────────────────────────────────────────────────────
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* full or blocked */ } }

  // ─── Network ────────────────────────────────────────────────────────────
  function headers() {
    var h = {};
    if (CFG.clientId) { h["CF-Access-Client-Id"] = CFG.clientId; h["CF-Access-Client-Secret"] = CFG.clientSecret; }
    return h;
  }

  function fetchStream() {
    var url = CFG.hubUrl.replace(/\/$/, "") + "/api/stream?output=tizen-tv&view=" + encodeURIComponent(state.view);
    return fetch(url, { headers: headers(), redirect: "manual" }).then(function (r) {
      if (r.type === "opaqueredirect" || r.status === 302 || r.status === 401 || r.status === 403) {
        throw { fatal: true, message: "The hub didn't accept this TV's service token. Check tizen.env and rebuild." };
      }
      if (r.status === 404) throw { fatal: true, message: "This hub has no /api/stream. Upgrade its cc-family-hub to v0.9.0 or later." };
      return r.json().then(function (d) {
        if (!r.ok) throw { fatal: r.status < 500, message: d.error || ("The hub answered " + r.status) };
        return d;
      });
    });
  }

  function refresh() {
    clearTimeout(state.refreshTimer);
    return fetchStream().then(function (d) {
      var first = !state.data;
      state.data = d; state.error = null; state.offlineSince = null;
      save(CACHE_KEY + state.view, JSON.stringify(d));
      pruneImages(d);
      if (first) next(); else status();
      state.refreshTimer = setTimeout(refresh, REFRESH_MS);
    }).catch(function (err) {
      var message = (err && err.message) || "Couldn't reach the hub";
      if (err && err.fatal) {
        state.error = message;
      } else {
        state.offlineSince = state.offlineSince || new Date();
      }
      if (!state.data) {
        var cached = load(CACHE_KEY + state.view);
        if (cached) { try { state.data = JSON.parse(cached); } catch (e) { /* ignore */ } }
        if (state.data) next(); else showMessage(state.error || message);
      }
      status();
      state.refreshTimer = setTimeout(refresh, RETRY_MS);
    });
  }

  /** An image as a blob: URL, fetched once with the token. */
  function image(url) {
    if (!url) return Promise.resolve(null);
    if (state.images[url]) return Promise.resolve(state.images[url]);
    return fetch(url, { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(function (b) { state.images[url] = URL.createObjectURL(b); return state.images[url]; })
      .catch(function () { return null; });
  }

  /** Drops images no card uses any more, so a long-running TV doesn't fill its memory. */
  function pruneImages(d) {
    var keep = {};
    (d.cards || []).forEach(function (c) { if (c.glance && c.glance.image) keep[c.glance.image] = true; });
    Object.keys(state.images).forEach(function (url) {
      if (!keep[url]) { URL.revokeObjectURL(state.images[url]); delete state.images[url]; }
    });
  }

  // ─── Rotation ───────────────────────────────────────────────────────────
  function next() {
    clearTimeout(state.timer);
    var cards = (state.data && state.data.cards) || [];
    if (!cards.length) { showMessage("Nothing in the stream right now."); state.timer = setTimeout(next, 30000); return; }
    state.i = (state.i + 1) % cards.length;
    var card = cards[state.i];
    show(card).then(function () {
      // Fetch the next card's image while this one shows.
      var after = cards[(state.i + 1) % cards.length];
      if (after.glance && after.glance.image) image(after.glance.image);
    });
    state.timer = setTimeout(next, Math.max(5, card.dwell || 15) * 1000);
  }

  function show(card) {
    var need = card.glance && card.glance.image;
    return (need ? image(need) : Promise.resolve(null)).then(function (src) {
      var back = document.getElementById(state.front === 0 ? "slide-b" : "slide-a");
      var front = document.getElementById(state.front === 0 ? "slide-a" : "slide-b");
      // Photos and portraits (pets, houses) are shown whole (render() draws them);
      // other cards fill the screen with their image.
      var whole = card.component === "photos" || card.component === "pet-portraits" || card.component === "house-portraits";
      back.style.backgroundImage = src && !whole ? 'url("' + src + '")' : "";
      back.innerHTML = render(card, !!src, src);
      drift(back);
      back.className = "slide shown";
      front.className = "slide";
      state.front = 1 - state.front;
      status();
    });
  }

  /** Burn-in protection: everything shifts a little, every few minutes. */
  function drift(el) {
    state.drift = (state.drift + 1) % 4;
    var x = [0, 14, 0, -14][state.drift], y = [0, 8, 16, 8][state.drift];
    var inner = el.querySelector(".inner, .glance, .pet");
    if (inner) inner.style.transform = "translate(" + x + "px," + y + "px)";
  }

  function showMessage(text) {
    var el = document.getElementById(state.front === 0 ? "slide-a" : "slide-b");
    el.style.backgroundImage = "";
    el.innerHTML = '<div class="glance"><div class="label">Family Hub</div><div class="mid">' + esc(text) + "</div></div>";
    el.className = "slide shown";
  }

  function status() {
    var el = document.getElementById("status");
    var parts = [];
    if (state.data && state.data.view) parts.push(state.data.view.name);
    if (state.error) parts.push(state.error);
    else if (state.offlineSince) parts.push("Offline since " + timeText(state.offlineSince));
    el.textContent = parts.join(" · ");
  }

  // ─── Layouts ────────────────────────────────────────────────────────────
  function render(card, hasImage, src) {
    var d = card.data || {};
    switch (card.component) {
      case "today": return today(card, d);
      case "photos": return photo(card, src);
      case "trips": return trip(card, d, false, hasImage);
      case "past-trips": return trip(card, d, true, hasImage);
      case "grocery": return grocery(card, d);
      case "pet-portraits":
      case "house-portraits": return portrait(card, d, src);
      default: return glance(card, hasImage);
    }
  }

  function today(card, d) {
    var now = new Date();
    var html = '<div class="inner"><div class="today-head"><div class="huge">' + clock(now) + "</div>" +
      '<div class="today-date">' + esc(now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })) + "</div></div>";
    (d.flags || []).slice(0, 2).forEach(function (f) { html += '<div class="flag">⚠ ' + esc(f.message) + "</div>"; });
    var events = d.events || [];
    if (!events.length) html += '<div class="mid" style="margin-top:40px">Nothing else today or tomorrow</div>';
    var day = null, shown = 0;
    events.forEach(function (e) {
      if (shown >= 10) return;
      if (e.day !== day) { day = e.day; html += '<div class="day label">' + esc(day) + "</div>"; }
      html += '<div class="event"><span class="bar" style="background:' + esc((e.colors || [])[0] || "#888") + '"></span>' +
        '<span class="time">' + esc(e.time) + '</span><span class="title">' + esc(e.title) + "</span></div>";
      shown++;
    });
    var tripCard = firstTrip();
    if (tripCard) {
      html += '<div class="tripbox"><div class="label">' + esc(tripCard.title) + '</div><div class="big">' +
        esc(tripCard.glance.headline) + '</div><div class="small">' + esc(tripCard.data.dates || "") + "</div></div>";
    }
    return html + "</div>";
  }

  /** The whole photo, centered over a blurred copy of itself, so portrait photos aren't cropped. */
  function photo(card, src) {
    var today = todayCard();
    var nextEvent = today && today.glance ? today.glance.headline : "";
    var tripCard = firstTrip();
    var bits = ['<span>' + clock(new Date()) + "</span>"];
    if (nextEvent) bits.push('<span class="sep">·</span><span>' + esc(nextEvent) + "</span>");
    if (tripCard) bits.push('<span class="sep">·</span><span>' + esc(tripCard.title + " " + tripCard.glance.headline) + "</span>");
    var when = card.glance && card.glance.headline ? '<span class="sep">·</span><span class="small">' + esc(card.glance.headline) + "</span>" : "";
    var pic = src ? '<div class="backdrop" style="background-image:url(&quot;' + src + '&quot;)"></div>' +
      '<div class="whole" style="background-image:url(&quot;' + src + '&quot;)"></div>' : "";
    return pic + '<div class="strip">' + bits.join("") + when + "</div>";
  }

  function trip(card, d, past, hasImage) {
    var html = (hasImage ? '<div class="shade"></div>' : "") + '<div class="inner">';
    html += '<div class="label">' + (past ? "Past trip" : d.status === "active" ? "Happening now" : "Coming up") + "</div>";
    if (!past) html += '<div class="huge" style="margin-top:20px">' + esc(card.glance.headline) + "</div>";
    html += '<div class="big" style="margin-top:20px">' + esc(d.name || card.title) + "</div>";
    html += '<div class="mid">' + esc([d.destination, d.dates].filter(Boolean).join(" · ")) + "</div>";
    if (past && d.highlights && d.highlights.length) {
      html += '<div class="chips">' + d.highlights.slice(0, 6).map(function (h) { return '<span class="chip">' + esc(h.label) + "</span>"; }).join("") + "</div>";
    }
    if (d.album) html += '<div class="small" style="margin-top:16px">' + d.album.count + " photos</div>";
    var board = (d.leaderboard || []);
    var scored = board.some(function (r) { return r.points > 0; });
    if (board.length && (scored || !past)) {
      html += '<div class="board"><div class="label">' + (past ? "Final standings" : "Leaderboard") + "</div>";
      board.slice(0, 6).forEach(function (r) {
        html += '<div class="row"><span class="dot" style="background:' + esc(r.color) + '"></span>' + esc(r.name) + '<span class="pts">' + r.points + "</span></div>";
      });
      html += "</div>";
    }
    if (!past && d.today && d.today.length) {
      html += '<div class="board"><div class="label">Today</div>';
      d.today.slice(0, 6).forEach(function (t) { html += '<div class="row">' + esc((t.time ? t.time + "  " : "") + t.title) + "</div>"; });
      html += "</div>";
    }
    return html + "</div>";
  }

  /** A pet over its whole photo, with its name, age and what's next for it along the bottom. */
  function portrait(card, d, src) {
    var pet = d.pet || d.place || {};   // a pet, or a house
    var pic = src ? '<div class="backdrop" style="background-image:url(&quot;' + src + '&quot;)"></div>' +
      '<div class="whole full" style="background-image:url(&quot;' + src + '&quot;)"></div>' : '<div class="no-photo"></div>';
    var html = pic + '<div class="shade pet-shade"></div><div class="pet">' +
      '<div class="pet-name">' + esc(pet.name || (card.glance && card.glance.headline)) + "</div>";
    var about = d.pet ? [pet.species, pet.age].filter(Boolean).join(" · ") : pet.address || "";
    if (about) html += '<div class="pet-age">' + esc(about) + "</div>";
    (d.next || []).slice(0, 3).forEach(function (n) {
      html += '<div class="pet-next' + (n.overdue ? " overdue" : "") + '">' + esc(n.emoji || "") + " " + esc(n.title) +
        ' <span class="when">· ' + esc(n.when) + (n.note ? " · " + esc(n.note) : "") + "</span></div>";
    });
    return html + "</div>";
  }

  function grocery(card, d) {
    var left = (d.items || []).filter(function (i) { return !i.done; });
    var html = '<div class="inner"><div class="label">Grocery list</div><div class="big" style="margin-top:16px">' +
      esc(card.glance.headline) + '</div><div class="groc">';
    left.slice(0, 30).forEach(function (i) { html += "<div>" + esc(i.name) + (i.quantity > 1 ? " ×" + i.quantity : "") + "</div>"; });
    if (left.length > 30) html += "<div>+" + (left.length - 30) + " more</div>";
    return html + "</div></div>";
  }

  function glance(card, hasImage) {
    var g = card.glance || {};
    var colors = (g.colors || []).map(function (c) { return '<span style="background:' + esc(c) + '"></span>'; }).join("");
    return (hasImage ? '<div class="shade bottom"></div>' : "") + '<div class="glance">' +
      '<div class="label">' + esc(card.title) + "</div>" +
      (g.emoji ? '<div class="big" style="margin-top:24px">' + esc(g.emoji) + "</div>" : "") +
      '<div class="big" style="margin-top:24px">' + esc(g.headline) + "</div>" +
      (g.detail ? '<div class="mid">' + esc(g.detail) + "</div>" : "") +
      (colors ? '<div class="colors">' + colors + "</div>" : "") + "</div>";
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function cards() { return (state.data && state.data.cards) || []; }
  function firstTrip() { return cards().filter(function (c) { return c.component === "trips"; })[0]; }
  function todayCard() { return cards().filter(function (c) { return c.component === "today"; })[0]; }
  function clock(d) { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, ""); }
  function timeText(d) { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ─── Remote ─────────────────────────────────────────────────────────────
  function views() {
    var members = (state.data && state.data.members) || [];
    return ["family"].concat(members.map(function (m) { return m.id; }));
  }

  function switchView(step) {
    var list = views();
    var i = list.indexOf(state.view);
    state.view = list[(i + step + list.length) % list.length];
    save(VIEW_KEY, state.view);
    state.data = null; state.i = -1; state.error = null;
    showMessage("Loading " + state.view + "…");
    refresh();
  }

  document.addEventListener("keydown", function (e) {
    switch (e.keyCode) {
      case 37: switchView(-1); break;                     // Left
      case 39: switchView(1); break;                      // Right
      case 13: refresh().then(function () { next(); }); break;   // OK
      case 10009:                                          // Back (Samsung remote)
        try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* not on a TV */ }
        break;
    }
  });

  // Keep the TV's own screen saver from covering the hub.
  try { webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF); } catch (e) { /* not on a TV */ }

  if (!CFG.hubUrl) { showMessage("No hub is set up. Set HUB_URL in tizen.env and rebuild."); return; }
  showMessage("Loading…");
  refresh();
  // The clock on the today card and in the photo strip stays current between rotations.
  setInterval(function () {
    var c = cards()[state.i];
    if (c && (c.component === "today" || c.component === "photos")) {
      var el = document.querySelector(".slide.shown .huge, .slide.shown .strip span");
      if (el) el.textContent = clock(new Date());
    }
  }, 20000);
})();
