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

function buildSidebar() {
  // Remove existing sidebar if any
  document.getElementById("rag-sidebar")?.remove();
  document.getElementById("rag-toggle-btn")?.remove();

  // Toggle button (always visible)
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "rag-toggle-btn";
  toggleBtn.textContent = "🤖";
  toggleBtn.title = "Toggle RAG Assistant";
  document.body.appendChild(toggleBtn);

  // Sidebar
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

  // Toggle show/hide
  toggleBtn.onclick = () => sidebar.classList.toggle("hidden");
  document.getElementById("rag-close").onclick = () => sidebar.classList.add("hidden");

  // Send on Enter key
  document.getElementById("rag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendQuestion();
  });

  document.getElementById("rag-send").onclick = sendQuestion;
}

async function ingestVideo(videoId) {
  const status = document.getElementById("rag-status");
  status.textContent = "Fetching transcript...";

  try {
    const res = await fetch(`${API_BASE}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });

    const data = await res.json();

    if (data.status === "ingested") {
      status.textContent = `Ready! (${data.chunks} chunks loaded)`;
    } else if (data.status === "already_ingested" || data.status === "loaded_from_disk") {
      status.textContent = "Ready! (loaded from cache)";
    }

    // Enable input
    document.getElementById("rag-input").disabled = false;
    document.getElementById("rag-send").disabled = false;
    document.getElementById("rag-input").focus();

  } catch (err) {
    status.textContent = "Could not reach server. Check Railway deployment.";
  }
}

async function sendQuestion() {
  const input = document.getElementById("rag-input");
  const sendBtn = document.getElementById("rag-send");
  const chat = document.getElementById("rag-chat");
  const question = input.value.trim();

  if (!question) return;

  // Show user message
  chat.innerHTML += `<div class="user-msg">${question}</div>`;
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;

  // Show loading dots
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

    // Build timestamp links
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

// Watch for YouTube SPA navigation (video changes without page reload)
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