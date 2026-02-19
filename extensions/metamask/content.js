console.log("MetaMask dummy content script loaded");

// Listen for messages from the page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Content script received message:", request);

  if (request.type === "GET_ACCOUNTS") {
    sendResponse({ accounts: ["0x1234567890123456789012345678901234567890"] });
  }
});
