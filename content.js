// Check if the content script has already been initialized on this page
if (typeof window.aiTestEaseInitialized === "undefined") {
  // Mark as initialized to prevent duplicate initialization
  window.aiTestEaseInitialized = true;

  // Create namespace for our extension state
  window.aiTestEaseState = {
    isRecording: false,
    interactions: [],
  };

  console.log("AI Test Ease content script initialized");

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Content script received message:", message);

    try {
      if (message.action === "startRecording") {
        window.aiTestEaseState.isRecording = true;
        window.aiTestEaseState.interactions = [];
        console.log("Recording started");
        sendResponse({ status: "Recording started" });
      } else if (message.action === "stopRecording") {
        window.aiTestEaseState.isRecording = false;
        console.log(
          "Recording stopped, sending interactions:",
          window.aiTestEaseState.interactions
        );
        // Send recorded interactions to background script
        chrome.runtime.sendMessage(
          {
            action: "saveInteractions",
            interactions: window.aiTestEaseState.interactions,
          },
          (response) => {
            console.log("Save response:", response);
            sendResponse({ status: "Recording stopped" });
          }
        );
        return true; // Will respond asynchronously
      }
    } catch (error) {
      console.error("Error in content script:", error);
      sendResponse({ status: "error", error: error.message });
    }
  });

  // Record click events
  document.addEventListener("click", (event) => {
    if (!window.aiTestEaseState.isRecording) return;

    try {
      const target = event.target;
      console.log("Click recorded on:", target);

      const interaction = {
        type: "click",
        timestamp: new Date().toISOString(),
        element: {
          tagName: target.tagName,
          id: target.id,
          className: target.className,
          innerText: target.innerText?.substring(0, 100),
          xpath: getXPath(target),
        },
        url: window.location.href,
      };

      window.aiTestEaseState.interactions.push(interaction);
      console.log("Interaction recorded:", interaction);
    } catch (error) {
      console.error("Error recording click:", error);
    }
  });

  // Record input focus events
  document.addEventListener(
    "focus",
    (event) => {
      if (
        !window.aiTestEaseState.isRecording ||
        event.target.tagName !== "INPUT"
      )
        return;

      try {
        const target = event.target;
        console.log("Focus recorded on:", target);

        const interaction = {
          type: "focus",
          timestamp: new Date().toISOString(),
          element: {
            tagName: target.tagName,
            id: target.id,
            className: target.className,
            placeholder: target.placeholder,
            xpath: getXPath(target),
          },
          url: window.location.href,
        };

        window.aiTestEaseState.interactions.push(interaction);
        console.log("Interaction recorded:", interaction);
      } catch (error) {
        console.error("Error recording focus:", error);
      }
    },
    true
  );

  // Helper function to get XPath of an element
  function getXPath(element) {
    if (!element) return "";

    if (element.id) {
      return `//*[@id="${element.id}"]`;
    }

    if (element === document.body) {
      return "/html/body";
    }

    let path = "";
    let current = element;

    while (current && current !== document.body) {
      let index = 1;
      let sibling = current;

      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === current.tagName) {
          index++;
        }
      }

      const tagName = current.tagName.toLowerCase();
      path = `/${tagName}[${index}]${path}`;
      current = current.parentElement;
    }

    return `/html/body${path}`;
  }
} else {
  console.log("AI Test Ease content script already initialized on this page");
}
