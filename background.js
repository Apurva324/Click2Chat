chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_TRANSCRIPT") {
    fetchTranscript(msg.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchTranscript(videoId) {
  // Use YouTube's direct timedtext API - much more stable than captionTracks parsing
  const urls = [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en-US&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
  ];

  for (const url of urls) {
    try {
      console.log("[RAG] Trying:", url);
      const res = await fetch(url);
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
          console.warn("[RAG] JSON parse failed for:", url, e.message);
          continue;
        }

        if (!data.events || data.events.length === 0) {
          console.warn("[RAG] No events in json3 response for:", url);
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

        console.warn("[RAG] json3 parsed but 0 valid entries for:", url);

      } else {
        // Plain XML format (last resort fallback)
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

        console.warn("[RAG] XML fallback also returned 0 entries for:", url);
      }

    } catch (e) {
      console.warn("[RAG] Request failed for:", url, e.message);
      continue;
    }
  }

  throw new Error("No transcript found — this video may not have English captions");
}