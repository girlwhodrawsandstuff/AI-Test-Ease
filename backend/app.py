from flask import Flask, request, jsonify
from flask_cors import CORS
import asyncio
import os
from dotenv import load_dotenv
import logging
import json

# Import Azure OpenAI client libraries
from openai import AsyncAzureOpenAI

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables for OpenAI client
openai_client = None

def initialize_client():
    """Initialize the Azure OpenAI client"""
    global openai_client
    load_dotenv()

    if openai_client is None:
        logger.info("Initializing Azure OpenAI client")
        openai_client = AsyncAzureOpenAI(
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
            azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            azure_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT")
        )

async def process_interactions(interactions):
    """Process user interactions with Azure OpenAI"""
    try:
        # Prepare the data for the AI
        formatted_interactions = []
        for interaction in interactions:
            description = f"{interaction['type']} on {interaction['element']['tagName']}"
            if interaction['element'].get('innerText'):
                description += f" with text \"{interaction['element']['innerText'][:30]}\""
            elif interaction['element'].get('id'):
                description += f" with id \"{interaction['element']['id']}\""
            elif interaction['element'].get('className'):
                description += f" with class \"{interaction['element']['className']}\""
            
            formatted_interactions.append({
                "type": interaction['type'],
                "element": {
                    "tag": interaction['element'].get('tagName'),
                    "id": interaction['element'].get('id'),
                    "class": interaction['element'].get('className'),
                    "text": interaction['element'].get('innerText'),
                    "placeholder": interaction['element'].get('placeholder')
                },
                "url": interaction['url'],
                "description": description
            })

        # Create system prompt
        system_prompt = """
        You are an experienced test automation specialist. Your job is to analyze user interactions 
        and create meaningful test descriptions, expected results, and test case names.
        """

        # Create user prompt with the interactions
        user_prompt = f"""
        I have recorded the following user interactions on a website. Please analyze them and:
        1. Generate a meaningful name for this end-to-end test
        2. For each interaction, provide:
           - A clear action description
           - An expected result
           - A priority (P1, P2, or P3 based on importance)

        Here are the interactions:
        {json.dumps(formatted_interactions, indent=2)}

        Return your response in JSON format as follows:
        {{
          "testCaseName": "Name of the E2E test",
          "interactions": [
            {{
              "actionDescription": "Detailed description of action 1",
              "expectedResult": "Expected result of action 1",
              "priority": "P1"
            }},
            ...
          ]
        }}
        """

        # Call Azure OpenAI API
        response = await openai_client.chat.completions.create(
            model=os.getenv("AZURE_OPENAI_DEPLOYMENT"),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.3
        )

        logger.info("Successfully received response from Azure OpenAI")
        return response.choices[0].message.content
    
    except Exception as e:
        logger.error(f"Error processing interactions: {str(e)}")
        raise

@app.route('/', methods=['GET'])
def root():
    """Root endpoint that returns API information"""
    return jsonify({
        "name": "AI Test Ease Backend",
        "status": "running",
        "endpoints": {
            "/": "This documentation (GET)",
            "/api/analyze": "Analyze user interactions (POST)"
        },
        "version": "1.0.0"
    })

@app.route('/api/analyze', methods=['POST'])
def analyze_interactions():
    """API endpoint to analyze user interactions"""
    try:
        data = request.json
        interactions = data.get('interactions', [])
        
        if not interactions:
            return jsonify({"error": "No interactions provided"}), 400
        
        # Initialize OpenAI client if needed
        if openai_client is None:
            initialize_client()
        
        # Process interactions
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(process_interactions(interactions))
        loop.close()
        
        return jsonify({"result": result})
    
    except Exception as e:
        logger.error(f"Error in analyze_interactions endpoint: {str(e)}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Initialize the client before starting the server
    initialize_client()
    # Use environment variables for host and port if available
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', 5000))
    # Run the Flask app
    app.run(host=host, port=port, debug=False) 