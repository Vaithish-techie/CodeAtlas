/**
 * Test script for Qwen3 Next 80B A3B integration via OpenRouter
 * Run: node test-qwen3.js
 */

require("dotenv").config();
const OpenAI = require("openai");

async function testQwen3Next() {
  console.log("🔍 Testing Qwen3 Next 80B A3B via OpenRouter...\n");

  // Check if API key is set
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("❌ ERROR: OPENROUTER_API_KEY not found in .env file");
    console.log("\n📝 To fix this:");
    console.log("1. Get your API key from: https://openrouter.ai/keys");
    console.log("2. Add it to your .env file:");
    console.log("   OPENROUTER_API_KEY=sk-or-v1-your-actual-key-here");
    process.exit(1);
  }

  if (process.env.OPENROUTER_API_KEY === "your_openrouter_api_key_here") {
    console.error("❌ ERROR: Please replace the placeholder API key with your actual key");
    console.log("\n📝 To fix this:");
    console.log("1. Get your API key from: https://openrouter.ai/keys");
    console.log("2. Replace 'your_openrouter_api_key_here' in .env with your actual key");
    process.exit(1);
  }

  console.log("✅ API key found in .env file");
  console.log(`   Key starts with: ${process.env.OPENROUTER_API_KEY.substring(0, 15)}...`);

  // Initialize OpenRouter client
  let openrouter;
  try {
    openrouter = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/your-repo/codeatlas",
        "X-Title": "CodeAtlas Health Scanner",
      },
    });
    console.log("✅ OpenRouter client initialized successfully");
  } catch (initError) {
    console.error("\n❌ ERROR: Failed to initialize OpenRouter client");
    console.error(`   Message: ${initError.message}`);
    process.exit(1);
  }

  console.log("\n🚀 Sending test request to Qwen3 Next 80B A3B...");

  try {
    const completion = await openrouter.chat.completions.create({
      model: "qwen/qwen3-next-80b-a3b-instruct:free",
      messages: [
        {
          role: "system",
          content: "You are a helpful code analysis assistant. Respond only with valid JSON.",
        },
        {
          role: "user",
          content: `Analyze this simple function and return a JSON object:

function add(a, b) {
  return a + b;
}

Return this exact JSON structure:
{
  "functionName": "add",
  "parameters": ["a", "b"],
  "hasTests": false,
  "recommendation": "Add unit tests for edge cases"
}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const response = completion.choices[0]?.message?.content || "";

    console.log("\n✅ SUCCESS! API is working correctly");
    console.log(`📨 Response from Qwen3 Next 80B:`);
    console.log(response);

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
      console.log("\n✅ Response is valid JSON");
      console.log("Parsed object:", JSON.stringify(parsed, null, 2));
    } catch (parseError) {
      console.log("\n⚠️  Response is not valid JSON, but API call succeeded");
    }

    console.log("\n🎉 Qwen3 Next 80B integration is working!");
    console.log("\n📋 Next steps:");
    console.log("1. Restart your server: npm start");
    console.log("2. Go to http://localhost:3000");
    console.log("3. Analyze a repository");
    console.log("4. Click 'Health Scan Dashboard' to see AI-powered results");
  } catch (error) {
    console.error("\n❌ ERROR: API request failed");
    console.error(`   Message: ${error.message}`);

    if (error.message.includes("401") || error.message.includes("unauthorized")) {
      console.log("\n📝 This looks like an authentication error. Please check:");
      console.log("1. Your API key is correct");
      console.log("2. Your API key hasn't expired");
      console.log("3. You have credits available on OpenRouter");
    } else if (error.message.includes("429") || error.message.includes("rate limit")) {
      console.log("\n📝 Rate limit reached. Please wait a moment and try again.");
    } else {
      console.log("\n📝 Unexpected error. Please check:");
      console.log("1. Your internet connection");
      console.log("2. OpenRouter service status: https://status.openrouter.ai");
    }

    process.exit(1);
  }
}

// Run the test
testQwen3Next();

// Made with Bob
