console.log("MetaMask dummy background script loaded");

// Simulate MetaMask background behavior
chrome.runtime.onInstalled.addListener(() => {
  console.log("MetaMask dummy extension installed");
});

// Handle extension messaging
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Background script received message:", request);

  if (request.type === "GET_NETWORK") {
    sendResponse({
      chainId: "0x7a69",
      networkName: "Localhost 8545",
    });
  }

  return true; // Indicates we will send a response asynchronously
});
