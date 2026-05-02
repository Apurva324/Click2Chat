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

  console.log("[RAG] Page HTML length:", pageHtml.length);
  console.log("[RAG] Has captionTracks:", pageHtml.includes("captionTracks"));
  console.log("[RAG] Has ytInitialPlayerResponse:", pageHtml.includes("ytInitialPlayerResponse"));

  const match = pageHtml.match(/"captionTracks":(\[.*?\])/);
  if (!match) throw new Error("No caption tracks found");

  // 👇 ADD FROM HERE
  console.log("[RAG] captionTracks raw:", match[1].substring(0, 200));

  const tracks = JSON.parse(match[1]);
  console.log("[RAG] Tracks count:", tracks.length);
  console.log("[RAG] First track:", JSON.stringify(tracks[0]).substring(0, 200));

  const track = tracks.find(t => t.languageCode === "en") ||
                tracks.find(t => t.languageCode?.startsWith("en")) ||
                tracks[0];

  console.log("[RAG] Selected track languageCode:", track?.languageCode);
  console.log("[RAG] baseUrl exists:", !!track?.baseUrl);
  // 👆 ADD UNTIL HERE

  if (!track?.baseUrl) throw new Error("No usable caption track");

  const xmlRes = await fetch(track.baseUrl);
  const xmlText = await xmlRes.text();

  const entries = [];
  const regex = /<text start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xmlText)) !== null) {
    entries.push({
      start: parseFloat(m[1]),
      text: m[2]
        .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/<[^>]*>/g, "")
    });
  }
  return entries;
}