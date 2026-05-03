chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_TRANSCRIPT") {
    fetchTranscript(msg.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchTranscript(videoId) {
  const urls = [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en-US&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
  ];

  for (const url of urls) {
    try {
      console.log("[RAG] Trying:", url);
      const res = await fetch(url, {
        credentials: "include",  // send YouTube session cookies
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });

      const text = await res.text();
      console.log("[RAG] Response length:", text.length, "| Sample:", text.substring(0, 200));

      if (!text || text.trim().length === 0) {
        console.warn("[RAG] Empty response for:", url);
        continue;
      }

      // JSON3 format
      if (url.includes("fmt=json3")) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.warn("[RAG] JSON parse failed:", e.message);
          continue;
        }

        if (!data.events || data.events.length === 0) {
          console.warn("[RAG] No events in json3 response");
          continue;
        }

        const entries = data.events
          .filter(e => e.segs)
          .map(e => ({
            start: e.tStartMs / 1000,
            text: e.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim()
          }))
          .filter(e => e.text && e.text !== " ");

        if (entries.length > 0) {
          console.log("[RAG] Success with json3! Entries:", entries.length);
          return entries;
        }

      } else {
        // XML fallback
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");
        const entries = [...xml.querySelectorAll("text")].map(node => ({
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

        if (entries.length > 0) {
          console.log("[RAG] Success with XML fallback! Entries:", entries.length);
          return entries;
        }
      }

    } catch (e) {
      console.warn("[RAG] Request failed for:", url, e.message);
      continue;
    }
  }

  // Last resort: extract captionTracks from page HTML
  console.log("[RAG] All timedtext URLs failed, trying captionTracks from page HTML...");
  return await fetchFromPageHTML(videoId);
}

async function fetchFromPageHTML(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "include"
  });
  const pageHtml = await pageRes.text();

  const match = pageHtml.match(/"captionTracks":(\[.*?\])/);
  if (!match) throw new Error("No caption tracks found in page HTML");

  const tracks = JSON.parse(match[1]);
  const track = tracks.find(t => t.languageCode === "en") ||
                tracks.find(t => t.languageCode?.startsWith("en")) ||
                tracks[0];

  if (!track?.baseUrl) throw new Error("No usable caption track in page HTML");

  const cleanUrl = track.baseUrl + "&fmt=json3";
  console.log("[RAG] captionTracks URL:", cleanUrl.substring(0, 100));

  const res = await fetch(cleanUrl, { credentials: "include" });
  const text = await res.text();
  console.log("[RAG] captionTracks response length:", text.length);

  if (!text || text.trim().length === 0) {
    throw new Error("No transcript found — this video may not have English captions");
  }

  const data = JSON.parse(text);
  const entries = data.events
    .filter(e => e.segs)
    .map(e => ({
      start: e.tStartMs / 1000,
      text: e.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim()
    }))
    .filter(e => e.text && e.text !== " ");

  if (entries.length === 0) throw new Error("Parsed transcript but got 0 entries");

  console.log("[RAG] Success via captionTracks! Entries:", entries.length);
  return entries;
}