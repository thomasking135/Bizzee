export const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing GOOGLE_MAPS_API_KEY" }) };
    }

    const { businessType, city, includeWebsiteEmail } = JSON.parse(event.body || "{}");

    if (!businessType || !city) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "businessType and city required" }) };
    }

    const query = `${businessType} in ${city}, New Zealand`;
    const places = await placesTextSearch(API_KEY, query);

    const results = [];

    for (const p of places) {
      const placeId = p.id;
      const name = p.displayName?.text || "";
      const address = p.formattedAddress || "";

      let website = "";
      let email = "";

      if (includeWebsiteEmail && placeId) {
        await sleep(120);
        const details = await placeDetails(API_KEY, placeId);
        website = details.websiteUri || "";

        await sleep(120);
        email = await findEmailFromWebsite(website);
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ query, results })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Server error" })
    };
  }
};

// ---------------- HELPERS ----------------

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
  if (!resp.ok) throw new Error(text);
  return JSON.parse(text).places || [];
}

async function placeDetails(apiKey, placeId) {
  const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "websiteUri"
    }
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(text);
  return JSON.parse(text);
}

// Only checks BUSINESS WEBSITE (not Google)
async function findEmailFromWebsite(url) {
  if (!url || !url.startsWith("http")) return "";

  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Pathfinder/1.0" } });
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
