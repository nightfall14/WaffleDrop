/**
 * WaffleDrop WebRTC Engine
 * Handles: signaling via FastAPI WS, ICE negotiation, chunked file transfer
 */

const WD = (() => {
  // ── Config ──────────────────────────────────────────────────────────────────
  const CHUNK_SIZE = 64 * 1024; // 64 KB
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  let ws = null;
  let pc = null;      // RTCPeerConnection
  let dc = null;      // RTCDataChannel
  let role = null;    // 'sender' | 'receiver'
  let roomId = null;
  let files = [];

  // Transfer tracking
  let totalBytes = 0, sentBytes = 0, recvBytes = 0, recvTotal = 0;
  let transferStart = 0;
  let recvBuffers = {};
  let recvFileMeta = [];
  let currentFileIdx = 0;
  let lastSpeedCalc = 0, lastSpeedBytes = 0;

  // Callbacks
  const on = {};

  function emit(event, ...args) {
    if (on[event]) on[event](...args);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function wsUrl(path) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${path}`;
  }

  function apiUrl(path) {
    return path;
  }

  function formatBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  }

  function fileEmoji(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    const m = { pdf:"📄",doc:"📝",docx:"📝",txt:"📃",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",
      webp:"🖼",svg:"🎨",mp4:"🎬",mov:"🎬",mkv:"🎬",mp3:"🎵",wav:"🎵",flac:"🎵",
      zip:"📦",rar:"📦","7z":"📦",gz:"📦",xls:"📊",xlsx:"📊",csv:"📊",ppt:"📑",
      pptx:"📑",js:"⚙️",ts:"⚙️",py:"🐍",html:"🌐",css:"🎨",exe:"💾",dmg:"💿" };
    return m[ext] || "📁";
  }

  // ── Signaling WebSocket ──────────────────────────────────────────────────────
  function connectWS(rid, r) {
    roomId = rid;
    role = r;
    ws = new WebSocket(wsUrl(`/ws/${rid}/${r}`));

    ws.onopen = () => emit("ws_open");
    ws.onclose = (e) => emit("ws_close", e);
    ws.onerror = (e) => emit("ws_error", e);

    ws.onmessage = async ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      await handleSignal(msg);
    };
  }

  function sendSignal(msg) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(msg));
  }

  // ── Signaling Logic ─────────────────────────────────────────────────────────
  async function handleSignal(msg) {
    switch (msg.type) {
      case "joined":
        emit("joined", msg);
        if (role === "sender") {
          // Send file metadata so receiver can see it immediately
          if (files.length > 0) {
            sendSignal({ type: "file_meta", meta: buildMeta() });
          }
        }
        break;

      case "receiver_joined":
        emit("receiver_joined");
        await initiatePeerConnection();
        break;

      case "file_meta":
        emit("file_meta", msg.meta);
        break;

      case "offer":
        await handleOffer(msg.sdp);
        break;

      case "answer":
        if (pc) await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        break;

      case "ice":
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch {}
        }
        break;

      case "sender_disconnected":
        emit("peer_disconnected", "sender");
        break;

      case "receiver_disconnected":
        emit("peer_disconnected", "receiver");
        break;

      case "error":
        emit("error", msg.message);
        break;
    }
  }

  // ── WebRTC ───────────────────────────────────────────────────────────────────
  function createPC() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ type: "ice", candidate });
    };

    pc.onconnectionstatechange = () => {
      emit("connection_state", pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      emit("ice_state", pc.iceConnectionState);
    };

    return pc;
  }

  // SENDER: create offer
  async function initiatePeerConnection() {
    createPC();
    dc = pc.createDataChannel("filetransfer", { ordered: true });
    setupDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: offer.sdp });
    emit("status", "connecting", "Offer sent — establishing connection…");
  }

  // RECEIVER: handle offer, create answer
  async function handleOffer(sdp) {
    createPC();

    pc.ondatachannel = ({ channel }) => {
      dc = channel;
      setupDataChannel(dc);
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type: "answer", sdp: answer.sdp });
    emit("status", "connecting", "Connecting…");
  }

  // ── Data Channel ─────────────────────────────────────────────────────────────
  function setupDataChannel(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;

    channel.onopen = () => {
      emit("channel_open");
      if (role === "sender") {
        emit("status", "connected", "Connected — starting transfer…");
        setTimeout(() => sendFiles(), 100);
      } else {
        emit("status", "connected", "Connected! Waiting for files…");
      }
    };

    channel.onclose = () => emit("channel_close");
    channel.onerror = (e) => emit("error", "Data channel error: " + e.message);
    channel.onmessage = ({ data }) => handleData(data);
  }

  // ── File Sending ─────────────────────────────────────────────────────────────
  function buildMeta() {
    return {
      files: files.map(f => ({ name: f.name, size: f.size, type: f.type || "application/octet-stream" })),
      total: files.reduce((s, f) => s + f.size, 0),
    };
  }

  async function sendFiles() {
    const meta = buildMeta();
    totalBytes = meta.total;
    sentBytes = 0;
    transferStart = Date.now();

    sendMsg({ type: "meta", ...meta });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      sendMsg({ type: "file_start", index: i, name: file.name, size: file.size });
      emit("status", "connected", `Sending: ${file.name}`);

      let offset = 0;
      while (offset < file.size) {
        // Respect buffer backpressure
        if (dc.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise(r => { dc.onbufferedamountlow = r; });
        }
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const buf = await slice.arrayBuffer();
        dc.send(buf);
        offset += buf.byteLength;
        sentBytes += buf.byteLength;
        updateSendProgress();
        await tick();
      }

      sendMsg({ type: "file_end", index: i });
    }

    sendMsg({ type: "transfer_done" });
    emit("send_done");
  }

  function sendMsg(obj) {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
  }

  function updateSendProgress() {
    const pct = totalBytes > 0 ? (sentBytes / totalBytes) : 0;
    const elapsed = (Date.now() - transferStart) / 1000;
    let speed = 0;
    if (Date.now() - lastSpeedCalc > 500) {
      speed = (sentBytes - lastSpeedBytes) / ((Date.now() - lastSpeedCalc) / 1000);
      lastSpeedCalc = Date.now();
      lastSpeedBytes = sentBytes;
    }
    emit("progress", { pct, sent: sentBytes, total: totalBytes, speed, formatBytes });
  }

  function tick() { return new Promise(r => setTimeout(r, 0)); }

  // ── File Receiving ────────────────────────────────────────────────────────────
  function handleData(data) {
    if (data instanceof ArrayBuffer) {
      const idx = currentFileIdx;
      if (!recvBuffers[idx]) recvBuffers[idx] = [];
      recvBuffers[idx].push(data);
      recvBytes += data.byteLength;
      const pct = recvTotal > 0 ? recvBytes / recvTotal : 0;
      emit("recv_progress", { pct, recv: recvBytes, total: recvTotal, formatBytes });
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case "meta":
        recvFileMeta = msg.files;
        recvTotal = msg.total;
        recvBytes = 0;
        recvBuffers = {};
        transferStart = Date.now();
        emit("recv_meta", msg);
        break;

      case "file_start":
        currentFileIdx = msg.index;
        recvBuffers[msg.index] = [];
        emit("status", "connected", `Receiving: ${msg.name}`);
        break;

      case "file_end": {
        const fi = msg.index;
        const meta = recvFileMeta[fi];
        const blob = new Blob(recvBuffers[fi], { type: meta.type || "application/octet-stream" });
        triggerDownload(blob, meta.name);
        delete recvBuffers[fi];
        break;
      }

      case "transfer_done":
        emit("recv_done", recvFileMeta);
        sendSignal({ type: "transfer_complete" });
        break;
    }
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    on(event, cb) { on[event] = cb; return this; },

    async createRoom() {
      const res = await fetch(apiUrl("/api/room"), { method: "POST" });
      const data = await res.json();
      return data.room_id;
    },

    async getRoomInfo(rid) {
      const res = await fetch(apiUrl(`/api/room/${rid}`));
      if (!res.ok) return null;
      return res.json();
    },

    connectAsSender(rid, fileList) {
      files = [...fileList];
      connectWS(rid, "sender");
    },

    connectAsReceiver(rid) {
      connectWS(rid, "receiver");
    },

    disconnect() {
      try { dc && dc.close(); } catch {}
      try { pc && pc.close(); } catch {}
      try { ws && ws.close(); } catch {}
      dc = null; pc = null; ws = null;
    },

    formatBytes,
    fileEmoji,
  };
})();
