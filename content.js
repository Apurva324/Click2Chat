let currentVideoId = null;

function getSessionId() {
  let id = localStorage.getItem("rag_session_id");
  if (!id) {
    id = "user_" + Math.random().toString(36).substr(2, 9) + "_" + Date.now();
    localStorage.setItem("rag_session_id", id);
  }
  return id;
}

const SESSION_ID = getSessionId();
const API_BASE = "https://click2chat-production.up.railway.app";

function getVideoId() {
  return new URLSearchParams(window.location.search).get("v");
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Inject a script into the page context to read ytInitialPlayerResponse
function getBaseUrlFromPage() {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data?.type === "RAG_CAPTION_URL") {
        window.removeEventListener("message", handler);
        resolve(event.data.baseUrl || null);
      }
    };
    window.addEventListener("message", handler);

    // Inject script that runs in the REAL page context
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        try {
          const player = window.ytInitialPlayerResponse;
          const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (!tracks || tracks.length === 0) {
            window.postMessage({ type: "RAG_CAPTION_URL", baseUrl: null }, "*");
            return;
          }
          const track = tracks.find(t => t.languageCode === "en") ||
                        tracks.find(t => t.languageCode?.startsWith("en")) ||
                        tracks[0];
          window.postMessage({ type: "RAG_CAPTION_URL", baseUrl: track?.baseUrl || null }, "*");
        } catch(e) {
          window.postMessage({ type: "RAG_CAPTION_URL", baseUrl: null }, "*");
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    // Timeout fallback
    setTimeout(() => resolve(null), 3000);
  });
}

async function fetchTranscript(videoId) {
  console.log("[RAG] Getting baseUrl from ytInitialPlayerResponse...");
  const baseUrl = await getBaseUrlFromPage();

  if (!baseUrl) {
    throw new Error("No English captions found for this video");
  }

  console.log("[RAG] Got baseUrl, fetching captions...");

  // Try json3 first, then plain XML
  const urls = [baseUrl + "&fmt=json3", baseUrl];

  for (const url of urls) {
    try {
      console.log("[RAG] Fetching:", url.substring(0, 80) + "...");
      const res = await fetch(url, { credentials: "include" });
      const text = await res.text();
      console.log("[RAG] Response length:", text.length, "| Sample:", text.substring(0, 150));

      if (!text || text.trim().length === 0) continue;

      if (url.includes("fmt=json3")) {
        const data = JSON.parse(text);
        if (!data.events) continue;

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
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");
        const entries = [...xml.querySelectorAll("text")].map(node => ({
          start: parseFloat(node.getAttribute("start")),
          text: node.textContent
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'").replace(/\n/g, " ").trim()
        })).filter(e => e.text);

        if (entries.length > 0) {
          console.log("[RAG] Success with XML! Entries:", entries.length);
          return entries;
        }
      }
    } catch (e) {
      console.warn("[RAG] Fetch failed:", e.message);
    }
  }

  throw new Error("No transcript found — this video may not have English captions");
}

function buildSidebar() {
  document.getElementById("rag-sidebar")?.remove();
  document.getElementById("rag-toggle-btn")?.remove();

  const toggleBtn = document.createElement("button");
  toggleBtn.id = "rag-toggle-btn";
  toggleBtn.textContent = "🤖";
  toggleBtn.title = "Toggle RAG Assistant";
  document.body.appendChild(toggleBtn);

  const sidebar = document.createElement("div");
  sidebar.id = "rag-sidebar";
  sidebar.innerHTML = `
    <div id="rag-header">
      <span>🎬 RAG Assistant</span>
      <span id="rag-close" style="cursor:pointer;font-size:18px;">✕</span>
    </div>
    <div id="rag-status">Fetching transcript...</div>
    <div id="rag-chat"></div>
    <div id="rag-input-row">
      <input id="rag-input" type="text" placeholder="Ask about this video..." disabled/>
      <button id="rag-send" disabled>➤</button>
    </div>
  `;
  document.body.appendChild(sidebar);

  toggleBtn.onclick = () => sidebar.classList.toggle("hidden");
  document.getElementById("rag-close").onclick = () => sidebar.classList.add("hidden");
  document.getElementById("rag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendQuestion();
  });
  document.getElementById("rag-send").onclick = sendQuestion;
}

async function ingestVideo(videoId) {
  const status = document.getElementById("rag-status");
  status.textContent = "Fetching transcript...";

  let transcript;
  try {
    transcript = await fetchTranscript(videoId);
  } catch (e) {
    console.error("[RAG] Transcript error:", e.message);
    status.textContent = "⚠️ No English captions found for this video. Try another!";
    return;
  }

  if (!transcript || transcript.length === 0) {
    status.textContent = "⚠️ No English captions found for this video. Try another!";
    return;
  }

  status.textContent = "Processing transcript...";

  try {
    const res = await fetch(`${API_BASE}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, transcript }),
    });

    const data = await res.json();

    if (data.status === "ingested") {
      status.textContent = `Ready! (${data.chunks} chunks loaded)`;
    } else if (data.status === "already_ingested" || data.status === "loaded_from_disk") {
      status.textContent = "Ready! (loaded from cache)";
    }

    document.getElementById("rag-input").disabled = false;
    document.getElementById("rag-send").disabled = false;
    document.getElementById("rag-input").focus();

  } catch (err) {
    status.textContent = "Could not reach server. Check Railway deployment.";
    console.error("[RAG] Ingest error:", err);
  }
}

async function sendQuestion() {
  const input = document.getElementById("rag-input");
  const sendBtn = document.getElementById("rag-send");
  const chat = document.getElementById("rag-chat");
  const question = input.value.trim();

  if (!question) return;

  chat.innerHTML += `<div class="user-msg">${question}</div>`;
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;

  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading-dots";
  loadingDiv.innerHTML = "<span></span><span></span><span></span>";
  chat.appendChild(loadingDiv);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await fetch(`${API_BASE}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: currentVideoId,
        question: question,
        session_id: SESSION_ID
      }),
    });

    const data = await res.json();
    loadingDiv.remove();

    let timestampHTML = "";
    if (data.timestamps && data.timestamps.length > 0) {
      const links = data.timestamps
        .map(t => `<a class="timestamp-link" href="${t.url}" target="_blank">▶ ${formatTime(t.seconds)}</a>`)
        .join("");
      timestampHTML = `<div class="timestamp-row">${links}</div>`;
    }

    chat.innerHTML += `
      <div class="bot-msg">
        ${data.answer}
        ${timestampHTML}
      </div>`;

  } catch (err) {
    loadingDiv.remove();
    chat.innerHTML += `<div class="bot-msg" style="color:#ff6b6b;">Error — could not reach server.</div>`;
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
  chat.scrollTop = chat.scrollHeight;
}

function watchForVideoChange() {
  const observer = new MutationObserver(() => {
    const newVideoId = getVideoId();
    if (newVideoId && newVideoId !== currentVideoId) {
      currentVideoId = newVideoId;
      buildSidebar();
      ingestVideo(currentVideoId);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
}

// Init
const videoId = getVideoId();
if (videoId) {
  currentVideoId = videoId;
  buildSidebar();
  ingestVideo(currentVideoId);
  watchForVideoChange();
}