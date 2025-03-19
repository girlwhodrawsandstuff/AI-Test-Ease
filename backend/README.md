# AI Test Ease Backend Service

This is a backend service for the AI Test Ease Chrome extension that handles AI processing of user interactions.

## Setup Instructions

1. Create a virtual environment:
   ```
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   ```

2. Install dependencies:
   ```
   pip install flask==2.0.1 werkzeug==2.0.3 flask-cors==3.0.10 python-dotenv==0.19.0 openai==1.1.1 "httpx<0.25.0" gunicorn==20.1.0
   ```

3. Create and configure `.env` file:
   ```
   cp .env.example .env
   # Edit .env with your API keys
   ```

4. Start the server:
   ```
   python app.py
   ```

## API Endpoint

- **POST /api/analyze** - Analyzes user interactions and returns AI-generated test case data

## Configuration

Configure your Azure OpenAI credentials in the `.env` file:

- `AZURE_OPENAI_API_KEY`: Your Azure OpenAI API key
- `AZURE_OPENAI_API_VERSION`: The Azure OpenAI API version (e.g., "2023-05-15")
- `AZURE_OPENAI_ENDPOINT`: Your Azure OpenAI endpoint URL
- `AZURE_OPENAI_DEPLOYMENT`: The deployment name of your model

## Deployment

For production deployment, consider using Gunicorn:

```
gunicorn app:app -b 0.0.0.0:5000
```

Or deploy to a cloud service like Heroku, Google Cloud Run, or AWS Lambda.

## Security Considerations

- This service handles sensitive API keys - make sure to secure your .env file
- Consider adding authentication to protect your backend API in production
- For cross-origin requests, adjust CORS settings in app.py as needed 