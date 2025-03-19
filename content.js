let events = [];
let isRecording = false;
let sessionInfo = {
  testName: '',
  testDescription: '',
  startTime: null,
  browser: navigator.userAgent,
  windowSize: {
    width: window.innerWidth,
    height: window.innerHeight
  }
};

// Listen for messages from the background script
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === 'startRecording') {
    isRecording = true;
    events = [];
    sessionInfo.testName = message.testName;
    sessionInfo.testDescription = message.testDescription;
    sessionInfo.startTime = new Date().toISOString();
    
    // Capture initial URL
    events.push({
      type: 'navigate',
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    });
    console.log('Recording started');
    sendResponse({success: true});
  } else if (message.action === 'stopRecording') {
    isRecording = false;
    sessionInfo.endTime = new Date().toISOString();
    
    // Send events to background script
    chrome.runtime.sendMessage({
      action: 'saveEvents',
      events: events,
      sessionInfo: sessionInfo
    }, function(response) {
      sendResponse({success: response && response.success});
    });
    console.log('Recording stopped');
    return true; // Keep the message channel open for the async response
  }
});

// Record clicks
document.addEventListener('click', function(e) {
  if (!isRecording) return;
  
  const element = e.target;
  const selector = getCssSelector(element);
  
  events.push({
    type: 'click',
    selector: selector,
    text: element.textContent.trim(),
    elementType: element.tagName.toLowerCase(),
    isButton: element.tagName === 'BUTTON' || element.type === 'button' || element.role === 'button',
    isLink: element.tagName === 'A',
    location: {
      x: e.clientX,
      y: e.clientY
    },
    timestamp: Date.now(),
    pageTitle: document.title,
    url: window.location.href
  });
  
  console.log('Recorded click:', selector);
});

// Record form inputs
document.addEventListener('input', function(e) {
  if (!isRecording) return;
  
  const element = e.target;
  const selector = getCssSelector(element);
  
  events.push({
    type: 'type',
    selector: selector,
    value: element.type === 'password' ? '********' : element.value, // Mask passwords
    placeholder: element.placeholder || '',
    fieldName: element.name || '',
    fieldType: element.type || '',
    timestamp: Date.now(),
    pageTitle: document.title,
    url: window.location.href
  });
  
  console.log('Recorded input:', selector);
});

// Record form submissions
document.addEventListener('submit', function(e) {
  if (!isRecording) return;
  
  const element = e.target;
  const selector = getCssSelector(element);
  
  events.push({
    type: 'submit',
    selector: selector,
    timestamp: Date.now(),
    pageTitle: document.title,
    url: window.location.href
  });
  
  console.log('Recorded form submission:', selector);
});

// Record page navigation
window.addEventListener('popstate', function() {
  if (!isRecording) return;
  
  events.push({
    type: 'navigate',
    url: window.location.href,
    title: document.title,
    timestamp: Date.now()
  });
  
  console.log('Recorded navigation:', window.location.href);
});

// Record navigation via URL bar or link clicks
// This captures navigation that popstate might miss
let lastUrl = window.location.href;
new MutationObserver(function() {
  if (isRecording && window.location.href !== lastUrl) {
    events.push({
      type: 'navigate',
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    });
    console.log('Recorded navigation (observer):', window.location.href);
    lastUrl = window.location.href;
  }
}).observe(document, {subtree: true, childList: true});

// Helper function to generate CSS selector for an element
function getCssSelector(element) {
  if (element.id) {
    return '#' + element.id;
  }
  
  if (element.className && typeof element.className === 'string') {
    return '.' + element.className.trim().replace(/\s+/g, '.');
  }
  
  // Try to find a unique attribute
  for (const attr of ['name', 'placeholder', 'type', 'value', 'role', 'aria-label']) {
    if (element.getAttribute(attr)) {
      return element.tagName.toLowerCase() + '[' + attr + '="' + element.getAttribute(attr) + '"]';
    }
  }
  
  // Fallback to tag name with nth-child
  let index = 1;
  let sibling = element.previousElementSibling;
  
  while (sibling) {
    if (sibling.tagName === element.tagName) {
      index++;
    }
    sibling = sibling.previousElementSibling;
  }
  
  return element.tagName.toLowerCase() + ':nth-child(' + index + ')';
}