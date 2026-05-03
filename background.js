chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_TRANSCRIPT") {
    fetchTranscript(msg.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  const pageHtml = await pageRes.text();

  const match = pageHtml.match(/"captionTracks":(\[.*?\])/);
  if (!match) throw new Error("No caption tracks found");

  const tracks = JSON.parse(match[1]);
  const track = tracks.find(t => t.languageCode === "en") ||
                tracks.find(t => t.languageCode?.startsWith("en")) ||
                tracks[0];

  if (!track?.baseUrl) throw new Error("No usable caption track");

  // After JSON.parse, \u0026 is already decoded to & — keeping for safety
  const cleanUrl = track.baseUrl.replace(/\\u0026/g, "&");
  const jsonUrl = cleanUrl + "&fmt=json3";

  const xmlRes = await fetch(jsonUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });

  const xmlText = await xmlRes.text();
  console.log("[RAG] Status:", xmlRes.status);
  console.log("[RAG] Response length:", xmlText.length);
  console.log("[RAG] Sample:", xmlText.substring(0, 300));

  // Guard against empty response from YouTube
  if (!xmlText || xmlText.trim().length === 0) {
    throw new Error("YouTube returned empty caption response");
  }

  // Try json3 format first, fall back to XML if it fails
  let entries = [];

  try {
    const data = JSON.parse(xmlText);
    entries = data.events
      .filter(e => e.segs)
      .map(e => ({
        start: e.tStartMs / 1000,
        text: e.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim()
      }))
      .filter(e => e.text && e.text !== " ");

    console.log("[RAG] json3 entries parsed:", entries.length);

    if (entries.length === 0) throw new Error("json3 parsed but 0 entries");

  } catch (e) {
    // json3 failed — fall back to plain XML format
    console.warn("[RAG] json3 failed, falling back to XML. Reason:", e.message);

    const fallbackRes = await fetch(cleanUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const fallbackText = await fallbackRes.text();
    console.log("[RAG] XML fallback response length:", fallbackText.length);
    console.log("[RAG] XML sample:", fallbackText.substring(0, 300));

    if (!fallbackText || fallbackText.trim().length === 0) {
      throw new Error("YouTube returned empty response for both json3 and XML formats");
    }

    const parser = new DOMParser();
    const xml = parser.parseFromString(fallbackText, "text/xml");
    entries = [...xml.querySelectorAll("text")].map(node => ({
      start: parseFloat(node.getAttribute("start")),
      text: node.textContent
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, " ")
        .trim()
    })).filter(e => e.text);

    console.log("[RAG] XML entries parsed:", entries.length);

    if (entries.length === 0) throw new Error("Both json3 and XML parsing returned 0 entries");
  }

  return entries;
}