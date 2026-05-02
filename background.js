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
  console.log("[RAG] Sample:", xmlText.substring(0, 200));

  const data = JSON.parse(xmlText);
  const entries = data.events
    .filter(e => e.segs)
    .map(e => ({
      start: e.tStartMs / 1000,
      text: e.segs.map(s => s.utf8).join("").replace(/\n/g, " ").trim()
    }))
    .filter(e => e.text && e.text !== " ");

  console.log("[RAG] Entries parsed:", entries.length);
  if (entries.length === 0) throw new Error("JSON3 parsed but 0 entries");
  return entries;
}