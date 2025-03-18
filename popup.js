document.addEventListener("DOMContentLoaded", () => {
  const startButton = document.getElementById("startRecording");
  const stopButton = document.getElementById("stopRecording");
  const statusDiv = document.createElement("div");
  statusDiv.id = "status";
  document.body.appendChild(statusDiv);

  // Function to update status
  function updateStatus(message, isError = false) {
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? "red" : "green";
    console.log(`Status: ${message}`);
  }

  // Function to inject content script
  async function injectContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      console.log("Content script injected successfully");
      return true;
    } catch (error) {
      console.error("Failed to inject content script:", error);
      return false;
    }
  }

  // Function to send message with retry
  async function sendMessageWithRetry(tabId, message, maxRetries = 2) {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        return response;
      } catch (error) {
        if (i === maxRetries) throw error;
        console.log(`Retry ${i + 1}: Injecting content script...`);
        await injectContentScript(tabId);
        await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay before retry
      }
    }
  }

  // Function to send message to background script
  async function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Background script error:", chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  // Check current recording state when popup opens
  chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
    if (response && response.isRecording) {
      startButton.disabled = true;
      stopButton.disabled = false;
      updateStatus("Recording in progress...");
    }
  });

  startButton.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) {
        throw new Error("No active tab found");
      }

      updateStatus("Starting recording...");

      // First, ensure content script is injected
      await injectContentScript(tab.id);

      // Then notify content script
      const contentResponse = await sendMessageWithRetry(tab.id, {
        action: "startRecording",
      });
      console.log("Content script response:", contentResponse);

      if (!contentResponse || contentResponse.status !== "Recording started") {
        throw new Error("Failed to start recording in content script");
      }

      // Finally, notify background script
      const bgResponse = await sendMessageToBackground({
        action: "startRecording",
      });
      console.log("Background script response:", bgResponse);

      if (!bgResponse || bgResponse.status !== "Recording started") {
        throw new Error(
          bgResponse?.error || "Failed to start recording in background"
        );
      }

      startButton.disabled = true;
      stopButton.disabled = false;
      updateStatus("Recording in progress...");
    } catch (error) {
      console.error("Start recording error:", error);
      updateStatus(`Error: ${error.message}`, true);
      // Reset buttons in case of error
      startButton.disabled = false;
      stopButton.disabled = true;
    }
  });

  stopButton.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) {
        throw new Error("No active tab found");
      }

      updateStatus("Stopping recording...");

      // First, notify content script
      const contentResponse = await sendMessageWithRetry(tab.id, {
        action: "stopRecording",
      });
      console.log("Content script response:", contentResponse);

      if (!contentResponse || contentResponse.status !== "Recording stopped") {
        throw new Error("Failed to stop recording in content script");
      }

      // Then notify background script
      const bgResponse = await sendMessageToBackground({
        action: "stopRecording",
      });
      console.log("Background script response:", bgResponse);

      if (!bgResponse || bgResponse.status !== "Recording stopped") {
        throw new Error(
          bgResponse?.error || "Failed to stop recording in background"
        );
      }

      startButton.disabled = false;
      stopButton.disabled = true;

      // Wait for the spreadsheet link
      const spreadsheetInfo = await sendMessageToBackground({
        action: "getSpreadsheetInfo",
      });
      if (spreadsheetInfo && spreadsheetInfo.url) {
        const link = document.createElement("a");
        link.href = spreadsheetInfo.url;
        link.textContent = "Open Recording in Google Sheets";
        link.target = "_blank";
        statusDiv.innerHTML = "";
        statusDiv.appendChild(link);
      } else {
        updateStatus("Recording saved, but sheet URL not available");
      }
    } catch (error) {
      console.error("Stop recording error:", error);
      updateStatus(`Error: ${error.message}`, true);
      // Reset buttons in case of error
      startButton.disabled = false;
      stopButton.disabled = true;
    }
  });
});
