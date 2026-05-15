// test-gemini.js — run with: node test-gemini.js
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Say hello in one word.",
  });
  console.log(response.text); // should print: Hello
}

test().catch(console.error);
