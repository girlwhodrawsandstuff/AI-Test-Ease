document.addEventListener("DOMContentLoaded", () => {
  console.log("Popup opened - initializing UI");

  const startButton = document.getElementById("startRecording");
  const stopButton = document.getElementById("stopRecording");
  const spreadsheetUrlInput = document.getElementById("spreadsheetUrl");
  const statusDiv = document.getElementById("status");

  const aiEnabledCheckbox = document.getElementById("aiEnabled");
  const aiSettingsDiv = document.querySelector(".ai-config");
  const testerNameInput = document.getElementById("testerName");

  console.log("Initial DOM elements:", {
    startButton: startButton ? "found" : "missing",
    stopButton: stopButton ? "found" : "missing",
    stopButtonDisabled: stopButton ? stopButton.disabled : "N/A",
    stopButtonClass: stopButton ? stopButton.className : "N/A",
  });

  stopButton.disabled = true;
  stopButton.classList.add("disabled-button");
  console.log(
    "After explicit setting - Stop button disabled:",
    stopButton.disabled
  );

  chrome.storage.sync.get(["aiEnabled"], (result) => {
    const isEnabled = result.aiEnabled !== undefined ? result.aiEnabled : true;

    aiEnabledCheckbox.checked = isEnabled;
    if (aiSettingsDiv) {
      aiSettingsDiv.classList.toggle("hidden", !isEnabled);
    }
  });

  chrome.storage.sync.get(["testerName"], (result) => {
    if (result.testerName) {
      testerNameInput.value = result.testerName;
    }
  });

  aiEnabledCheckbox.addEventListener("change", () => {
    const isEnabled = aiEnabledCheckbox.checked;
    if (aiSettingsDiv) {
      aiSettingsDiv.classList.toggle("hidden", !isEnabled);
    }

    chrome.storage.sync.set({ aiEnabled: isEnabled });
  });

  testerNameInput.addEventListener("change", () => {
    chrome.storage.sync.set({ testerName: testerNameInput.value });
  });

  function setRecordingState(isRecording) {
    if (isRecording) {
      startButton.textContent = "Recording...";
      startButton.disabled = true;
      startButton.classList.add("recording");

      stopButton.disabled = false;
      stopButton.classList.remove("disabled-button");
      console.log(
        "Recording active: Stop button is now enabled:",
        !stopButton.disabled
      );

      spreadsheetUrlInput.disabled = true;
      aiEnabledCheckbox.disabled = true;
      testerNameInput.disabled = true;
    } else {
      startButton.textContent = "Start Recording";
      startButton.disabled = false;
      startButton.classList.remove("recording");

      stopButton.disabled = true;
      stopButton.classList.add("disabled-button");
      console.log(
        "Recording inactive: Stop button is now disabled:",
        stopButton.disabled
      );

      spreadsheetUrlInput.disabled = false;
      aiEnabledCheckbox.disabled = false;
      testerNameInput.disabled = false;
    }
  }

  function updateStatus(message, isError = false) {
    statusDiv.textContent = message;
    statusDiv.className = isError ? "error" : "success";
    console.log(`Status: ${message}`);
  }

  function extractSpreadsheetId(url) {
    if (!url) return null;

    try {
      const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      return match ? match[1] : null;
    } catch (error) {
      console.error("Error extracting spreadsheet ID:", error);
      return null;
    }
  }

  function validateSpreadsheetUrl(url) {
    if (!url) return true; // Empty URL is valid (will create new sheet)

    const id = extractSpreadsheetId(url);
    if (!id) {
      updateStatus("Invalid spreadsheet URL format", true);
      return false;
    }
    return true;
  }

  async function injectContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return true;
    } catch (error) {
      console.error("Failed to inject content script:", error);
      return false;
    }
  }

  async function sendMessageWithRetry(tabId, message, maxRetries = 2) {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        return response;
      } catch (error) {
        if (i === maxRetries) throw error;
        await injectContentScript(tabId);
        await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay before retry
      }
    }
  }

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

  chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
    if (response && response.isRecording) {
      setRecordingState(true);
      updateStatus("Recording in progress...");
    } else {
      setRecordingState(false);
    }
  });

  setRecordingState(false);

  startButton.addEventListener("click", async () => {
    try {
      const spreadsheetUrl = spreadsheetUrlInput.value.trim();
      if (!validateSpreadsheetUrl(spreadsheetUrl)) {
        return;
      }

      const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) {
        throw new Error("No active tab found");
      }

      updateStatus("Starting recording...");

      setRecordingState(true);

      stopButton.disabled = false;
      stopButton.classList.remove("disabled-button");
      await injectContentScript(tab.id);

      const contentResponse = await sendMessageWithRetry(tab.id, {
        action: "startRecording",
      });

      if (!contentResponse || contentResponse.status !== "Recording started") {
        throw new Error("Failed to start recording in content script");
      }

      const bgResponse = await sendMessageToBackground({
        action: "startRecording",
        spreadsheetId: spreadsheetId,
        testerName: testerNameInput.value,
      });

      if (!bgResponse || bgResponse.status !== "Recording started") {
        throw new Error(
          bgResponse?.error || "Failed to start recording in background"
        );
      }

      setRecordingState(true);
      updateStatus("Recording in progress...");
    } catch (error) {
      console.error("Start recording error:", error);
      updateStatus(`Error: ${error.message}`, true);
      setRecordingState(false);
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

      const contentResponse = await sendMessageWithRetry(tab.id, {
        action: "stopRecording",
      });

      if (!contentResponse || contentResponse.status !== "Recording stopped") {
        throw new Error("Failed to stop recording in content script");
      }

      const bgResponse = await sendMessageToBackground({
        action: "stopRecording",
      });

      if (!bgResponse || bgResponse.status !== "Recording stopped") {
        throw new Error(
          bgResponse?.error || "Failed to stop recording in background"
        );
      }

      setRecordingState(false);

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
      setRecordingState(false);
    }
  });
});
