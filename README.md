# AI Test Ease Chrome Extension

A Chrome extension for recording user interactions and generating test cases using AI. It records clicks, form inputs, and other interactions, then uses AI to analyze the data and generate structured test cases in Google Sheets.

## Setup

### Backend Setup
1. Create a virtual environment:
   ```
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   ```

2. Install dependencies:
   ```
   pip install flask==2.0.1 werkzeug==2.0.3 flask-cors==3.0.10 python-dotenv==0.19.0 openai==1.1.1 httpx<0.25.0 gunicorn==20.1.0
   ```

3. Configure:
   ```
   cp .env.example .env
   # Edit .env with your API keys
   ```

4. Start server:
   ```
   python app.py
   ```

### Chrome Extension Setup
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this project directory
4. The extension should now be installed

## Usage
1. Start the backend server
2. Click the extension icon
3. Set any options (spreadsheet URL, etc.)
4. Click "Start Recording"
5. Perform actions on the page
6. Click "Stop Recording"
7. Open the generated Google Sheet 