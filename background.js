chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_TRANSCRIPT") {
    fetchTranscript(msg.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
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

  const xmlRes = await fetch(track.baseUrl);
  const xmlText = await xmlRes.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const texts = doc.querySelectorAll("text");

  return Array.from(texts).map(el => ({
    text: el.textContent
      .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    start: parseFloat(el.getAttribute("start") || "0")
  }));
}