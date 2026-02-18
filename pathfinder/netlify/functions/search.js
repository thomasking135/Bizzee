export const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    // Helps avoid odd caching while debugging
    "Cache-Control": "no-store"
  };

  // Preflight (CORS)
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // Only allow POST (your browser visiting the function is GET)
  if (event.httpMethod !== "POST") {
    return json(headers, 405, { error: "Method not allowed. Use POST." });
  }

  try {
    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

    // Helpful logging for Netlify Function logs
    console.log("Incoming request:", {
      method: event.httpMethod,
      path: event.path,
      hasBody: !!event.body
    });

    if (!API_KEY) {
      // This is the #1 production issue
      return json(headers, 500, {
        error: "Missing GOOGLE_MAPS_API_KEY",
        hint: "Add GOOGLE_MAPS_API_KEY in Netlify → Site configuration → Environment variables, then redeploy."
      });
    }

    // Parse body safely
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(headers, 400, {
        error: "Invalid JSON body",
        hint: "Ensure request body is valid JSON with businessType and city."
      });
    }

    const { businessType, city, includeWebsiteEmail } = body;

    if (!businessType || !city) {
      return json(headers, 400, {
        error: "businessType and city required",
        example: { businessType: "kitchen designer", city: "Christchurch", includeWebsiteEmail: false }
      });
    }

    const query = `${String(businessType).trim()} in ${String(city).trim()}, New Zealand`;
    console.log("Search query:", query);

    const places = await placesTextSearch(API_KEY, query);

    const results = [];

    for (const p of places) {
      const placeId = p.id;
      const name = p.displayName?.text || "";
      const address = p.formattedAddress || "";

      let website = "";
      let email = "";

      // Email scraping is optional and can be slow/blocky
      if (includeWebsiteEmail && placeId) {
        try {
          await sleep(120);
          const details = await placeDetails(API_KEY, placeId);
          website = details.websiteUri || "";

          if (website) {
            await sleep(120);
            email = await findEmailFromWebsite(website);
          }
        } catch (e) {
          // Don’t fail whole request if one website is blocked
          console.log("Website/email lookup failed:", { placeId, error: e?.message });
        }
      }

      results.push({
        name,
        address,
        website,
        email,
        google_maps_url: placeId
          ? `https://www.google.com/maps/place/?q=place_id:${placeId}`
          : ""
      });
    }

    return json(headers, 200, { query, count: results.length, results });

  } catch (err) {
    console.log("Unhandled error:", err);
    return json(headers, 500, {
      error: err?.message || "Server error",
      hint: "Check Netlify Functions logs for details."
    });
  }
};

// ---------------- HELPERS ----------------

function json(headers, statusCode, obj) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(obj)
  };
}

async function placesTextSearch(apiKey, query) {
  const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress"
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: "NZ",
      languageCode: "en",
      maxResultCount: 20
    })
  });

  const text = await resp.text();

  // If Google returns an error, return a readable message
  if (!resp.ok) {
    throw new Error(`Places Text Search failed (${resp.status}): ${cleanGoogleError(text)}`);
  }

  const data = safeJson(text);
  return data?.places || [];
}

async function placeDetails(apiKey, placeId) {
  const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "websiteUri"
    }
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`Place Details failed (${resp.status}): ${cleanGoogleError(text)}`);
  }

  return safeJson(text) || {};
}

// Only checks BUSINESS WEBSITE (not Google)
async function findEmailFromWebsite(url) {
  if (!url || !url.startsWith("http")) return "";

  try {
    // Some sites block bots; we keep it simple and safe
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const resp = await fetch(url, {
      headers: { "User-Agent": "Pathfinder/1.0" },
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!resp.ok) return "";

    const html = await resp.text();

    const mailto = html.match(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    if (mailto) return mailto[1];

    const plain = html.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    return plain ? plain[0] : "";
  } catch {
    return "";
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function cleanGoogleError(text) {
  // Google APIs often return JSON error bodies; try to extract message
  const data = safeJson(text);
  const msg =
    data?.error?.message ||
    data?.message ||
    (typeof text === "string" ? text : "");
  return String(msg).slice(0, 500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
