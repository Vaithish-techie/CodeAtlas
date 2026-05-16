/**
 * services/groq-explainer.js
 *
 * Enriches the top-5 highest-severity scan issues with a one-sentence
 * Groq (Llama 3 8B) explanation stored in the `bobSummary` field.
 *
 * Uses native Node.js fetch() to call the Groq API endpoint.
 * No external SDK required.
 *
 * Exports: enrichWithGroq(issues) -> Promise<void>
 *   Mutates the `bobSummary` field on the top-5 issues in-place.
 *   Never throws - any per-issue Groq failure leaves bobSummary as null.
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
 * Call Groq API for a single issue and return the explanation string.
 * Returns null on any error so the caller can handle it gracefully.
 *
 * @param {Object} issue - The issue object
 * @returns {Promise<string|null>}
 */
async function callGroqForIssue(issue) {
  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "user",
              content: buildPrompt(issue),
            },
          ],
          temperature: 0.7,
          max_tokens: 150,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn(
      "[Groq] Failed to enrich issue (" +
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
 * Enrich the top-5 most severe issues with a one-sentence Groq explanation.
 *
 * Mutates `bobSummary` on each of the top-5 issues in-place.
 * Issues beyond the top 5 are left untouched (bobSummary stays null).
 * Never throws.
 *
 * @param {Array} issues - Full array of issue objects from the scanners
 * @returns {Promise<void>}
 */
async function enrichWithGroq(issues) {
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
    "[Groq] Enriching " +
      top5.length +
      " issue(s) concurrently with Groq's LPU...",
  );

  // Fire all Groq calls concurrently - Groq's LPU can handle it!
  // Each call is wrapped in its own try/catch so individual failures resolve to null
  const summaries = await Promise.all(
    top5.map(function (issue) {
      return callGroqForIssue(issue);
    }),
  );

  // Write results back onto the original issue objects
  for (let i = 0; i < top5.length; i++) {
    top5[i].bobSummary = summaries[i]; // null if Groq failed for this one
  }

  const enriched = summaries.filter(function (s) {
    return s !== null;
  }).length;
  console.log(
    "[Groq] Enrichment complete: " +
      enriched +
      "/" +
      top5.length +
      " succeeded.",
  );
}

module.exports = { enrichWithGroq };

// Made with Bob
