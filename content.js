if (typeof window.aiTestEaseInitialized === "undefined") {
  window.aiTestEaseInitialized = true;

  window.aiTestEaseState = {
    isRecording: false,
    interactions: [],
    eventHandlers: {},
    lastUrl: window.location.href,
  };

  console.log(
    "AI Test Ease content script initialized - waiting for recording to start"
  );

  chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
    if (response && response.isRecording) {
      console.log("Detected active recording session");

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
          tagName: "PAGE",
          xpath: "/html/body",
          type: "navigation",
        },
      };

      chrome.runtime.sendMessage(
        { action: "storeInteractions", interactions: [pageLoadInteraction] },
        (storeResponse) => {
          console.log("Navigation event stored:", storeResponse);

          startRecording();
        }
      );
    }
  });

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
          name: target.name || "",
          value: target.value || "",
          type: target.type || "",
          href: target.href || "",
          ariaLabel: target.getAttribute("aria-label") || "",
          testId: target.getAttribute("data-testid") || "",
        },
        url: window.location.href,
        pageTitle: document.title,
        description: `Click on ${
          target.innerText
            ? `"${target.innerText.substring(0, 30)}"`
            : target.tagName.toLowerCase()
        }`,
        expectedResult: "Element should respond to click action",
      };

      window.aiTestEaseState.interactions.push(interaction);
      console.log("Interaction recorded:", interaction.type);

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

  function checkForNavigation() {
    if (!window.aiTestEaseState.isRecording) return;

    const currentUrl = window.location.href;
    if (currentUrl !== window.aiTestEaseState.lastUrl) {
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
          tagName: "PAGE",
          xpath: "/html/body",
          type: "navigation",
        },
      };

      window.aiTestEaseState.interactions.push(interaction);
      window.aiTestEaseState.lastUrl = currentUrl;
      console.log("Navigation recorded:", interaction.description);

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

  function formatInteractionsForTestAutomation(interactions) {
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

    let testCaseId = 1;
    let currentUrl = "";
    let stepNumber = 1;

    const rows = interactions.map((interaction, index) => {
      if (currentUrl !== interaction.url) {
        currentUrl = interaction.url;
        testCaseId++;
        stepNumber = 1;
      } else {
        stepNumber++;
      }

      const element = interaction.element || {};

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

  function handleInput(event) {
    try {
      const target = event.target;

      if (!["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      const inputId = target.id || target.name || getXPath(target);
      const value = target.value;

      const isPassword = target.type === "password";
      const displayValue = isPassword ? "********" : value;

      let fieldName = getElementDescription(target);

      const isMobileField =
        target.placeholder?.toLowerCase().includes("mobile") ||
        target.placeholder?.toLowerCase().includes("phone") ||
        target.id?.toLowerCase().includes("mobile") ||
        target.id?.toLowerCase().includes("phone") ||
        target.name?.toLowerCase().includes("mobile") ||
        target.name?.toLowerCase().includes("phone") ||
        target.type === "tel";

      if (isMobileField) {
        fieldName = "Mobile Number field";
      }

      fieldName = fieldName.replace("the ", "");

      if (!window.aiTestEaseState.inputValues) {
        window.aiTestEaseState.inputValues = {};
      }
      window.aiTestEaseState.inputValues[inputId] = displayValue;

      if (!window.aiTestEaseState.inputFields) {
        window.aiTestEaseState.inputFields = {};
      }
      window.aiTestEaseState.inputFields[inputId] = {
        fieldName: fieldName,
        isMobileField: isMobileField,
        type: target.type || "",
        placeholder: target.placeholder || "",
        tagName: target.tagName,
        xpath: getXPath(target),
      };

      if (
        window.aiTestEaseState.inputFrames &&
        window.aiTestEaseState.inputFrames[inputId]
      ) {
        cancelAnimationFrame(window.aiTestEaseState.inputFrames[inputId]);
      }

      if (!window.aiTestEaseState.inputFrames) {
        window.aiTestEaseState.inputFrames = {};
      }

      window.aiTestEaseState.inputFrames[inputId] = requestAnimationFrame(
        () => {
          window.aiTestEaseState.inputFrames[inputId] = requestAnimationFrame(
            () => {
              const interaction = {
                type: "input",
                timestamp: new Date().toISOString(),
                element: {
                  tagName: target.tagName,
                  id: target.id,
                  className: target.className,
                  placeholder: target.placeholder,
                  name: target.name || "",
                  type: target.type || "",
                  xpath: getXPath(target),
                  isMobileField: isMobileField,
                },
                inputValue: displayValue,
                url: window.location.href,
                pageTitle: document.title,
                description: `Enter ${
                  isPassword ? "password" : `"${displayValue}"`
                } in ${fieldName}`,
                expectedResult: "Input should be accepted",
              };

              window.aiTestEaseState.interactions =
                window.aiTestEaseState.interactions.filter((item) => {
                  if (item.type !== "input") return true;

                  const itemInputId =
                    item.element.id || item.element.name || item.element.xpath;
                  return itemInputId !== inputId;
                });

              window.aiTestEaseState.interactions.push(interaction);
              console.log("Input finalized:", interaction.description);

              chrome.runtime.sendMessage(
                { action: "storeInteractions", interactions: [interaction] },
                (response) => {
                  if (!response || response.status !== "success") {
                    console.error("Failed to store finalized input:", response);
                  }
                }
              );

              delete window.aiTestEaseState.inputFrames[inputId];
            }
          );
        }
      );
    } catch (error) {
      console.error("Error recording input:", error);
    }
  }

  function startRecording() {
    console.log("Starting recording - attaching event listeners");
    window.aiTestEaseState.isRecording = true;
    window.aiTestEaseState.lastUrl = window.location.href;
    window.aiTestEaseState.inputFrames = {};
    window.aiTestEaseState.inputValues = {};

    document.addEventListener("click", handleClick);
    document.addEventListener("input", handleInput);

    const observer = new MutationObserver(() => {
      checkForNavigation();
    });

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: false,
    });

    const navigationInterval = setInterval(checkForNavigation, 1000);

    window.aiTestEaseState.eventHandlers = {
      click: handleClick,
      input: handleInput,
      observer: observer,
      navigationInterval: navigationInterval,
    };
  }

  function stopRecording() {
    console.log("Stopping recording - removing event listeners");
    window.aiTestEaseState.isRecording = false;

    if (window.aiTestEaseState.inputFrames) {
      Object.values(window.aiTestEaseState.inputFrames).forEach((frameId) => {
        if (frameId) cancelAnimationFrame(frameId);
      });
    }
    window.aiTestEaseState.inputFrames = {};
    window.aiTestEaseState.inputValues = {};

    if (window.aiTestEaseState.eventHandlers.click) {
      document.removeEventListener(
        "click",
        window.aiTestEaseState.eventHandlers.click
      );
    }

    if (window.aiTestEaseState.eventHandlers.input) {
      document.removeEventListener(
        "input",
        window.aiTestEaseState.eventHandlers.input
      );
    }

    if (window.aiTestEaseState.eventHandlers.observer) {
      window.aiTestEaseState.eventHandlers.observer.disconnect();
    }

    if (window.aiTestEaseState.eventHandlers.navigationInterval) {
      clearInterval(window.aiTestEaseState.eventHandlers.navigationInterval);
    }

    window.aiTestEaseState.eventHandlers = {};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.action === "startRecording") {
        startRecording();
        sendResponse({ status: "Recording started" });
      } else if (message.action === "stopRecording") {
        stopRecording();
        chrome.runtime.sendMessage(
          {
            action: "saveInteractions",
            interactions: window.aiTestEaseState.interactions,
          },
          (response) => {
            sendResponse({ status: "Recording stopped" });
          }
        );
        return true;
      } else if (message.action === "formatInteractions") {
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

  function getElementDescription(element) {
    if (!element) return "unknown element";

    if (element.placeholder) return element.placeholder;
    if (element.name) return element.name;
    if (element.id) return element.id;
    if (element.ariaLabel || element.getAttribute("aria-label"))
      return element.ariaLabel || element.getAttribute("aria-label");

    if (
      element.tagName === "SELECT" &&
      element.options &&
      element.selectedIndex >= 0
    ) {
      return `the ${element.options[element.selectedIndex].text} dropdown`;
    }

    const labels = document.querySelectorAll(`label[for="${element.id}"]`);
    if (labels.length > 0) {
      return labels[0].textContent.trim();
    }

    let parent = element.parentElement;
    while (parent && parent.tagName !== "BODY") {
      if (parent.tagName === "LABEL") {
        return parent.textContent.trim();
      }
      parent = parent.parentElement;
    }

    return `the ${element.tagName.toLowerCase()} field`;
  }

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
