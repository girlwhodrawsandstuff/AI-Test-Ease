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
      spreadsheetId = recordingState.targetSpreadsheetId;
      spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      // Verify spreadsheet exists and is accessible
      await verifySpreadsheetAccess(spreadsheetId);
      return spreadsheetId;
    }

    const token = await getAccessToken();
    if (!token) {
      throw new Error("Failed to get auth token");
    }

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
                },
              },
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        "[Sheets] Spreadsheet creation failed:",
        response.status,
        responseText
      );

      let errorData;
      try {
        errorData = JSON.parse(responseText);
      } catch (e) {
        errorData = { error: responseText };
      }

      console.error("[Sheets] Parsed error data:", errorData);

      // If unauthorized, try to refresh the token
      if (response.status === 401) {
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
                  resolve(token);
                }
              }
            );
          });
        };

        const newToken = await getToken(true);

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
        return spreadsheetId;
      }

      throw new Error(
        `Failed to create spreadsheet: ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    spreadsheetId = data.spreadsheetId;
    spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    return spreadsheetId;
  } catch (error) {
    console.error("[Sheets] Error in createSpreadsheet:", error);
    throw error;
  }
}

// New function to verify access to an existing spreadsheet
async function verifySpreadsheetAccess(spreadsheetId) {
  try {
    const token = await getAccessToken();
    if (!token) {
      throw new Error("Failed to get auth token");
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
      throw new Error(`Cannot access spreadsheet: ${responseText}`);
    }

    const data = await response.json();
    return true;
  } catch (error) {
    console.error("[Sheets] Error verifying spreadsheet access:", error);
    throw error;
  }
}

async function saveToGoogleSheets(interactions) {
  if (!spreadsheetId) {
    await createSpreadsheet();
  }

  if (!spreadsheetId) {
    throw new Error("Failed to create or get spreadsheet");
  }

  const token = await getAccessToken();
  if (!token) {
    throw new Error("Failed to get auth token");
  }

  // Check if we need to add headers (only for new spreadsheets)
  let needsHeaders = !recordingState.targetSpreadsheetId;

  // Prepare the data
  const headers = [
    "Timestamp",
    "Type",
    "URL",
    "Element Tag",
    "Element ID",
    "Element Class",
    "Element Text",
    "XPath",
  ];

  const rows = interactions.map((interaction) => [
    interaction.timestamp,
    interaction.type,
    interaction.url,
    interaction.element.tagName,
    interaction.element.id,
    interaction.element.className,
    interaction.element.innerText || interaction.element.placeholder || "",
    interaction.element.xpath,
  ]);

  // Add headers if this is a new spreadsheet
  const values = needsHeaders ? [headers, ...rows] : rows;

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
          values.unshift(headers);
        }

        range = `Interactions!A${nextRow}`;
      }
    } catch (error) {
      console.error("[Sheets] Error finding next empty row:", error);
      // Fall back to appending
      range = "Interactions!A:H";
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

      return;
    }

    const error = await response.text();
    throw new Error(`Failed to save to spreadsheet: ${error}`);
  }
}
