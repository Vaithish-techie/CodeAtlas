/**
 * services/gemini-explainer.js
 *
 * Enriches the top-5 highest-severity scan issues with a one-sentence
 * Gemini explanation stored in the `bobSummary` field.
 *
 * The genAI client is injected by the caller (server.js already owns it
 * under the `genAI` variable) - we never construct a new one here.
 *
 * Exports: enrichWithGemini(issues, genAI) -> Promise<void>
 *   Mutates the `bobSummary` field on the top-5 issues in-place.
 *   Never throws - any per-issue Gemini failure leaves bobSummary as null.
 */

// Severity order for sorting: high > medium > low > anything else
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Returns a numeric rank for a severity string (lower = more severe).
 *
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
  const rank = SEVERITY_RANK[severity];
  return rank !== undefined ? rank : 99;
}

/**
 * Build the single-sentence prompt for one issue.
 *
 * @param {Object} issue
 * @returns {string}
 */
function buildPrompt(issue) {
  return (
    "You are a senior software engineer. " +
    "In exactly 1 sentence, explain why this code issue is a real risk " +
    "and what the developer should do about it. " +
    "Issue type: " +
    issue.type +
    ", " +
    "File: " +
    issue.filePath +
    ", " +
    "Description: " +
    issue.description +
    ". " +
    "Respond with just the sentence. No bullet points. No preamble."
  );
}

/**
 * Call Gemini for a single issue and return the explanation string.
 * Returns null on any error so the caller can handle it gracefully.
 *
 * @param {Object} issue  - The issue object
 * @param {Object} genAI  - GoogleGenerativeAI client instance from server.js
 * @returns {Promise<string|null>}
 */
async function callGeminiForIssue(issue, genAI) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(buildPrompt(issue));
    const text = result.response.text().trim();
    return text || null;
  } catch (err) {
    console.warn(
      "[Gemini] Failed to enrich issue (" +
        issue.type +
        " in " +
        issue.filePath +
        "): " +
        err.message,
    );
    return null;
  }
}

/**
 * Helper function to introduce a delay (for rate limiting).
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Enrich the top-5 most severe issues with a one-sentence Gemini explanation.
 *
 * Mutates `bobSummary` on each of the top-5 issues in-place.
 * Issues beyond the top 5 are left untouched (bobSummary stays null).
 * Never throws.
 *
 * @param {Array}  issues - Full array of issue objects from the scanners
 * @param {Object} genAI  - GoogleGenerativeAI client instance
 * @returns {Promise<void>}
 */
async function enrichWithGemini(issues, genAI) {
  if (!issues || issues.length === 0) return;

  // Sort a shallow copy by severity (high first), then slice the top 5.
  // We sort a copy so the caller's array order is preserved; we only mutate
  // the objects themselves (bobSummary field), not their positions.
  const top5 = issues
    .slice()
    .sort(function (a, b) {
      return severityRank(a.severity) - severityRank(b.severity);
    })
    .slice(0, 5);

  console.log(
    "[Gemini] Enriching " +
      top5.length +
      " issue(s) sequentially to avoid rate limits...",
  );

  // Process issues sequentially with a delay between each API call
  let enriched = 0;
  for (const issue of top5) {
    try {
      const summary = await callGeminiForIssue(issue, genAI);
      issue.bobSummary = summary; // null if Gemini failed for this one
      if (summary !== null) {
        enriched++;
      }
    } catch (err) {
      // Catch any unexpected errors and continue processing
      console.warn("[Gemini] Unexpected error enriching issue: " + err.message);
      issue.bobSummary = null;
    }

    // Wait 1500ms before the next API call to respect rate limits
    await delay(1500);
  }

  console.log(
    "[Gemini] Enrichment complete: " +
      enriched +
      "/" +
      top5.length +
      " succeeded.",
  );
}

module.exports = { enrichWithGemini };
