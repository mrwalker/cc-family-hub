/**
 * Content script — runs on calendar.google.com
 * Extracts the currently signed-in Google account's email address from the DOM.
 */

function detectAccountEmail() {
  // Method 1: Account avatar button aria-label (most reliable)
  // Google renders something like: aria-label="Google Account: John Smith (john@gmail.com)"
  const candidates = document.querySelectorAll(
    '[aria-label*="@"], [data-email], [data-hovercard-id*="@"]'
  );
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") ?? "";
    const emailMatch = label.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    if (emailMatch) return emailMatch[0];

    const dataEmail = el.getAttribute("data-email") ?? el.getAttribute("data-hovercard-id") ?? "";
    if (dataEmail.includes("@")) return dataEmail;
  }

  // Method 2: Look for the account-switcher header element
  const headerEmail = document.querySelector(
    'header [email], [data-ogsr-up] [email], .gb_d[email]'
  );
  if (headerEmail?.getAttribute("email")) return headerEmail.getAttribute("email");

  // Method 3: Extract from signed-in accounts list in page scripts
  // Google Calendar embeds account info in inline JSON — look for email pattern near "signed_in"
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const src = script.textContent ?? "";
    const match = src.match(/"([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})"/);
    if (match && !match[1].includes("gstatic") && !match[1].includes("google")) {
      return match[1];
    }
  }

  return null;
}

// Respond to popup asking for the current account
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_ACCOUNT_EMAIL") {
    sendResponse({ email: detectAccountEmail() });
  }
});
