self.onerror = function (message, source, lineno, colno, error) {
  console.error("[Background] Uncaught error:", {
    message,
    source,
    lineno,
    colno,
    error,
  });
  return false;
};

self.onunhandledrejection = function (event) {
  console.error("[Background] Unhandled promise rejection:", event.reason);
};

let spreadsheetId = null;
let spreadsheetUrl = null;
let recordingState = {
  isRecording: false,
  tabId: null,
  targetSpreadsheetId: null,
  testerName: "",
};

const AI_CONFIG = {
  enabled: true,
  backendUrl: "http://localhost:5000",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startRecording") {
    chrome.storage.local.set({ interactions: [] });

    if (!sender.tab) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          recordingState.isRecording = true;
          recordingState.tabId = tabs[0].id;

          if (message.spreadsheetId) {
            recordingState.targetSpreadsheetId = message.spreadsheetId;
          } else {
            recordingState.targetSpreadsheetId = null;
          }

          if (message.testerName) {
            recordingState.testerName = message.testerName;
          }

          sendResponse({ status: "Recording started" });
        } else {
          sendResponse({ status: "error", error: "No active tab found" });
        }
      });
      return true;
    }

    recordingState.isRecording = true;
    recordingState.tabId = sender.tab.id;

    if (message.spreadsheetId) {
      recordingState.targetSpreadsheetId = message.spreadsheetId;
    } else {
      recordingState.targetSpreadsheetId = null;
    }

    if (message.testerName) {
      recordingState.testerName = message.testerName;
    }

    sendResponse({ status: "Recording started" });
  } else if (message.action === "stopRecording") {
    recordingState.isRecording = false;
    recordingState.tabId = null;
    sendResponse({ status: "Recording stopped" });
  } else if (message.action === "getRecordingState") {
    sendResponse(recordingState);
  } else if (message.action === "saveInteractions") {
    chrome.storage.local.get(["interactions"], (result) => {
      const allInteractions = result.interactions || [];

      if (message.interactions && message.interactions.length > 0) {
        chrome.storage.local.set(
          {
            interactions: [...allInteractions, ...message.interactions],
          },
          () => {
            chrome.storage.local.get(["interactions"], (updatedResult) => {
              const finalInteractions = updatedResult.interactions || [];
              console.log("Saving all interactions:", finalInteractions.length);

              saveToGoogleSheets(finalInteractions)
                .then(() => {
                  sendResponse({ status: "success", url: spreadsheetUrl });
                  chrome.storage.local.remove("interactions");
                })
                .catch((error) => {
                  console.error("Error saving interactions:", error);
                  sendResponse({ status: "error", error: error.message });
                });
            });
          }
        );
      } else {
        console.log(
          "No new interactions, using stored interactions:",
          allInteractions.length
        );
        saveToGoogleSheets(allInteractions)
          .then(() => {
            sendResponse({ status: "success", url: spreadsheetUrl });
            chrome.storage.local.remove("interactions");
          })
          .catch((error) => {
            console.error("Error saving interactions:", error);
            sendResponse({ status: "error", error: error.message });
          });
      }
    });
    return true;
  } else if (message.action === "getSpreadsheetInfo") {
    sendResponse({ url: spreadsheetUrl });
  } else if (message.action === "storeInteractions") {
    chrome.storage.local.get(["interactions"], (result) => {
      const existingInteractions = result.interactions || [];
      const newInteractions = [
        ...existingInteractions,
        ...message.interactions,
      ];

      chrome.storage.local.set({ interactions: newInteractions }, () => {
        console.log(
          `Stored ${message.interactions.length} interactions, total: ${newInteractions.length}`
        );
        sendResponse({ status: "success" });
      });
    });
    return true;
  } else if (message.action === "getStoredInteractions") {
    chrome.storage.local.get(["interactions"], (result) => {
      sendResponse({ interactions: result.interactions || [] });
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (recordingState.isRecording && recordingState.tabId === tabId) {
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["content.js"],
      })
      .catch((error) =>
        console.error("Failed to re-inject content script:", error)
      );
  }
});

async function getAccessToken() {
  try {
    const clientId =
      "142180159372-4tltf1eevavn3btkgl7kmvnru3qrl7ll.apps.googleusercontent.com";

    const getToken = (interactive) => {
      return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken(
          {
            interactive: interactive,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
          },
          (token) => {
            if (chrome.runtime.lastError) {
              console.error(
                "[Auth] Error getting token:",
                chrome.runtime.lastError
              );
              reject(chrome.runtime.lastError);
            } else {
              resolve(token);
            }
          }
        );
      });
    };

    let token;
    try {
      token = await getToken(false);
    } catch (e) {
      console.log("[Auth] Failed to get non-interactive token:", e);
    }

    if (!token) {
      token = await getToken(true);
    }

    if (!token) {
      throw new Error("Failed to get auth token");
    }

    const testResponse = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=" +
        token
    );

    if (!testResponse.ok) {
      await new Promise((resolve, reject) => {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          if (chrome.runtime.lastError) {
            console.error(
              "[Auth] Error revoking token:",
              chrome.runtime.lastError
            );
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      });

      token = await getToken(true);
    }

    return token;
  } catch (error) {
    console.error("[Auth] Error getting auth token:", error);
    throw error;
  }
}

async function createSpreadsheet() {
  try {
    if (recordingState.targetSpreadsheetId) {
      console.log(
        `[Sheets] Using existing spreadsheet: ${recordingState.targetSpreadsheetId}`
      );
      spreadsheetId = recordingState.targetSpreadsheetId;
      spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      const token = await getAccessToken();
      if (!token) {
        throw new Error("Failed to get auth token");
      }

      await verifySpreadsheetAccess(spreadsheetId, token);

      return spreadsheetId;
    }

    console.log("[Sheets] Starting spreadsheet creation process");
    const token = await getAccessToken();
    if (!token) {
      throw new Error("Failed to get auth token");
    }

    console.log("[Sheets] Creating new spreadsheet with valid token");
    const response = await fetch(
      "https://sheets.googleapis.com/v4/spreadsheets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: {
            title: `User Interactions - ${new Date().toLocaleDateString()}`,
          },
          sheets: [
            {
              properties: {
                title: "Interactions",
                gridProperties: {
                  frozenRowCount: 1,
                  columnCount: 9,
                },
              },
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorStatus = response.status;
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = await response.text();
      }

      console.error(
        "[Sheets] Error creating spreadsheet:",
        errorStatus,
        errorData
      );

      if (errorStatus === 401) {
        console.log(
          "[Sheets] Token expired during spreadsheet creation, refreshing..."
        );

        await new Promise((resolve, reject) => {
          chrome.identity.removeCachedAuthToken({ token }, () => {
            if (chrome.runtime.lastError) {
              console.error(
                "[Sheets] Error revoking token:",
                chrome.runtime.lastError
              );
              reject(chrome.runtime.lastError);
            } else {
              resolve();
            }
          });
        });

        const getToken = (interactive) => {
          return new Promise((resolve, reject) => {
            chrome.identity.getAuthToken(
              {
                interactive: interactive,
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
              },
              (token) => {
                if (chrome.runtime.lastError) {
                  console.error(
                    "[Sheets] Error getting token:",
                    chrome.runtime.lastError
                  );
                  reject(chrome.runtime.lastError);
                } else {
                  console.log("[Sheets] Successfully obtained new token");
                  resolve(token);
                }
              }
            );
          });
        };

        const newToken = await getToken(true);
        console.log("[Sheets] Retrying spreadsheet creation with new token");

        const retryResponse = await fetch(
          "https://sheets.googleapis.com/v4/spreadsheets",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${newToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              properties: {
                title: `User Interactions - ${new Date().toLocaleDateString()}`,
              },
              sheets: [
                {
                  properties: {
                    title: "Interactions",
                    gridProperties: {
                      frozenRowCount: 1,
                      columnCount: 9,
                    },
                  },
                },
              ],
            }),
          }
        );

        if (!retryResponse.ok) {
          const retryError = await retryResponse.text();
          console.error(
            "[Sheets] Retry failed:",
            retryResponse.status,
            retryError
          );
          throw new Error(
            `Failed to create spreadsheet after token refresh: ${retryError}`
          );
        }

        const data = await retryResponse.json();
        spreadsheetId = data.spreadsheetId;
        spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
        console.log(
          "[Sheets] Spreadsheet created after token refresh:",
          spreadsheetUrl
        );
        return spreadsheetId;
      }

      throw new Error(
        `Failed to create spreadsheet: ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    spreadsheetId = data.spreadsheetId;
    spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log("[Sheets] Spreadsheet created successfully:", spreadsheetUrl);

    try {
      await formatSpreadsheet(spreadsheetId, token);
    } catch (error) {
      console.error("[Sheets] Error formatting spreadsheet:", error);
    }

    return spreadsheetId;
  } catch (error) {
    console.error("[Sheets] Error in createSpreadsheet:", error);
    throw error;
  }
}

async function verifySpreadsheetAccess(spreadsheetId, token) {
  try {
    if (!token) {
      token = await getAccessToken();
      if (!token) {
        throw new Error("Failed to get auth token");
      }
    }

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        "[Sheets] Spreadsheet access failed:",
        response.status,
        responseText
      );
      throw new Error(`Failed to access spreadsheet: ${responseText}`);
    }

    const data = await response.json();
    console.log(
      "[Sheets] Verified access to spreadsheet:",
      data.properties.title
    );
    return true;
  } catch (error) {
    console.error("[Sheets] Error verifying spreadsheet access:", error);
    throw error;
  }
}

async function processInteractionsWithAI(interactions) {
  if (!AI_CONFIG.enabled) {
    console.log("[AI] AI processing is disabled");
    return {
      interactions: interactions,
      testCaseName: "User Interaction Test",
    };
  }

  if (
    !interactions ||
    !Array.isArray(interactions) ||
    interactions.length === 0
  ) {
    console.error("[AI] Invalid or empty interactions array:", interactions);
    return {
      interactions: interactions || [],
      testCaseName: "User Interaction Test",
    };
  }

  const cleanedInteractions = interactions.map((interaction) => {
    const cleanInteraction = { ...interaction };

    if (!cleanInteraction.url) {
      if (cleanInteraction.type === "navigation" && cleanInteraction.toUrl) {
        cleanInteraction.url = cleanInteraction.toUrl;
      } else {
        cleanInteraction.url = "about:blank";
      }
    }

    if (!cleanInteraction.element) {
      cleanInteraction.element = {
        tagName: interaction.type === "navigation" ? "PAGE" : "UNKNOWN",
        xpath: "/html/body",
        type: interaction.type,
      };
    } else {
      if (!cleanInteraction.element.tagName) {
        cleanInteraction.element.tagName =
          interaction.type === "navigation" ? "PAGE" : "UNKNOWN";
      }

      if (!cleanInteraction.element.xpath) {
        cleanInteraction.element.xpath = "/html/body";
      }

      if (!cleanInteraction.element.type) {
        cleanInteraction.element.type = interaction.type;
      }
    }

    return cleanInteraction;
  });

  try {
    console.log("[AI] Starting AI analysis of interactions");
    console.log("[AI] Using backend URL:", AI_CONFIG.backendUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.error("[AI] Request timed out after 20 seconds");
    }, 20000);

    try {
      console.log(
        "[AI] Sending interactions to backend:",
        JSON.stringify({
          interactionCount: cleanedInteractions.length,
          sampleInteraction:
            cleanedInteractions.length > 0
              ? {
                  type: cleanedInteractions[0].type,
                  url: cleanedInteractions[0].url,
                  hasElement: !!cleanedInteractions[0].element,
                }
              : null,
        })
      );

      const response = await fetch(`${AI_CONFIG.backendUrl}/api/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ interactions: cleanedInteractions }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.text();
        console.error("[AI] Backend API error:", errorData);

        if (errorData.includes("No interactions provided")) {
          console.warn(
            "[AI] Backend reported no interactions, using fallback processing"
          );
          throw new Error("No interactions provided to backend");
        }

        throw new Error(`Backend API error: ${errorData}`);
      }

      const data = await response.json();

      if (!data.result) {
        throw new Error("Backend returned empty result");
      }

      let aiResponse;
      try {
        aiResponse = JSON.parse(data.result);
      } catch (parseError) {
        console.error("[AI] JSON parse error:", parseError);
        throw new Error("Failed to parse AI response as JSON");
      }

      console.log("[AI] AI analysis complete:", aiResponse);

      const enhancedInteractions = cleanedInteractions.map(
        (interaction, index) => {
          if (index < aiResponse.interactions.length) {
            return {
              ...interaction,
              aiActionDescription:
                aiResponse.interactions[index].actionDescription,
              aiExpectedResult: aiResponse.interactions[index].expectedResult,
              aiPriority: aiResponse.interactions[index].priority,
            };
          }
          return interaction;
        }
      );

      return {
        interactions: enhancedInteractions,
        testCaseName:
          aiResponse.testCaseName ||
          aiResponse.title ||
          "User Interaction Test",
      };
    } catch (error) {
      if (error.name === "AbortError") {
        console.error("[AI] Request timed out or was aborted");
      } else {
        console.error("[AI] Error processing interactions:", error);
      }

      return fallbackProcessing(cleanedInteractions);
    }
  } catch (error) {
    console.error("[AI] Error in processInteractionsWithAI:", error);
    return fallbackProcessing(cleanedInteractions);
  }
}

function fallbackProcessing(interactions) {
  console.log("[AI] Using fallback processing for interactions");

  let testCaseName = "User Interaction Test";
  const firstNavigation = interactions.find(
    (interaction) => interaction.type === "navigation"
  );

  if (firstNavigation && firstNavigation.pageTitle) {
    testCaseName = `Test for ${firstNavigation.pageTitle}`;
  } else if (firstNavigation && firstNavigation.url) {
    try {
      const url = new URL(firstNavigation.url);
      testCaseName = `Test for ${url.hostname}`;
    } catch (e) {
      testCaseName = `Test for ${firstNavigation.url.substring(0, 30)}`;
    }
  }

  return {
    interactions: interactions.map((interaction) => ({
      ...interaction,
      aiActionDescription: interaction.description || `${interaction.type}`,
      aiExpectedResult:
        interaction.expectedResult || "Action should complete successfully",
      aiPriority: "P2",
    })),
    testCaseName,
  };
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    if (changes.aiEnabled) {
      AI_CONFIG.enabled = changes.aiEnabled.newValue;
    }
  }
});

chrome.storage.sync.get(["aiEnabled"], (result) => {
  if (result.aiEnabled !== undefined) AI_CONFIG.enabled = result.aiEnabled;
});

function getTestCaseName(interactions) {
  if (!interactions || interactions.length === 0) {
    return "Untitled Test Case";
  }

  let firstPageTitle =
    interactions[0]?.pageTitle ||
    interactions[0]?.element?.tagName ||
    "Unknown Page";

  firstPageTitle = firstPageTitle.replace(/^https?:\/\/[^\/]+\//, "");
  firstPageTitle = firstPageTitle.replace(/\.[^.]+$/, "");

  if (interactions[0]?.type === "navigation" && interactions[0]?.toUrl) {
    try {
      const url = new URL(interactions[0].toUrl);
      if (url.pathname !== "/" && url.pathname.length > 1) {
        const pathSegments = url.pathname.split("/").filter(Boolean);
        if (pathSegments.length > 0) {
          const lastSegment = pathSegments[pathSegments.length - 1];
          firstPageTitle = lastSegment
            .replace(/[-_]/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
        }
      }
    } catch (e) {
      console.log("Error parsing URL for test case name:", e);
    }
  }

  const significantActions = interactions.filter(
    (i) =>
      i.type === "click" &&
      (i.element?.tagName === "BUTTON" ||
        i.element?.type === "submit" ||
        i.description?.toLowerCase().includes("submit") ||
        i.description?.toLowerCase().includes("login") ||
        i.description?.toLowerCase().includes("sign in"))
  );

  let actionName = "";
  if (significantActions.length > 0) {
    actionName =
      significantActions[0].element?.innerText ||
      significantActions[0].description?.replace(/^Click on /i, "") ||
      "Action";

    const actionWords = actionName.split(" ").slice(0, 3).join(" ");
    actionName = actionWords || "Action";
  }

  if (actionName) {
    return `${firstPageTitle} - ${actionName}`;
  } else {
    return `${firstPageTitle} Test`;
  }
}

async function saveToGoogleSheets(interactions) {
  console.log("Saving interactions:", interactions);

  try {
    if (
      !interactions ||
      !Array.isArray(interactions) ||
      interactions.length === 0
    ) {
      console.error("[Sheets] No interactions to save:", interactions);
      throw new Error(
        "No interactions to save. Please record some actions first."
      );
    }

    const enhancedInteractions = processInteractions(interactions);

    const testCaseName = getTestCaseName(enhancedInteractions);

    console.log("[Sheets] Using test case name:", testCaseName);

    const token = await getAccessToken();
    if (!token) {
      throw new Error("Failed to get auth token");
    }

    if (!spreadsheetId) {
      await createSpreadsheet();
    }

    if (!spreadsheetId) {
      throw new Error("Failed to create or get spreadsheet");
    }

    let needsHeaders = !recordingState.targetSpreadsheetId;

    const headers = [
      "Module/Feature",
      "Test Case Description",
      "Test Steps",
      "Test Data",
      "Expected Result",
      "Actual Result",
      "Priority",
      "Tester",
      "Status",
    ];

    const testSteps = enhancedInteractions
      .map((interaction, index) => formatTestStep(interaction, index + 1))
      .filter((step) => step)
      .join("\n");

    const expectedResults = enhancedInteractions
      .map(
        (interaction) =>
          interaction.expectedResult || "Action should complete successfully"
      )
      .join("\n");

    const formatTesterName = (name) => {
      if (!name) return "";
      return name
        .split(" ")
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join(" ");
    };

    const consolidatedRow = [
      testCaseName,
      `${testCaseName}`,
      testSteps,
      "",
      "",
      expectedResults,
      "P1",
      formatTesterName(recordingState.testerName),
      "Pass",
    ];

    const values = needsHeaders
      ? [headers, consolidatedRow]
      : [consolidatedRow];

    let range = needsHeaders ? "Interactions!A1" : "Interactions!A:I";

    if (recordingState.targetSpreadsheetId) {
      try {
        const nextRowResponse = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Interactions!A:A?majorDimension=COLUMNS`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (nextRowResponse.ok) {
          const data = await nextRowResponse.json();
          let nextRow =
            data.values && data.values[0] ? data.values[0].length + 1 : 1;

          if (nextRow === 1) {
            needsHeaders = true;
            values[0] = headers;
          }

          range = `Interactions!A${nextRow}`;
        }
      } catch (error) {
        console.error("[Sheets] Error finding next empty row:", error);
        range = "Interactions!A:I";
      }
    }

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: values,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Sheets] Error writing data:", errorText);
      throw new Error(`Error writing data to spreadsheet: ${errorText}`);
    }

    await autoResizeColumns(token, spreadsheetId);

    console.log("[Sheets] Successfully saved interactions to spreadsheet");
    return spreadsheetUrl;
  } catch (error) {
    console.error("[Sheets] Error in saveToGoogleSheets:", error);
    throw error;
  }
}

async function formatSpreadsheet(spreadsheetId, token) {
  console.log("Formatting spreadsheet headers:", spreadsheetId);
  try {
    const getResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!getResponse.ok) {
      const getError = await getResponse.text();
      console.error("[Sheets] Error getting spreadsheet info:", getError);
      return;
    }

    const spreadsheetData = await getResponse.json();

    if (!spreadsheetData.sheets || spreadsheetData.sheets.length === 0) {
      console.error("[Sheets] No sheets found in the spreadsheet");
      return;
    }

    const firstSheetId = spreadsheetData.sheets[0].properties.sheetId;
    console.log("[Sheets] Using sheet ID:", firstSheetId);

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: firstSheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: 9,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: {
                      red: 0.82,
                      green: 0.88,
                      blue: 0.98,
                    },
                    textFormat: {
                      bold: true,
                      foregroundColor: {
                        red: 0.0,
                        green: 0.0,
                        blue: 0.0,
                      },
                      fontSize: 11,
                    },
                    horizontalAlignment: "CENTER",
                    verticalAlignment: "MIDDLE",
                    padding: {
                      top: 5,
                      right: 5,
                      bottom: 5,
                      left: 5,
                    },
                  },
                },
                fields:
                  "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)",
              },
            },

            {
              repeatCell: {
                range: {
                  sheetId: firstSheetId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: 9,
                },
                cell: {
                  userEnteredFormat: {
                    wrapStrategy: "WRAP",
                  },
                },
                fields: "userEnteredFormat.wrapStrategy",
              },
            },
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 6,
                      endColumnIndex: 7,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [
                        {
                          userEnteredValue: "P1",
                        },
                      ],
                    },
                    format: {
                      textFormat: {
                        foregroundColor: {
                          red: 0.8,
                          green: 0.0,
                          blue: 0.0,
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 0.9,
                        blue: 0.9,
                      },
                    },
                  },
                },
                index: 0,
              },
            },

            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 6,
                      endColumnIndex: 7,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [
                        {
                          userEnteredValue: "P2",
                        },
                      ],
                    },
                    format: {
                      textFormat: {
                        foregroundColor: {
                          red: 0.85,
                          green: 0.5,
                          blue: 0.0,
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 0.95,
                        blue: 0.8,
                      },
                    },
                  },
                },
                index: 1,
              },
            },
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 6,
                      endColumnIndex: 7,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [
                        {
                          userEnteredValue: "P3",
                        },
                      ],
                    },
                    format: {
                      textFormat: {
                        foregroundColor: {
                          red: 0.85,
                          green: 0.7,
                          blue: 0.0,
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 1.0,
                        blue: 0.8,
                      },
                    },
                  },
                },
                index: 2,
              },
            },
            {
              updateSheetProperties: {
                properties: {
                  sheetId: firstSheetId,
                  gridProperties: {
                    frozenRowCount: 1,
                  },
                },
                fields: "gridProperties.frozenRowCount",
              },
            },
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: 9,
                },
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 1,
                  endIndex: 2,
                },
                properties: {
                  pixelSize: 150,
                },
                fields: "pixelSize",
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 2,
                  endIndex: 3,
                },
                properties: {
                  pixelSize: 200,
                },
                fields: "pixelSize",
              },
            },
            {
              updateDimensionProperties: {
                range: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 4,
                  endIndex: 5,
                },
                properties: {
                  pixelSize: 250,
                },
                fields: "pixelSize",
              },
            },
            {
              setDataValidation: {
                range: {
                  sheetId: firstSheetId,
                  startRowIndex: 1,
                  startColumnIndex: 8,
                  endColumnIndex: 9,
                },
                rule: {
                  condition: {
                    type: "ONE_OF_LIST",
                    values: [
                      { userEnteredValue: "Pass" },
                      { userEnteredValue: "Fail" },
                    ],
                  },
                  strict: true,
                  showCustomUi: true,
                },
              },
            },
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 8,
                      endColumnIndex: 9,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [
                        {
                          userEnteredValue: "Pass",
                        },
                      ],
                    },
                    format: {
                      backgroundColor: {
                        red: 0.85,
                        green: 0.95,
                        blue: 0.85,
                      },
                      textFormat: {
                        bold: true,
                        foregroundColor: {
                          red: 0.1,
                          green: 0.1,
                          blue: 0.1,
                        },
                      },
                    },
                  },
                },
                index: 3,
              },
            },
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 8,
                      endColumnIndex: 9,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: "TEXT_EQ",
                      values: [
                        {
                          userEnteredValue: "Fail",
                        },
                      ],
                    },
                    format: {
                      backgroundColor: {
                        red: 0.92,
                        green: 0.75,
                        blue: 0.8,
                      },
                      textFormat: {
                        bold: true,
                        foregroundColor: {
                          red: 0.8,
                          green: 0.0,
                          blue: 0.0,
                        },
                      },
                    },
                  },
                },
                index: 4,
              },
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to format spreadsheet: ${error}`);
    }

    console.log("Spreadsheet formatted successfully with updated styling");
  } catch (error) {
    console.error("[Sheets] Error formatting spreadsheet:", error);
  }
}

async function autoResizeColumns(token, spreadsheetId) {
  try {
    const getResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!getResponse.ok) {
      const getError = await getResponse.text();
      console.error("[Sheets] Error getting spreadsheet info:", getError);
      return;
    }

    const spreadsheetData = await getResponse.json();

    if (!spreadsheetData.sheets || spreadsheetData.sheets.length === 0) {
      console.error("[Sheets] No sheets found in the spreadsheet");
      return;
    }

    const firstSheetId = spreadsheetData.sheets[0].properties.sheetId;

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: 9,
                },
              },
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to auto-resize columns: ${error}`);
    }

    console.log("[Sheets] Columns auto-resized successfully");
  } catch (error) {
    console.error("[Sheets] Error auto-resizing columns:", error);
  }
}

function formatTestStep(interaction, stepNumber) {
  if (!interaction) return null;

  switch (interaction.type) {
    case "navigation":
      if (stepNumber === 1) {
        return `${stepNumber}. Start at ${
          interaction.description
            ? interaction.description.replace(/^Navigate to |^Start at /, "")
            : interaction.pageTitle || interaction.toUrl || interaction.url
        }`;
      } else {
        return `${stepNumber}. Navigate to ${
          interaction.pageTitle || interaction.description
            ? interaction.description.replace(/^Navigate to |^Start at /, "")
            : interaction.toUrl || interaction.url
        }`;
      }

    case "click":
      let clickDescription =
        interaction.description ||
        `Click on ${interaction.element.tagName.toLowerCase()}`;

      if (clickDescription.startsWith("Click on ")) {
        clickDescription = clickDescription.replace(
          "Click on the ",
          "Click on "
        );
      }

      if (
        interaction.element.tagName === "BUTTON" ||
        interaction.element.type === "submit" ||
        interaction.element.type === "button"
      ) {
        const buttonText =
          interaction.element.innerText ||
          interaction.element.value ||
          (clickDescription.match(/Click on ['"](.+?)['"]/)
            ? clickDescription.match(/Click on ['"](.+?)['"]/)[1]
            : null);

        if (buttonText) {
          return `${stepNumber}. Click on '${buttonText}' button`;
        }
      }

      return `${stepNumber}. ${clickDescription}`;

    case "input":
      let fieldName = "input field";
      let inputValue = interaction.inputValue || "";

      const inputMatch = interaction.description.match(/Enter (.+) in (.+)/);
      if (inputMatch && inputMatch.length >= 3) {
        inputValue = inputMatch[1];
        fieldName = inputMatch[2].replace(/^the /, "");
      }

      if (
        interaction.element.isMobileField ||
        interaction.element.type === "tel" ||
        fieldName.toLowerCase().includes("mobile") ||
        fieldName.toLowerCase().includes("phone")
      ) {
        return `${stepNumber}. Enter ${inputValue} in Mobile Number field`;
      }

      if (interaction.element.type === "password") {
        return `${stepNumber}. Enter password in Password field`;
      }

      if (interaction.element.type === "email") {
        return `${stepNumber}. Enter ${inputValue} in Email field`;
      }

      if (
        fieldName.toLowerCase().includes("otp") ||
        interaction.element.id?.toLowerCase().includes("otp") ||
        interaction.element.name?.toLowerCase().includes("otp") ||
        interaction.element.placeholder?.toLowerCase().includes("otp")
      ) {
        return `${stepNumber}. Enter ${inputValue} in OTP field`;
      }

      return `${stepNumber}. Enter ${inputValue} in ${fieldName}`;

    default:
      return `${stepNumber}. ${interaction.description || interaction.type}`;
  }
}

function processInteractions(interactions) {
  const cleanedInteractions = interactions.map((interaction) => {
    const cleanInteraction = { ...interaction };

    if (!cleanInteraction.url) {
      if (cleanInteraction.type === "navigation" && cleanInteraction.toUrl) {
        cleanInteraction.url = cleanInteraction.toUrl;
      } else {
        cleanInteraction.url = "about:blank";
      }
    }

    if (!cleanInteraction.element) {
      cleanInteraction.element = {
        tagName: interaction.type === "navigation" ? "PAGE" : "UNKNOWN",
        xpath: "/html/body",
        type: interaction.type,
      };
    }

    return cleanInteraction;
  });

  let haveInitialNavigation = false;

  const filteredInteractions = cleanedInteractions.filter(
    (interaction, index, array) => {
      if (interaction.type === "navigation") {
        if (index === 0) {
          haveInitialNavigation = true;
          return true;
        }

        for (let i = 0; i < index; i++) {
          const prevInteraction = array[i];
          if (prevInteraction.type === "navigation") {
            const currentUrl = (
              interaction.toUrl ||
              interaction.url ||
              ""
            ).split("#")[0];
            const prevUrl = (
              prevInteraction.toUrl ||
              prevInteraction.url ||
              ""
            ).split("#")[0];

            if (currentUrl === prevUrl) {
              return false;
            }
          }
        }
      }

      if (interaction.type === "click") {
        for (let i = 0; i < index; i++) {
          const prevInteraction = array[i];
          if (
            prevInteraction.type === "click" &&
            prevInteraction.element.xpath === interaction.element.xpath &&
            Math.abs(
              new Date(prevInteraction.timestamp).getTime() -
                new Date(interaction.timestamp).getTime()
            ) < 5000
          ) {
            return false;
          }
        }
      }

      if (interaction.type === "input") {
        for (let i = index + 1; i < array.length; i++) {
          const laterInteraction = array[i];
          if (
            laterInteraction.type === "input" &&
            laterInteraction.element.xpath === interaction.element.xpath
          ) {
            return false;
          }
        }
      }

      return true;
    }
  );

  if (filteredInteractions.length > 0 && !haveInitialNavigation) {
    const firstInteraction = filteredInteractions[0];
    const startingNavigation = {
      type: "navigation",
      timestamp: new Date(
        new Date(firstInteraction.timestamp).getTime() - 1000
      ).toISOString(),
      fromUrl: "",
      toUrl: firstInteraction.url,
      url: firstInteraction.url,
      pageTitle: firstInteraction.pageTitle || "Starting Page",
      description: `Start at ${
        firstInteraction.pageTitle || firstInteraction.url
      }`,
      expectedResult: "Page should be loaded",
      element: {
        tagName: "PAGE",
        xpath: "/html/body",
        type: "navigation",
      },
    };

    filteredInteractions.unshift(startingNavigation);
  }

  const enhancedInteractions = filteredInteractions.map(
    (interaction, index, array) => {
      let enhancedInteraction = { ...interaction };

      if (interaction.type === "click") {
        if (index < array.length - 1 && array[index + 1].type === "input") {
          const nextInput = array[index + 1];
          enhancedInteraction.isFieldClick = true;
          enhancedInteraction.followedByInput = true;
          enhancedInteraction.inputFieldType = nextInput.element.type || "";
        }

        if (
          (interaction.element.tagName === "BUTTON" ||
            interaction.element.type === "submit") &&
          index > 0 &&
          array.slice(0, index).some((item) => item.type === "input")
        ) {
          enhancedInteraction.isSubmitAfterInput = true;
        }
      }

      if (interaction.type === "input") {
        const fieldName =
          interaction.description?.match(/Enter .+ in (.+)/)?.[1] || "";

        if (
          fieldName.toLowerCase().includes("mobile") ||
          fieldName.toLowerCase().includes("phone") ||
          interaction.element.type === "tel"
        ) {
          enhancedInteraction.specialFieldType = "mobile";
        } else if (
          fieldName.toLowerCase().includes("otp") ||
          interaction.element.id?.toLowerCase().includes("otp") ||
          interaction.element.name?.toLowerCase().includes("otp")
        ) {
          enhancedInteraction.specialFieldType = "otp";
        } else if (interaction.element.type === "password") {
          enhancedInteraction.specialFieldType = "password";
        } else if (interaction.element.type === "email") {
          enhancedInteraction.specialFieldType = "email";
        }
      }

      return enhancedInteraction;
    }
  );

  return enhancedInteractions;
}
