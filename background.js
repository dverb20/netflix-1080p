// Netflix Channel Surfer - Background Service Worker (Manifest V3)
// Kept minimal — content scripts and popup access chrome.storage directly.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Open Netflix on first install so the user can start surfing immediately
    chrome.tabs.create({ url: 'https://www.netflix.com/browse' });
  }
});
