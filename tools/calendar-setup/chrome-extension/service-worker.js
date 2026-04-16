/**
 * MV3 service worker — minimal background script.
 * Listens for tab updates so the popup can poll for OAuth completion.
 */

// When a tab navigates to the OAuth success page, notify any open popups
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url?.startsWith("http://localhost:3457/auth/callback")
  ) {
    // The OAuth flow landed on our callback — store the result so the popup
    // can pick it up on its next poll cycle
    chrome.storage.session.set({ lastAuthTabId: tabId, lastAuthAt: Date.now() });
  }
});
