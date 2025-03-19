let recordedEvents = [];
let sessionInfo = {};
let generatedDoc = null;

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  console.log('Background received message:', message.action);
  
  if (message.action === 'startRecording') {
    // Clear previous recordings
    recordedEvents = [];
    sessionInfo = {};
    generatedDoc = null;
    
    // Set recording state
    chrome.storage.local.set({
      isRecording: true,
      hasRecordedEvents: false,
      docGenerated: false
    });
    
    // Notify content script to start recording
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'startRecording',
          testName: message.testName,
          testDescription: message.testDescription
        }, function(response) {
          console.log('Content script started recording:', response);
          sendResponse({success: true});
        });
      }
    });
    
    // Keep the message channel open for the async response
    return true;
  } 
  else if (message.action === 'stopRecording') {
    chrome.storage.local.set({isRecording: false});
    
    // Notify content script to stop recording
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {action: 'stopRecording'}, function(response) {
          console.log('Content script stopped recording:', response);
          sendResponse({success: true});
        });
      }
    });
    
    // Keep the message channel open for the async response
    return true;
  } 
  else if (message.action === 'saveEvents') {
    recordedEvents = message.events;
    sessionInfo = message.sessionInfo;
    
    chrome.storage.local.set({
      hasRecordedEvents: true,
      recordedEvents: recordedEvents,
      sessionInfo: sessionInfo
    });
    
    console.log('Events saved:', recordedEvents.length);
    
    // Notify popup that events were saved
    chrome.runtime.sendMessage({
      action: 'updateStatus',
      status: 'Recording saved. Ready to generate documentation.',
      enableButtons: ['start', 'generate'],
      disableButtons: ['stop', 'download']
    });
    
    sendResponse({success: true});
  } 
  else if (message.action === 'generateDocs') {
    // First check if we have events in memory, if not, load from storage
    if (recordedEvents.length === 0) {
      chrome.storage.local.get(['recordedEvents', 'sessionInfo'], function(data) {
        if (data.recordedEvents && data.recordedEvents.length > 0) {
          recordedEvents = data.recordedEvents;
          sessionInfo = data.sessionInfo;
          generateAndSaveDocumentation(sendResponse);
        } else {
          sendResponse({success: false, error: 'No recorded events found'});
        }
      });
    } else {
      generateAndSaveDocumentation(sendResponse);
    }
    
    // Keep the message channel open for the async response
    return true;
  }
  else if (message.action === 'downloadDocs') {
    console.log('doc that is generated', generatedDoc)
    if (generatedDoc) {
      downloadDocumentation(sendResponse);
    } else {
      // Try to load the generated doc from storage
      chrome.storage.local.get('generatedDoc', function(data) {
        if (data.generatedDoc) {
          generatedDoc = data.generatedDoc;
          downloadDocumentation(sendResponse);
        } else {
          sendResponse({success: false, error: 'No generated documentation found'});
        }
      });
    }
    
    // Keep the message channel open for the async response
    return true;
  }
});

// Helper function to generate and save documentation
function generateAndSaveDocumentation(sendResponse) {
  generateAIDocumentation(recordedEvents, sessionInfo)
    .then(doc => {
      generatedDoc = doc;
      chrome.storage.local.set({
        docGenerated: true,
        generatedDoc: doc
      });
      
      // Notify popup that documentation was generated
      chrome.runtime.sendMessage({
        action: 'updateStatus',
        status: 'Documentation generated. Ready to download.',
        enableButtons: ['start', 'generate', 'download'],
        disableButtons: ['stop']
      });
      
      sendResponse({success: true});
    })
    .catch(error => {
      console.error('Error generating documentation:', error);
      
      // Notify popup of error
      chrome.runtime.sendMessage({
        action: 'updateStatus',
        status: 'Error generating documentation. Please try again.',
        enableButtons: ['start', 'generate'],
        disableButtons: ['stop', 'download']
      });
      
      sendResponse({success: false, error: error.message});
    });
}

// Helper function to download documentation
function downloadDocumentation(sendResponse) {
  try {
    // Create a blob and download it
    const blob = new Blob([generatedDoc], {type: 'text/markdown'});
    const url = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: url,
      filename: `${sessionInfo.testName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_test_case.md`,
      saveAs: true
    }, function(downloadId) {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
        sendResponse({success: false, error: chrome.runtime.lastError.message});
      } else {
        sendResponse({success: true, downloadId: downloadId});
      }
    });
  } catch (error) {
    console.error('Error downloading documentation:', error);
    sendResponse({success: false, error: error.message});
  }
}

// Function to generate human-readable test documentation
async function generateAIDocumentation(events, sessionInfo) {
  if (!events || events.length === 0) {
    return '# No events recorded';
  }
  
  // Format the events in a way that's easier to understand
  const formattedEvents = events.map((event, index) => {
    const timestamp = new Date(event.timestamp).toLocaleTimeString();
    
    switch (event.type) {
      case 'navigate':
        return `Step ${index + 1}: Navigate to "${event.title || event.url}" (${event.url}) at ${timestamp}`;
      
      case 'click':
        let clickDesc = `Step ${index + 1}: Click on `;
        if (event.text) {
          clickDesc += `"${event.text}" `;
        }
        if (event.isButton) {
          clickDesc += `button `;
        } else if (event.isLink) {
          clickDesc += `link `;
        } else {
          clickDesc += `${event.elementType} element `;
        }
        clickDesc += `at ${timestamp}`;
        return clickDesc;
      
      case 'type':
        let inputDesc = `Step ${index + 1}: Enter `;
        if (event.fieldType === 'password') {
          inputDesc += `password `;
        } else {
          inputDesc += `"${event.value}" `;
        }
        
        if (event.fieldName || event.placeholder) {
          inputDesc += `in ${event.fieldName || event.placeholder} field `;
        } else {
          inputDesc += `in ${event.fieldType || 'text'} field `;
        }
        inputDesc += `at ${timestamp}`;
        return inputDesc;
      
      case 'submit':
        return `Step ${index + 1}: Submit form at ${timestamp}`;
        
      default:
        return `Step ${index + 1}: ${event.type} action at ${timestamp}`;
    }
  });

  // Create a markdown document
  const testCaseDoc = `# Test Case: ${sessionInfo.testName}

## Description
${sessionInfo.testDescription}

## Test Environment
- Browser: ${sessionInfo.browser}
- Window Size: ${sessionInfo.windowSize.width}x${sessionInfo.windowSize.height}
- Test Date: ${new Date(sessionInfo.startTime).toLocaleString()}

## Test Steps

${formattedEvents.join('\n\n')}

## Expected Results
[This section would typically be filled in by the tester]

## Notes
- Test execution time: ${calculateDuration(sessionInfo.startTime, sessionInfo.endTime)}
- Number of interactions: ${events.length}
- Starting URL: ${events[0]?.url || 'Unknown'}
- Ending URL: ${events[events.length-1]?.url || 'Unknown'}

`;

  return testCaseDoc;
}

// Helper function to calculate duration
function calculateDuration(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const durationMs = end - start;
  
  const seconds = Math.floor((durationMs / 1000) % 60);
  const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
  
  return `${minutes} minutes, ${seconds} seconds`;
}