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


async function fetchTranscript(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const pageHtml = await pageRes.text();

    const match = pageHtml.match(/"captionTracks":(\[.*?\])/);
    if (!match) return null;

    const tracks = JSON.parse(match[1]);
    const track = tracks.find(t => t.languageCode === "en") ||
                  tracks.find(t => t.languageCode?.startsWith("en")) ||
                  tracks[0];

    if (!track?.baseUrl) return null;

    const xmlRes = await fetch(track.baseUrl);
    const xmlText = await xmlRes.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "text/xml");
    const texts = doc.querySelectorAll("text");

    const transcript = Array.from(texts).map(el => ({
      text: el.textContent
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
      start: parseFloat(el.getAttribute("start") || "0")
    }));

    return transcript;
  } catch (err) {
    console.error("[RAG] Transcript fetch failed:", err);
    return null;
  }
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

  
  const transcript = await fetchTranscript(videoId);
  if (!transcript || transcript.length === 0) {
    status.textContent = "No transcript available for this video.";
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
  ingestVideo(videoId);
  watchForVideoChange();
}