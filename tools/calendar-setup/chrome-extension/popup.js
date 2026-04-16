/**
 * Popup script for Family Hub Calendar Setup extension.
 *
 * Flow:
 * 1. Check if companion server is running (GET localhost:3457/api/status)
 * 2. If credentials not configured, prompt for them
 * 3. Detect which Google account is active in the current tab
 * 4. Let user pick which family member to associate it with
 * 5. Trigger OAuth — opens a new tab to localhost:3457/auth/start/:memberId
 * 6. Poll for completion, update UI
 */

const SERVER = "http://localhost:3457";
let members = [];
let selectedMemberId = null;
let detectedEmail = null;
let pollInterval = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await checkServer();
}

async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error("bad response");
    const status = await res.json();

    if (!status.clientConfigured) {
      showScreen("credentials");
      return;
    }

    members = status.members ?? [];
    showScreen("main");
    await detectCurrentAccount();
    renderMemberList();
  } catch {
    showScreen("no-server");
  }
}

// ─── Account detection ────────────────────────────────────────────────────────

async function detectCurrentAccount() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://calendar.google.com")) {
      showAccountNotDetected();
      return;
    }

    // Ask the content script for the account email
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_ACCOUNT_EMAIL" });
    const email = response?.email ?? null;

    if (email) {
      showAccountDetected(email);
      detectedEmail = email;

      // Pre-select the member whose email matches, if any
      const match = members.find(
        (m) => m.email?.toLowerCase() === email.toLowerCase()
      );
      if (match && !match.connected) selectMember(match.id);
    } else {
      showAccountNotDetected();
    }
  } catch {
    showAccountNotDetected();
  }
}

function showAccountDetected(email) {
  document.getElementById("account-detected").classList.remove("hidden");
  document.getElementById("account-not-detected").classList.add("hidden");
  document.getElementById("account-email").textContent = email;
  document.getElementById("account-avatar").textContent = email[0].toUpperCase();
}

function showAccountNotDetected() {
  document.getElementById("account-detected").classList.add("hidden");
  document.getElementById("account-not-detected").classList.remove("hidden");
}

// ─── Member list ──────────────────────────────────────────────────────────────

function renderMemberList() {
  const list = document.getElementById("member-list");
  if (!members.length) {
    list.innerHTML = '<p class="hint">No members found in workspace/family.yaml</p>';
    return;
  }

  list.innerHTML = members
    .map((m) => {
      const isConnected = m.connected;
      const cardClass = isConnected ? "member-card ok" : "member-card";
      const badge = isConnected
        ? `<span class="badge ok">✓ Connected</span>`
        : `<span class="badge pending">Not connected</span>`;
      const meta = isConnected
        ? `${m.calendarIds.length} calendar(s) linked`
        : m.email ?? "No email on profile";

      return `
        <div class="${cardClass}" data-id="${m.id}" ${isConnected ? "" : 'role="button" tabindex="0"'}>
          <div class="radio-circle"></div>
          <div class="info">
            <div class="name">${m.name}</div>
            <div class="meta">${meta}</div>
          </div>
          ${badge}
        </div>`;
    })
    .join("");

  // Attach click handlers to unconnected members
  list.querySelectorAll(".member-card:not(.ok)").forEach((card) => {
    card.addEventListener("click", () => selectMember(card.dataset.id));
  });
}

function selectMember(id) {
  selectedMemberId = id;

  document.querySelectorAll(".member-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.id === id);
  });

  const member = members.find((m) => m.id === id);
  const btn = document.getElementById("btn-connect");
  const label = document.getElementById("btn-connect-label");

  btn.disabled = false;
  label.textContent = `Connect as ${member?.name ?? id}`;
}

// ─── OAuth connect ────────────────────────────────────────────────────────────

async function startConnect() {
  if (!selectedMemberId) return;

  setConnecting(true);
  document.getElementById("connect-error").classList.add("hidden");

  const oauthUrl = `${SERVER}/auth/start/${selectedMemberId}`;

  // Open OAuth tab
  const tab = await chrome.tabs.create({ url: oauthUrl });

  // Poll for completion
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${SERVER}/api/status`);
      const status = await res.json();
      const updated = status.members?.find((m) => m.id === selectedMemberId);
      if (updated?.connected) {
        clearInterval(pollInterval);
        members = status.members;

        // Close the OAuth tab if it's still open
        try { await chrome.tabs.remove(tab.id); } catch {}

        setConnecting(false);
        renderMemberList();
        selectedMemberId = null;
        document.getElementById("btn-connect").disabled = true;
        document.getElementById("btn-connect-label").textContent = "Select a member";
      }
    } catch {
      // Server temporarily unreachable during redirect — ignore
    }
  }, 1500);

  // Safety timeout after 3 minutes
  setTimeout(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
      setConnecting(false);
      showError("connect-error", "Connection timed out. Please try again.");
    }
  }, 180_000);
}

function setConnecting(loading) {
  const btn = document.getElementById("btn-connect");
  const label = document.getElementById("btn-connect-label");
  const spinner = document.getElementById("spinner");

  btn.disabled = loading;
  spinner.classList.toggle("hidden", !loading);
  if (loading) label.textContent = "Waiting for authorization…";
}

// ─── Credentials save ─────────────────────────────────────────────────────────

async function saveCredentials() {
  const clientId = document.getElementById("input-client-id").value.trim();
  const clientSecret = document.getElementById("input-client-secret").value.trim();
  const errEl = document.getElementById("creds-error");
  errEl.classList.add("hidden");

  if (!clientId || !clientSecret) {
    errEl.textContent = "Both fields are required.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!clientId.includes("apps.googleusercontent.com")) {
    errEl.textContent = "Client ID should end in .apps.googleusercontent.com";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    const res = await fetch(`${SERVER}/api/save-client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    if (!res.ok) throw new Error("Save failed");
    await checkServer(); // refresh into main screen
  } catch (err) {
    errEl.textContent = `Failed to save: ${err.message}`;
    errEl.classList.remove("hidden");
  }
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  document.getElementById("screen-no-server").classList.add("hidden");
  document.getElementById("screen-credentials").classList.add("hidden");
  document.getElementById("screen-main").classList.add("hidden");

  const subs = { "no-server": "Server not running", "credentials": "Setup needed", "main": "Connect family calendars" };
  document.getElementById("header-sub").textContent = subs[name] ?? "";

  document.getElementById(`screen-${name}`)?.classList.remove("hidden");
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.getElementById("btn-retry").addEventListener("click", checkServer);
document.getElementById("btn-save-creds").addEventListener("click", saveCredentials);
document.getElementById("btn-connect").addEventListener("click", startConnect);

// Listen for postMessage from the OAuth success page (if it's in the popup context)
window.addEventListener("message", async (event) => {
  if (event.data?.type === "FAMILY_HUB_AUTH_COMPLETE") {
    if (pollInterval) clearInterval(pollInterval);
    await checkServer();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

init();
