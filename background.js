// Add error handler for uncaught errors
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

// Add error handler for unhandled promise rejections
self.onunhandledrejection = function (event) {
  console.error("[Background] Unhandled promise rejection:", event.reason);
};

let spreadsheetId = null;
let spreadsheetUrl = null;
let recordingState = {
  isRecording: false,
  tabId: null,
  targetSpreadsheetId: null, // Store spreadsheet ID from user input
};

// Configuration for AI integration
const AI_CONFIG = {
  enabled: true, // AI processing is enabled by default
  backendUrl: "http://localhost:5000", // URL to your backend service
};

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startRecording") {
    // Get the current active tab if sender.tab is not available
    if (!sender.tab) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          recordingState.isRecording = true;
          recordingState.tabId = tabs[0].id;

          // Store spreadsheet ID if provided
          if (message.spreadsheetId) {
            recordingState.targetSpreadsheetId = message.spreadsheetId;
          } else {
            recordingState.targetSpreadsheetId = null;
          }

          sendResponse({ status: "Recording started" });
        } else {
          sendResponse({ status: "error", error: "No active tab found" });
        }
      });
      return true; // Will respond asynchronously
    }

    recordingState.isRecording = true;
    recordingState.tabId = sender.tab.id;

    // Store spreadsheet ID if provided
    if (message.spreadsheetId) {
      recordingState.targetSpreadsheetId = message.spreadsheetId;
    } else {
      recordingState.targetSpreadsheetId = null;
    }

    sendResponse({ status: "Recording started" });
  } else if (message.action === "stopRecording") {
    recordingState.isRecording = false;
    recordingState.tabId = null;
    // We keep the targetSpreadsheetId intact for the saveInteractions call
    sendResponse({ status: "Recording stopped" });
  } else if (message.action === "getRecordingState") {
    sendResponse(recordingState);
  } else if (message.action === "saveInteractions") {
    saveToGoogleSheets(message.interactions)
      .then(() => {
        sendResponse({ status: "success", url: spreadsheetUrl });
      })
      .catch((error) => {
        console.error("Error saving interactions:", error);
        sendResponse({ status: "error", error: error.message });
      });
    return true; // Will respond asynchronously
  } else if (message.action === "getSpreadsheetInfo") {
    sendResponse({ url: spreadsheetUrl });
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (recordingState.isRecording && recordingState.tabId === tabId) {
    // If the tab is being updated and we're recording, ensure content script is injected
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

    // chrome.identity.getAuthToken returns the token via callback, not directly
    // We need to wrap it in a Promise
    const getToken = (interactive) => {
      return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken(
          {
            interactive: interactive,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            // The client_id is already specified in the manifest.json and doesn't need to be
            // explicitly provided here, but logging for verification
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

    // First try to get token without interactive prompt
    let token;
    try {
      token = await getToken(false);
    } catch (e) {
      console.log("[Auth] Failed to get non-interactive token:", e);
    }

    // If no token, try with interactive prompt
    if (!token) {
      token = await getToken(true);
    }

    if (!token) {
      throw new Error("Failed to get auth token");
    }

    // Verify the token is valid by making a test request
    const testResponse = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=" +
        token
    );

    if (!testResponse.ok) {
      // Revoke the current token
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

      // Get a new token
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
    // Check if we should use an existing spreadsheet
    if (recordingState.targetSpreadsheetId) {
      console.log(
        `[Sheets] Using existing spreadsheet: ${recordingState.targetSpreadsheetId}`
      );
      spreadsheetId = recordingState.targetSpreadsheetId;
      spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      // Verify spreadsheet exists and is accessible
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Failed to get auth token");
      }

      await verifySpreadsheetAccess(spreadsheetId, token);

      // Don't try to format an existing spreadsheet - it likely already has headers
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
                  columnCount: 8, // Updated for new column structure
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

      // If token is expired, refresh it and try again
      if (errorStatus === 401) {
        console.log(
          "[Sheets] Token expired during spreadsheet creation, refreshing..."
        );

        // Revoke the current token
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

        // Get a new token with the getToken Promise wrapper
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

        // Retry with new token
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
                      columnCount: 8, // Updated for new column structure
                    },
                  },
                },
              ],
            }),
          }
        );

        // Check retry response
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

    // Format the spreadsheet headers for new spreadsheets only
    try {
      // Add bold formatting to the header row
      await formatSpreadsheet(spreadsheetId, token);
    } catch (error) {
      console.error("[Sheets] Error formatting spreadsheet:", error);
      // Non-fatal error, we can continue
    }

    return spreadsheetId;
  } catch (error) {
    console.error("[Sheets] Error in createSpreadsheet:", error);
    throw error;
  }
}

// New function to verify access to an existing spreadsheet
async function verifySpreadsheetAccess(spreadsheetId, token) {
  try {
    if (!token) {
      token = await getAccessToken();
      if (!token) {
        throw new Error("Failed to get auth token");
      }
    }

    // Try to get spreadsheet metadata
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

// Function to analyze interactions with AI and generate descriptions and test cases
async function processInteractionsWithAI(interactions) {
  if (!AI_CONFIG.enabled) {
    console.log("[AI] AI processing is disabled");
    return {
      interactions: interactions,
      testCaseName: "User Interaction Test",
    };
  }

  try {
    console.log("[AI] Starting AI analysis of interactions");
    console.log("[AI] Using backend URL:", AI_CONFIG.backendUrl);

    // Add timeout to prevent hanging on connection issues
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.error("[AI] Request timed out after 20 seconds");
    }, 20000);

    // Call our backend service with timeout
    try {
      const response = await fetch(`${AI_CONFIG.backendUrl}/api/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ interactions }),
        signal: controller.signal,
      });

      // Clear the timeout since we got a response
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.text();
        console.error("[AI] Backend API error:", errorData);
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

      // Enhance the original interactions with AI-generated content
      const enhancedInteractions = interactions.map((interaction, index) => {
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
      });

      return {
        interactions: enhancedInteractions,
        testCaseName: aiResponse.testCaseName,
      };
    } catch (fetchError) {
      // Clear timeout if fetch failed
      clearTimeout(timeoutId);

      if (fetchError.name === "AbortError") {
        console.error("[AI] Request aborted due to timeout");
        throw new Error(
          "Backend request timed out. Please check if the server is running."
        );
      }

      throw fetchError;
    }
  } catch (error) {
    console.error("[AI] Error processing interactions with AI:", error);

    // Create basic fallback data
    const fallbackInteractions = interactions.map((interaction) => {
      let actionDesc = `${interaction.type} on ${
        interaction.element.tagName || "element"
      }`;

      // Add more context if available
      if (interaction.element.innerText) {
        actionDesc += ` with text "${interaction.element.innerText.substring(
          0,
          30
        )}"`;
      } else if (interaction.element.id) {
        actionDesc += ` with id "${interaction.element.id}"`;
      } else if (interaction.element.className) {
        actionDesc += ` with class "${interaction.element.className}"`;
      }

      return {
        ...interaction,
        aiActionDescription: actionDesc,
        aiExpectedResult: "The action should complete successfully",
        aiPriority: "P1",
      };
    });

    // Create a test name based on URL if possible
    let testName = "User Interaction Test";
    if (interactions.length > 0 && interactions[0].url) {
      try {
        const url = new URL(interactions[0].url);
        testName = `Interaction Test on ${url.hostname}`;
      } catch (e) {
        // Use default if URL parsing fails
      }
    }

    return {
      interactions: fallbackInteractions,
      testCaseName: testName,
    };
  }
}

// Update in chrome.storage when AI settings change
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    if (changes.aiEnabled) {
      AI_CONFIG.enabled = changes.aiEnabled.newValue;
    }
    if (changes.backendUrl) {
      AI_CONFIG.backendUrl = changes.backendUrl.newValue;
    }
  }
});

// Initialize AI settings from storage
chrome.storage.sync.get(["aiEnabled", "backendUrl"], (result) => {
  if (result.aiEnabled !== undefined) AI_CONFIG.enabled = result.aiEnabled;
  if (result.backendUrl) AI_CONFIG.backendUrl = result.backendUrl;
});

// Modify the saveToGoogleSheets function to use AI
async function saveToGoogleSheets(interactions) {
  console.log("Saving interactions:", interactions);

  try {
    // Process interactions with AI if enabled
    const processedData = await processInteractionsWithAI(interactions);
    const enhancedInteractions = processedData.interactions;
    const testCaseName = processedData.testCaseName;

    console.log("[Sheets] Using test case name:", testCaseName);

    // Get access token first - we'll need it throughout the function
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

    // Check if we need to add headers (only for new spreadsheets)
    let needsHeaders = !recordingState.targetSpreadsheetId;

    // Generate a unique Test Case ID for this recording session
    const testCaseId = `TC${String(Date.now()).substr(-6)}`;

    // Prepare the data with the new format
    const headers = [
      "Module/Feature",
      "Test Case Description",
      "Test Steps",
      "Test Data",
      "Expected Result",
      "Actual Result",
      "Severity",
      "Priority",
    ];

    // Condense all interactions into a single test case row

    // Combine all steps into a numbered list
    const testSteps = enhancedInteractions
      .map(
        (interaction, index) =>
          `${index + 1}. ${
            interaction.aiActionDescription || interaction.type + " on element"
          }`
      )
      .join("\n");

    // Combine all expected results
    const expectedResults = enhancedInteractions
      .map(
        (interaction) =>
          interaction.aiExpectedResult || "Action should complete successfully"
      )
      .join("\n");

    // Get highest priority (P1 is highest, then P2, then P3)
    const priorities = enhancedInteractions
      .map((interaction) => interaction.aiPriority || "P3")
      .sort();
    const highestPriority = priorities.length > 0 ? priorities[0] : "P1";

    // Create a single consolidated row
    const consolidatedRow = [
      testCaseName, // Module/Feature now contains test case name
      `End-to-end test for ${testCaseName}`, // More descriptive test case description
      testSteps, // All steps combined with numbering
      "", // Test Data (empty for now)
      expectedResults, // All expected results combined
      "", // Actual Result (empty, to be filled during test execution)
      "", // Severity (empty for now)
      highestPriority, // Use highest priority found
    ];

    // Add headers if this is a new spreadsheet
    const values = needsHeaders
      ? [headers, consolidatedRow]
      : [consolidatedRow];

    // Determine where to append data
    let range = needsHeaders ? "Interactions!A1" : "Interactions!A:H";

    // If using an existing spreadsheet, find the next empty row
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
          // If there's data, get the length (number of rows), otherwise start at row 1
          let nextRow =
            data.values && data.values[0] ? data.values[0].length + 1 : 1;

          // If we're starting from row 1, we need to add headers
          if (nextRow === 1) {
            needsHeaders = true;
            values[0] = headers;
          }

          range = `Interactions!A${nextRow}`;
        }
      } catch (error) {
        console.error("[Sheets] Error finding next empty row:", error);
        // Fall back to appending
        range = "Interactions!A:H";
      }
    }

    // Handle existing test case IDs to ensure uniqueness
    if (recordingState.targetSpreadsheetId) {
      try {
        // Check for existing test case IDs
        const testCaseResponse = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Interactions!A:A?majorDimension=COLUMNS`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (testCaseResponse.ok) {
          const data = await testCaseResponse.json();
          if (data.values && data.values[0]) {
            // If our testCaseId already exists, generate a new one
            if (data.values[0].includes(testCaseId)) {
              // Generate a truly unique one by adding a random suffix
              const uniqueTestCaseId = `TC${String(Date.now()).substr(
                -6
              )}_${Math.floor(Math.random() * 1000)}`;
              // Update the consolidated row with the new ID
              consolidatedRow[0] = uniqueTestCaseId;
            }
          }
        }
      } catch (error) {
        console.error("[Sheets] Error checking existing test case IDs:", error);
      }
    }

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW`,
      {
        method: "POST",
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
      // If token is expired, try refreshing it
      if (response.status === 401) {
        console.log("Token expired during data saving, refreshing...");

        // Revoke the current token
        await new Promise((resolve, reject) => {
          chrome.identity.removeCachedAuthToken({ token }, () => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve();
            }
          });
        });

        // Get a new token with the getToken Promise wrapper
        const getToken = (interactive) => {
          return new Promise((resolve, reject) => {
            chrome.identity.getAuthToken(
              {
                interactive: interactive,
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
              },
              (token) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(token);
                }
              }
            );
          });
        };

        const newToken = await getToken(true);

        // Retry with new token
        const retryResponse = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${newToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              values: values,
            }),
          }
        );

        if (!retryResponse.ok) {
          const retryError = await retryResponse.text();
          throw new Error(
            `Failed to save data after token refresh: ${retryError}`
          );
        }

        console.log(
          "Data saved to spreadsheet successfully after token refresh"
        );
        return;
      }

      const error = await response.text();
      throw new Error(`Failed to save to spreadsheet: ${error}`);
    }

    console.log("Data saved to spreadsheet successfully");
  } catch (error) {
    console.error("[Sheets] Error in saveToGoogleSheets:", error);
    throw error;
  }
}

async function formatSpreadsheet(spreadsheetId, token) {
  console.log("Formatting spreadsheet headers:", spreadsheetId);
  try {
    // First, get the spreadsheet to find the actual first sheet ID
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
      // Continue without formatting rather than failing completely
      return;
    }

    const spreadsheetData = await getResponse.json();

    // Check if we have sheets and get the first sheet's ID
    if (!spreadsheetData.sheets || spreadsheetData.sheets.length === 0) {
      console.error("[Sheets] No sheets found in the spreadsheet");
      return;
    }

    const firstSheetId = spreadsheetData.sheets[0].properties.sheetId;
    console.log("[Sheets] Using sheet ID:", firstSheetId);

    // Add enhanced formatting to the header row
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
            // Format header cells with updated styling
            {
              repeatCell: {
                range: {
                  sheetId: firstSheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: 8, // 8 columns (A-H)
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: {
                      red: 0.82,
                      green: 0.88,
                      blue: 0.98, // Light cornflower blue 2
                    },
                    textFormat: {
                      bold: true,
                      foregroundColor: {
                        red: 0.0,
                        green: 0.0,
                        blue: 0.0, // Black text
                      },
                      fontSize: 11, // Slightly larger font
                    },
                    horizontalAlignment: "CENTER", // Center align text
                    verticalAlignment: "MIDDLE", // Middle align vertically
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
            // Enable text wrapping for all cells
            {
              repeatCell: {
                range: {
                  sheetId: firstSheetId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: 8, // All columns
                },
                cell: {
                  userEnteredFormat: {
                    wrapStrategy: "WRAP", // Enable text wrapping
                  },
                },
                fields: "userEnteredFormat.wrapStrategy",
              },
            },
            // Format priority column with color coding - P1 (high priority)
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1, // Start after header row
                      startColumnIndex: 7, // Priority column (H)
                      endColumnIndex: 8,
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
                          blue: 0.0, // Dark red text
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 0.9,
                        blue: 0.9, // Very light red background
                      },
                    },
                  },
                },
                index: 0,
              },
            },
            // P2 (medium priority) formatting
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 7,
                      endColumnIndex: 8,
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
                          blue: 0.0, // Orange text
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 0.95,
                        blue: 0.8, // Very light orange background
                      },
                    },
                  },
                },
                index: 1,
              },
            },
            // P3 (low priority) formatting
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [
                    {
                      sheetId: firstSheetId,
                      startRowIndex: 1,
                      startColumnIndex: 7,
                      endColumnIndex: 8,
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
                          blue: 0.0, // Amber/yellow text
                        },
                        bold: true,
                      },
                      backgroundColor: {
                        red: 1.0,
                        green: 1.0,
                        blue: 0.8, // Very light yellow background
                      },
                    },
                  },
                },
                index: 2,
              },
            },
            // Freeze the header row
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
            // Auto-resize columns to fit content
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId: firstSheetId,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: 8,
                },
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
    // Don't rethrow the error - treat formatting errors as non-fatal
  }
}
