// background.js - No longer handles transcript fetching
// Transcript fetching moved to content.js which has YouTube cookie access

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Keep this listener for any future background tasks
  return true;
});