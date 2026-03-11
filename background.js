// Netflix Channel Surfer - Background Service Worker (Manifest V3)
// Minimal: storage coordination between popup and content scripts

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get('cs_settings', (result) => {
      sendResponse({ settings: result.cs_settings || null });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ cs_settings: msg.settings }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
