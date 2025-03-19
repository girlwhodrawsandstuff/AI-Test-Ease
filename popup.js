document.addEventListener('DOMContentLoaded', function() {
    const startButton = document.getElementById('startRecording');
    const stopButton = document.getElementById('stopRecording');
    const generateButton = document.getElementById('generateDocs');
    const downloadButton = document.getElementById('downloadDocs');
    const statusDiv = document.getElementById('status');
    const testNameInput = document.getElementById('testName');
    const testDescriptionInput = document.getElementById('testDescription');
    
    // Load saved input values when popup opens
    chrome.storage.local.get(['testName', 'testDescription', 'isRecording', 'hasRecordedEvents', 'docGenerated'], function(data) {
      if (data.testName) testNameInput.value = data.testName;
      if (data.testDescription) testDescriptionInput.value = data.testDescription;
      
      // Update button states
      if (data.isRecording) {
        startButton.disabled = true;
        stopButton.disabled = false;
        generateButton.disabled = true;
        downloadButton.disabled = true;
        statusDiv.textContent = 'Recording in progress...';
      } else {
        startButton.disabled = false;
        stopButton.disabled = !data.isRecording;
        generateButton.disabled = !data.hasRecordedEvents;
        downloadButton.disabled = !data.docGenerated;
      }
    });
    
    // Save input values when they change
    testNameInput.addEventListener('input', function() {
      chrome.storage.local.set({testName: testNameInput.value});
    });
    
    testDescriptionInput.addEventListener('input', function() {
      chrome.storage.local.set({testDescription: testDescriptionInput.value});
    });
    
    startButton.addEventListener('click', function() {
      const testName = testNameInput.value || 'Unnamed Test Case';
      const testDescription = testDescriptionInput.value || 'No description provided';
      
      // Save inputs to storage
      chrome.storage.local.set({
        testName: testName,
        testDescription: testDescription,
        isRecording: true,
        hasRecordedEvents: false,
        docGenerated: false
      });
      
      chrome.runtime.sendMessage({
        action: 'startRecording',
        testName: testName,
        testDescription: testDescription
      });
      
      statusDiv.textContent = 'Recording started...';
      startButton.disabled = true;
      stopButton.disabled = false;
      generateButton.disabled = true;
      downloadButton.disabled = true;
    });
    
    stopButton.addEventListener('click', function() {
      chrome.runtime.sendMessage({action: 'stopRecording'});
      chrome.storage.local.set({
        isRecording: false,
        hasRecordedEvents: true
      });
      
      statusDiv.textContent = 'Recording stopped.';
      startButton.disabled = false;
      stopButton.disabled = true;
      generateButton.disabled = false;
      downloadButton.disabled = true;
    });
    
    generateButton.addEventListener('click', function() {
      statusDiv.textContent = 'Generating documentation...';
      chrome.runtime.sendMessage({action: 'generateDocs'}, function(response) {
        if (response && response.success) {
          statusDiv.textContent = 'Documentation generated.';
          chrome.storage.local.set({docGenerated: true});
          downloadButton.disabled = false;
        } else {
          statusDiv.textContent = 'Error generating documentation.';
        }
      });
    });
    
    downloadButton.addEventListener('click', function() {
      chrome.runtime.sendMessage({action: 'downloadDocs'}, function(response) {
        if (response && response.success) {
          statusDiv.textContent = 'Documentation downloaded.';
        } else {
          statusDiv.textContent = 'Error downloading documentation.';
        }
      });
    });
    
    // Listen for messages from background script
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (message.action === 'updateStatus') {
        statusDiv.textContent = message.status;
        
        if (message.enableButtons) {
          if (message.enableButtons.includes('start')) startButton.disabled = false;
          if (message.enableButtons.includes('stop')) stopButton.disabled = false;
          if (message.enableButtons.includes('generate')) generateButton.disabled = false;
          if (message.enableButtons.includes('download')) downloadButton.disabled = false;
        }
        
        if (message.disableButtons) {
          if (message.disableButtons.includes('start')) startButton.disabled = true;
          if (message.disableButtons.includes('stop')) stopButton.disabled = true;
          if (message.disableButtons.includes('generate')) generateButton.disabled = true;
          if (message.disableButtons.includes('download')) downloadButton.disabled = true;
        }
      }
    });
  });