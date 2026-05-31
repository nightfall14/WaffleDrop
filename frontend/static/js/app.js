/**
 * WaffleDrop UI Controller
 * Connects WD engine events to DOM state machine
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFiles = [];
let currentRoom = null;
let activeTab = "send";

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initDropZone();
  initEngine();
  checkURLRoom();
  initParticles();
});

function checkURLRoom() {
  const hash = location.hash.replace("#", "");
  if (hash && /^[A-F0-9]{8}$/i.test(hash)) {
    switchTab("receive");
    $("receiveCode").value = hash.toUpperCase();
    showToast("Room code detected — click Connect to receive files!", "info");
  }
}

// ── Engine events ─────────────────────────────────────────────────────────────
function initEngine() {
  WD.on("ws_open", () => {})
    .on("ws_close", () => {
      if (activeTab === "receive")
        setRecvStatus("error", "Disconnected from server");
    })
    .on("ws_error", () => setStatus("error", "Connection error"))
    .on("error", (msg) => {
      showToast(msg, "error");
      setStatus("error", msg);
    })
    .on("joined", (info) => {
      if (info.role === "sender") {
        setStatus("waiting", "Waiting for receiver to connect…");
      }
    })
    .on("receiver_joined", () => {
      setStatus("connecting", "Receiver connected! Establishing P2P…");
    })
    .on("file_meta", (meta) => {
      // receiver sees file info from signaling before WS transfer starts
      showIncomingInfo(meta);
    })
    .on("connection_state", (state) => {
      if (state === "connected") setStatus("connected", "P2P established");
      if (state === "failed")
        setStatus("error", "P2P connection failed — check firewall/NAT");
    })
    .on("channel_open", () => {
      if (activeTab === "send") {
        showSenderTransfer();
      } else {
        setRecvStatus("connected", "Connected — receiving…");
        $("recvProgressSection").classList.remove("hidden");
      }
    })
    .on("status", (state, text) => {
      setStatus(state, text);
      setRecvStatus(state, text);
    })
    .on("progress", ({ pct, sent, total, speed, formatBytes }) => {
      const p = Math.round(pct * 100);
      $("progressFill").style.width = p + "%";
      $("progressPct").textContent = p + "%";
      $("progressLabel").textContent =
        `${formatBytes(sent)} / ${formatBytes(total)}`;
      if (speed > 0) $("speedInfo").textContent = formatBytes(speed) + "/s";
    })
    .on("recv_meta", (meta) => {
      showIncomingInfo(meta);
      $("recvProgressSection").classList.remove("hidden");
    })
    .on("recv_progress", ({ pct, recv, total, formatBytes }) => {
      const p = Math.round(pct * 100);
      $("recvFill").style.width = p + "%";
      $("recvPct").textContent = p + "%";
      $("recvBytes").textContent =
        `${formatBytes(recv)} / ${formatBytes(total)}`;
    })
    .on("send_done", () => {
      showSenderDone();
    })
    .on("recv_done", (fileMeta) => {
      showReceiverDone(fileMeta);
    })
    .on("peer_disconnected", (who) => {
      if (who === "sender") {
        setRecvStatus("error", "Sender disconnected");
        showToast("Sender closed the connection", "error");
      }
    });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  $$(".tab-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0) === (tab === "send"));
  });
  $("sendPanel").classList.toggle("hidden", tab !== "send");
  $("receivePanel").classList.toggle("hidden", tab === "send");
}

// ── Drop Zone ─────────────────────────────────────────────────────────────────
function initDropZone() {
  const dz = $("dropZone");
  const fi = $("fileInput");

  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    fi.value = "";
  });

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    addFiles([...e.dataTransfer.files]);
  });
}

function addFiles(newFiles) {
  newFiles.forEach((f) => {
    if (!selectedFiles.find((x) => x.name === f.name && x.size === f.size))
      selectedFiles.push(f);
  });
  renderFileList();
}

function removeFile(i) {
  selectedFiles.splice(i, 1);
  renderFileList();
}

function renderFileList() {
  const list = $("fileList");
  const btn = $("generateBtn");
  const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);

  if (selectedFiles.length === 0) {
    list.classList.add("hidden");
    btn.disabled = true;
    $("fileCount").textContent = "";
    return;
  }

  list.classList.remove("hidden");
  $("fileCount").textContent =
    `${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""} · ${WD.formatBytes(totalSize)}`;

  list.innerHTML = selectedFiles
    .map(
      (f, i) => `
    <div class="file-item" style="animation-delay:${i * 0.05}s">
      <div class="file-icon">${WD.fileEmoji(f.name)}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(f.name)}</div>
        <div class="file-size">${WD.formatBytes(f.size)}</div>
      </div>
      <button class="file-remove" onclick="removeFile(${i})" title="Remove">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `,
    )
    .join("");
  btn.disabled = false;
}

// ── Sender flow ───────────────────────────────────────────────────────────────
async function startSharing() {
  if (selectedFiles.length === 0) return;
  const btn = $("generateBtn");
  btn.disabled = true;
  btn.textContent = "Creating room…";

  try {
    currentRoom = await WD.createRoom();
    WD.connectAsSender(currentRoom, selectedFiles);

    // Show share UI
    const shareUrl = `${location.origin}${location.pathname}#${currentRoom}`;
    $("shareCode").textContent = currentRoom;
    $("shareLink").value = shareUrl;
    $("shareSection").classList.remove("hidden");
    $("statusSection").classList.remove("hidden");
    btn.textContent = "Waiting…";
    location.hash = currentRoom;
    generateQR(shareUrl);
  } catch (e) {
    showToast("Could not reach signaling server: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = "Generate Link";
  }
}

function showSenderTransfer() {
  $("transferSection").classList.remove("hidden");
}

function showSenderDone() {
  $("transferSection").classList.add("hidden");
  $("senderDone").classList.remove("hidden");
  $("statusDot").className = "status-dot done";
  $("statusText").textContent = "All files transferred successfully!";
  setTimeout(() => {
    generateBtn.textContent = "Send more files";
    generateBtn.disabled = false;
  }, 2000);
}

function resetSender() {
  WD.disconnect();
  selectedFiles = [];
  currentRoom = null;
  location.hash = "";

  renderFileList();
  $("shareSection").classList.add("hidden");
  $("statusSection").classList.add("hidden");
  $("transferSection").classList.add("hidden");
  $("senderDone").classList.add("hidden");
  $("generateBtn").disabled = true;
  $("generateBtn").textContent = "Generate Link";
  $("progressFill").style.width = "0";
  $("dropZone").scrollIntoView({ behavior: "smooth" });
}

// ── Receiver flow ─────────────────────────────────────────────────────────────
async function connectToSender() {
  let code = $("receiveCode").value.trim().toUpperCase();
  // strip if full URL pasted
  const hashMatch = code.match(/[A-F0-9]{8}/i);
  if (!hashMatch) {
    showToast("Invalid room code — expected 8 character code", "error");
    return;
  }
  code = hashMatch[0].toUpperCase();

  const btn = $("connectBtn");
  btn.disabled = true;
  btn.textContent = "Connecting…";

  try {
    const info = await WD.getRoomInfo(code);
    if (!info) {
      showToast("Room not found or expired", "error");
      btn.disabled = false;
      btn.textContent = "Connect & Download";
      return;
    }
    if (!info.has_sender) {
      showToast("Sender is not online — ask them to share again", "error");
      btn.disabled = false;
      btn.textContent = "Connect & Download";
      return;
    }
    $("receiverInput").classList.add("hidden");
    $("incomingSection").classList.remove("hidden");

    if (info.file_meta) showIncomingInfo(info.file_meta);

    setRecvStatus("connecting", "Joining room…");
    WD.connectAsReceiver(code);
  } catch (e) {
    showToast("Failed: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = "Connect & Download";
  }
}

function showIncomingInfo(meta) {
  if (!meta || !meta.files) return;
  const files = meta.files;
  const totalSize = meta.total || files.reduce((s, f) => s + f.size, 0);
  $("incomingIcon").textContent =
    files.length === 1 ? WD.fileEmoji(files[0].name) : "📦";
  $("incomingTitle").textContent =
    files.length === 1 ? files[0].name : `${files.length} files`;
  $("incomingMeta").textContent =
    WD.formatBytes(totalSize) +
    (files.length > 1 ? ` — ${files.map((f) => f.name).join(", ")}` : "");
}

function showReceiverDone(fileMeta) {
  $("incomingSection").classList.add("hidden");
  $("recvProgressSection").classList.add("hidden");
  $("receiverDone").classList.remove("hidden");
  const names = fileMeta.map((f) => f.name).join(", ");
  $("receiverDoneSub").textContent =
    `${fileMeta.length} file(s) saved to your Downloads`;
  setRecvStatus("done", "Transfer complete!");
  showToast(`${fileMeta.length} file(s) downloaded successfully`, "success");
}

function resetReceiver() {
  WD.disconnect();
  $("receiverInput").classList.remove("hidden");
  $("incomingSection").classList.add("hidden");
  $("recvProgressSection").classList.add("hidden");
  $("receiverDone").classList.add("hidden");
  $("receiveCode").value = "";
  $("connectBtn").disabled = false;
  $("connectBtn").textContent = "Connect & Download";
  $("recvFill").style.width = "0";
  location.hash = "";
}

// ── Status helpers ─────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot = $("statusDot");
  if (dot) {
    dot.className = "status-dot " + state;
  }
  const el = $("statusText");
  if (el) el.textContent = text;
}

function setRecvStatus(state, text) {
  const dot = $("recvStatusDot");
  if (dot) dot.className = "status-dot " + state;
  const el = $("recvStatusText");
  if (el) el.textContent = text;
}

// ── Copy & QR ─────────────────────────────────────────────────────────────────
function copyLink() {
  const url = $("shareLink").value;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $("copyBtn");
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    showToast("Link copied to clipboard", "success");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 2500);
  });
}

function copyCode() {
  const code = $("shareCode").textContent;
  navigator.clipboard
    .writeText(code)
    .then(() => showToast(`Code ${code} copied!`, "success"));
}

function generateQR(url) {
  const canvas = $("qrCanvas");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Rounded bg
    ctx.fillStyle = "#161616";
    ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
    ctx.fill();
    ctx.drawImage(img, 4, 4, canvas.width - 8, canvas.height - 8);
  };
  img.onerror = () => fallbackQR(canvas, url);
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(url)}&bgcolor=161616&color=f5a623&margin=4&format=png`;
}

function fallbackQR(canvas, text) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#161616";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f5a623";
  const seed = text.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const g = 10,
    cell = canvas.width / g;
  for (let r = 0; r < g; r++)
    for (let c = 0; c < g; c++)
      if ((seed * (r + 1) * (c + 1) * 7) % 3 !== 0)
        ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg, type = "info") {
  const container = $("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === "success" ? "✓" : type === "error" ? "✕" : "ℹ"}</span>
    <span>${escHtml(msg)}</span>
  `;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Particles ─────────────────────────────────────────────────────────────────
function initParticles() {
  const canvas = $("bgCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W,
    H,
    dots = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < 40; i++) {
    dots.push({
      x: Math.random() * 2000,
      y: Math.random() * 1200,
      r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      a: Math.random() * 0.4 + 0.1,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    dots.forEach((d) => {
      d.x = (d.x + d.vx + W) % W;
      d.y = (d.y + d.vy + H) % H;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(245,166,35,${d.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
