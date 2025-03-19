// Check if the content script has already been initialized on this page
if (typeof window.aiTestEaseInitialized === "undefined") {
  // Mark as initialized to prevent duplicate initialization
  window.aiTestEaseInitialized = true;

  // Create namespace for our extension state
  window.aiTestEaseState = {
    isRecording: false,
    interactions: [],
    eventHandlers: {}, // Store event handlers so we can remove them later
    lastUrl: window.location.href, // Track URL for navigation events
  };

  console.log(
    "AI Test Ease content script initialized - waiting for recording to start"
  );

  // Check recording state and get stored interactions if recording is active
  chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
    if (response && response.isRecording) {
      console.log("Detected active recording session");

      // Record page load as a navigation interaction
      const pageLoadInteraction = {
        type: "navigation",
        timestamp: new Date().toISOString(),
        fromUrl: "",
        toUrl: window.location.href,
        url: window.location.href,
        pageTitle: document.title,
        description: `Navigate to "${document.title || window.location.href}"`,
        expectedResult: "Page should load successfully",
        element: {
          tagName: "PAGE", // Add tagName for navigation events
          xpath: "/html/body", // Use body as default xpath
          type: "navigation", // Add type identifier
        },
      };

      // Store this navigation interaction
      chrome.runtime.sendMessage(
        { action: "storeInteractions", interactions: [pageLoadInteraction] },
        (storeResponse) => {
          console.log("Navigation event stored:", storeResponse);

          // Start recording on this page since we're in active recording
          startRecording();
        }
      );
    }
  });

  // Event handler for clicks
  function handleClick(event) {
    try {
      const target = event.target;

      const interaction = {
        type: "click",
        timestamp: new Date().toISOString(),
        element: {
          tagName: target.tagName,
          id: target.id,
          className: target.className,
          innerText: target.innerText?.substring(0, 100),
          xpath: getXPath(target),
          // Additional properties useful for test automation
          name: target.name || "",
          value: target.value || "",
          type: target.type || "",
          href: target.href || "",
          ariaLabel: target.getAttribute("aria-label") || "",
          testId: target.getAttribute("data-testid") || "",
        },
        url: window.location.href,
        // Add page title which helps in documentation
        pageTitle: document.title,
        // Add suggested step description
        description: `Click on ${
          target.innerText
            ? `"${target.innerText.substring(0, 30)}"`
            : target.tagName.toLowerCase()
        }`,
        // Add suggested expected result
        expectedResult: "Element should respond to click action",
      };

      window.aiTestEaseState.interactions.push(interaction);
      console.log("Interaction recorded:", interaction.type);

      // Store each interaction immediately in chrome.storage.local
      chrome.runtime.sendMessage(
        { action: "storeInteractions", interactions: [interaction] },
        (response) => {
          if (!response || response.status !== "success") {
            console.error("Failed to store interaction:", response);
          }
        }
      );
    } catch (error) {
      console.error("Error recording click:", error);
    }
  }

  // Event handler for input focus
  function handleFocus(event) {
    if (event.target.tagName !== "INPUT") return;

    try {
      const target = event.target;

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
        pageTitle: document.title,
        description: `Focus on ${target.tagName.toLowerCase()} element`,
        expectedResult: "Element should receive focus",
      };

      window.aiTestEaseState.interactions.push(interaction);
      console.log("Interaction recorded:", interaction.type);

      // Store each interaction immediately
      chrome.runtime.sendMessage(
        { action: "storeInteractions", interactions: [interaction] },
        (response) => {
          if (!response || response.status !== "success") {
            console.error("Failed to store interaction:", response);
          }
        }
      );
    } catch (error) {
      console.error("Error recording focus:", error);
    }
  }

  // Function to check for URL changes (page navigation)
  function checkForNavigation() {
    if (!window.aiTestEaseState.isRecording) return;

    const currentUrl = window.location.href;
    if (currentUrl !== window.aiTestEaseState.lastUrl) {
      // URL has changed, record a navigation interaction
      const interaction = {
        type: "navigation",
        timestamp: new Date().toISOString(),
        fromUrl: window.aiTestEaseState.lastUrl,
        toUrl: currentUrl,
        url: currentUrl,
        pageTitle: document.title,
        description: `Navigate to "${document.title || currentUrl}"`,
        expectedResult: "Page should load successfully",
        element: {
          tagName: "PAGE", // Add tagName for navigation events
          xpath: "/html/body", // Use body as default xpath
          type: "navigation", // Add type identifier
        },
      };

      window.aiTestEaseState.interactions.push(interaction);
      window.aiTestEaseState.lastUrl = currentUrl;
      console.log("Navigation recorded:", interaction.description);

      // Store the navigation interaction
      chrome.runtime.sendMessage(
        { action: "storeInteractions", interactions: [interaction] },
        (response) => {
          if (!response || response.status !== "success") {
            console.error("Failed to store navigation:", response);
          }
        }
      );
    }
  }

  // Function to format interactions for test automation
  function formatInteractionsForTestAutomation(interactions) {
    // Prepare the data specifically for test automation
    const headers = [
      "Step #",
      "Test Case ID",
      "Action Type",
      "Description",
      "Element Type",
      "Element Identifier",
      "Expected Result",
      "URL",
      "XPath",
      "Page Title",
      "Timestamp",
    ];

    // Group interactions into test cases (each page/URL could be a separate test case)
    let testCaseId = 1;
    let currentUrl = "";
    let stepNumber = 1;

    const rows = interactions.map((interaction, index) => {
      // If URL changes, consider it a new test case
      if (currentUrl !== interaction.url) {
        currentUrl = interaction.url;
        testCaseId++;
        stepNumber = 1;
      } else {
        stepNumber++;
      }

      // Ensure element exists
      const element = interaction.element || {};

      // Determine the best element identifier (prioritize ID, then name, etc.)
      let elementIdentifier = "";
      if (element.id) {
        elementIdentifier = `id=${element.id}`;
      } else if (element.name) {
        elementIdentifier = `name=${element.name}`;
      } else if (element.testId) {
        elementIdentifier = `data-testid=${element.testId}`;
      } else if (element.className) {
        elementIdentifier = `class=${element.className}`;
      } else if (element.xpath) {
        elementIdentifier = element.xpath;
      } else if (interaction.type === "navigation") {
        elementIdentifier = "URL";
      }

      return [
        stepNumber,
        `TC_${testCaseId}`,
        interaction.type,
        interaction.description ||
          `${interaction.type} on ${element.tagName || "page"}`,
        element.tagName ||
          (interaction.type === "navigation" ? "page" : "unknown"),
        elementIdentifier,
        interaction.expectedResult || "Action should complete successfully",
        interaction.url,
        element.xpath || "",
        interaction.pageTitle || "",
        interaction.timestamp,
      ];
    });

    return { headers, rows };
  }

  // Function to start recording (attach event listeners)
  function startRecording() {
    console.log("Starting recording - attaching event listeners");
    window.aiTestEaseState.isRecording = true;
    window.aiTestEaseState.lastUrl = window.location.href;

    // Attach event listeners and store references to them
    document.addEventListener("click", handleClick);
    document.addEventListener("focus", handleFocus, true);

    // Set up a MutationObserver to detect DOM changes which might indicate navigation
    const observer = new MutationObserver(() => {
      checkForNavigation();
    });

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: false,
    });

    // Also check for navigation periodically
    const navigationInterval = setInterval(checkForNavigation, 1000);

    // Store references to the handlers
    window.aiTestEaseState.eventHandlers = {
      click: handleClick,
      focus: handleFocus,
      observer: observer,
      navigationInterval: navigationInterval,
    };
  }

  // Function to stop recording (remove event listeners)
  function stopRecording() {
    console.log("Stopping recording - removing event listeners");
    window.aiTestEaseState.isRecording = false;

    // Remove event listeners
    if (window.aiTestEaseState.eventHandlers.click) {
      document.removeEventListener(
        "click",
        window.aiTestEaseState.eventHandlers.click
      );
    }

    if (window.aiTestEaseState.eventHandlers.focus) {
      document.removeEventListener(
        "focus",
        window.aiTestEaseState.eventHandlers.focus,
        true
      );
    }

    // Disconnect the MutationObserver
    if (window.aiTestEaseState.eventHandlers.observer) {
      window.aiTestEaseState.eventHandlers.observer.disconnect();
    }

    // Clear the navigation check interval
    if (window.aiTestEaseState.eventHandlers.navigationInterval) {
      clearInterval(window.aiTestEaseState.eventHandlers.navigationInterval);
    }

    // Clear event handler references
    window.aiTestEaseState.eventHandlers = {};
  }

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.action === "startRecording") {
        startRecording();
        sendResponse({ status: "Recording started" });
      } else if (message.action === "stopRecording") {
        stopRecording();
        // Send recorded interactions to background script for saving
        // Only send the interactions from this page - background will combine with stored ones
        chrome.runtime.sendMessage(
          {
            action: "saveInteractions",
            interactions: window.aiTestEaseState.interactions,
          },
          (response) => {
            sendResponse({ status: "Recording stopped" });
          }
        );
        return true; // Will respond asynchronously
      } else if (message.action === "formatInteractions") {
        // If we need to format interactions outside the extension
        const formatted = formatInteractionsForTestAutomation(
          message.interactions
        );
        sendResponse({ status: "success", data: formatted });
      }
    } catch (error) {
      console.error("Error in content script:", error);
      sendResponse({ status: "error", error: error.message });
    }
  });

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
