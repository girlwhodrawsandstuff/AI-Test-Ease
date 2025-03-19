from openai import AzureOpenAI
import os
from dotenv import load_dotenv

def test_azure_openai():
    # Load environment variables from .env file
    load_dotenv()
    
    # Print configured values
    print("Azure OpenAI Configuration:")
    print(f"API Version: {os.getenv('AZURE_OPENAI_API_VERSION')}")
    print(f"Endpoint: {os.getenv('AZURE_OPENAI_ENDPOINT')}")
    print(f"Deployment: {os.getenv('AZURE_OPENAI_DEPLOYMENT')}")
    print(f"API Key: {os.getenv('AZURE_OPENAI_API_KEY')[:5]}...{os.getenv('AZURE_OPENAI_API_KEY')[-5:]}")
    
    # Initialize the client
    client = AzureOpenAI(
        api_key=os.getenv("AZURE_OPENAI_API_KEY"),
        api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
        azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT")
    )
    
    print("\nTesting Azure OpenAI API...")
    try:
        # Make a simple completion request
        response = client.chat.completions.create(
            model=os.getenv("AZURE_OPENAI_DEPLOYMENT"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello, are you working?"}
            ],
            temperature=0.7,
            max_tokens=50
        )
        
        # Print the response
        print("\nAPI call successful!")
        print(f"Response: {response.choices[0].message.content}")
        return True
    except Exception as e:
        print(f"\nError calling Azure OpenAI API: {str(e)}")
        return False

if __name__ == "__main__":
    test_azure_openai() 