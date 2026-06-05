
# WaffleDrop
Browser-based peer-to-peer file sharing app built with FastAPI (signaling server) and WebRTC (data transfer). Files are never stored on the server — the FastAPI backend only brokers the WebRTC handshake, then gets out of the way. All data flows directly browser-to-browser, encrypted with DTLS 1.3.

# 🧇 WaffleDrop — P2P File Transfer

A production-ready, browser-based peer-to-peer file sharing app built with **FastAPI** (signaling server) and **WebRTC** (data transfer).

Files are **never stored on the server** — the FastAPI backend only brokers the WebRTC handshake, then gets out of the way. All data flows directly browser-to-browser, encrypted with DTLS 1.3.

## Quick Start

### Local development

```bash
# 1. Clone / enter project
git clone https://github.com/nightfall14/WaffleDrop ~/waffledrop
cd waffledrop

# 2. Install Python deps
pip install -r backend/requirements.txt
./cloudflared tunnel --url http://127.0.0.1:8000 --protocol http2
# 3. Run the server
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 4. Open http://localhost:8000
```

If you prefer VS Code Live Server for the frontend, run the backend on `http://localhost:8000` and open the Live Server URL with:

- `?backend=http://localhost:8000`

### Cloudflare tunnel (free)

This is the easiest way to share your local app over HTTPS without paying for a VPS/domain setup.

```bash
# With the server running on http://127.0.0.1:8000

# Download cloudflared (Linux x86_64)
curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared

# Start a quick tunnel (keep this running)
./cloudflared tunnel --url http://localhost:8000 --protocol http2
```

It will print a `https://...trycloudflare.com` URL — open that URL on both devices.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/room` | Create a new room → `{"room_id": "A3F2B8C1"}` |
| `GET`  | `/api/room/{id}` | Get room status, file metadata |
| `GET`  | `/api/stats` | Live stats: rooms, transfers |
| `GET`  | `/health` | Health check |
| `WS`   | `/ws/{id}/sender` | Sender signaling socket |
| `WS`   | `/ws/{id}/receiver` | Receiver signaling socket |

### WebSocket message types

**Client → Server (relayed to peer):**
- `file_meta` — file list metadata (cached for late-joining receivers)
- `offer` — WebRTC SDP offer
- `answer` — WebRTC SDP answer
- `ice` — ICE candidate
- `transfer_complete` — signal to close room

**Server → Client:**
- `joined` — confirms role assignment
- `receiver_joined` — notifies sender
- `sender_disconnected` / `receiver_disconnected`
- `error` — with message

---

## Project Structure

```
TimeVault/
├── backend/
│   ├── main.py              # FastAPI app + signaling server
│   └── requirements.txt
├── frontend/
│   ├── index.html           # SPA entry point
│   └── static/
│       ├── css/style.css    # Design system
│       └── js/
│           ├── engine.js    # WebRTC + WS engine
│           └── app.js       # UI controller
└── README.md
```

---

## Technical Details

- **Signaling**: FastAPI WebSocket, in-memory room registry, auto-cleanup after 2h or disconnect
- **P2P**: RTCPeerConnection with STUN + TURN fallback for strict NAT/firewall networks
- **Transfer**: RTCDataChannel, ordered, 64 KB chunks with backpressure via `bufferedAmountLowThreshold`
- **Encryption**: DTLS 1.3 (built into WebRTC spec, no configuration needed)
- **TURN relay**: Configure `ICE_SERVERS` in `engine.js` if you need to force reliable connectivity (recommended to use your own TURN in production)

### Adding a TURN server

```js
// In frontend/static/js/engine.js, add/replace in ICE_SERVERS:
{
  urls: "turn:your-turn-server.com:3478",
  username: "user",
  credential: "password"
}
```

Free TURN options: Metered.ca, Cloudflare Calls (TURN API), self-hosted coturn.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Server port (uvicorn) |
| `WEB_CONCURRENCY` | `1` | Worker count (keep at 1 for in-memory rooms) |

> ⚠️ Keep workers at 1 (or use Redis for room state if scaling horizontally)

---

## Security Notes

- Rooms auto-expire after 2 hours
- Room IDs are 8-char hex (4 billion combinations)
- No files are ever written to disk on the server
- WebSocket connections are authenticated only by knowing the room ID
- For demos on restrictive networks, you may need TURN relay for WebRTC

---

## License

MIT — use freely, attribution appreciated.
