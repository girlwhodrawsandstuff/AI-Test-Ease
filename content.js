// Check if the content script has already been initialized on this page
if (typeof window.aiTestEaseInitialized === "undefined") {
  // Mark as initialized to prevent duplicate initialization
  window.aiTestEaseInitialized = true;

  // Create namespace for our extension state
  window.aiTestEaseState = {
    isRecording: false,
    interactions: [],
    eventHandlers: {}, // Store event handlers so we can remove them later
  };

  console.log(
    "AI Test Ease content script initialized - waiting for recording to start"
  );

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
      };

      window.aiTestEaseState.interactions.push(interaction);
      console.log("Interaction recorded:", interaction.type);
    } catch (error) {
      console.error("Error recording focus:", error);
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

      // Determine the best element identifier (prioritize ID, then name, etc.)
      let elementIdentifier = "";
      if (interaction.element.id) {
        elementIdentifier = `id=${interaction.element.id}`;
      } else if (interaction.element.name) {
        elementIdentifier = `name=${interaction.element.name}`;
      } else if (interaction.element.testId) {
        elementIdentifier = `data-testid=${interaction.element.testId}`;
      } else if (interaction.element.className) {
        elementIdentifier = `class=${interaction.element.className}`;
      } else {
        elementIdentifier = interaction.element.xpath;
      }

      return [
        stepNumber,
        `TC_${testCaseId}`,
        interaction.type,
        interaction.description ||
          `${interaction.type} on ${interaction.element.tagName}`,
        interaction.element.tagName,
        elementIdentifier,
        interaction.expectedResult || "Action should complete successfully",
        interaction.url,
        interaction.element.xpath,
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
    window.aiTestEaseState.interactions = [];

    // Attach event listeners and store references to them
    document.addEventListener("click", handleClick);
    document.addEventListener("focus", handleFocus, true);

    // Store references to the handlers
    window.aiTestEaseState.eventHandlers = {
      click: handleClick,
      focus: handleFocus,
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
        // Send recorded interactions to background script
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
