console.log("MetaMask dummy extension popup loaded");

// Simulate MetaMask behavior
window.addEventListener("load", () => {
  const accountsButton = document.createElement("button");
  accountsButton.textContent = "Connect Account";
  accountsButton.onclick = () => {
    alert("Account connected (simulated)");
  };
  document.body.appendChild(accountsButton);
});
