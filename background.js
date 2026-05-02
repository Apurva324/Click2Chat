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
  const xmlRes = await fetch(cleanUrl);
  console.log("[RAG] Fetching URL:", cleanUrl.substring(0, 100));
  const xmlText = await xmlRes.text();

  console.log("[RAG] XML length:", xmlText.length);
  console.log("[RAG] XML sample:", xmlText.substring(0, 200));

  const entries = [];
  const regex = /<text start="([^"]*)"[^>]*>([^<]*)<\/text>/g;
  let m;
  while ((m = regex.exec(xmlText)) !== null) {
    entries.push({
      start: parseFloat(m[1]),
      text: m[2]
        .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    });
  }

  console.log("[RAG] Entries parsed:", entries.length);

  if (entries.length === 0) throw new Error("XML parsed but 0 entries found");

  return entries;
}