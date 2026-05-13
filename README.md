
# WaffleDrop
Browser-based peer-to-peer file sharing app built with FastAPI (signaling server) and WebRTC (data transfer). Files are never stored on the server — the FastAPI backend only brokers the WebRTC handshake, then gets out of the way. All data flows directly browser-to-browser, encrypted with DTLS 1.3.

# 🧇 WaffleDrop — P2P File Transfer

A production-ready, browser-based peer-to-peer file sharing app built with **FastAPI** (signaling server) and **WebRTC** (data transfer).

Files are **never stored on the server** — the FastAPI backend only brokers the WebRTC handshake, then gets out of the way. All data flows directly browser-to-browser, encrypted with DTLS 1.3.



## Architecture

```
Sender Browser                  FastAPI Signaling              Receiver Browser
──────────────                  ─────────────────              ────────────────
1. POST /api/room          →    Create room (in-memory)
2. WS  /ws/{id}/sender    →    Register as sender
                                                    ←   3. GET /api/room/{id}
                                                    ←   4. WS /ws/{id}/receiver
                           ←   "receiver_joined"
5. createOffer (SDP)       →    Relay offer         →
                           ←   Relay answer         ←   6. createAnswer (SDP)
7. ICE candidates          ⇄    Relay ICE           ⇄   7. ICE candidates
─────────────────────────────── WebRTC P2P established ──────────────────────
8. RTCDataChannel          ══════════ Direct P2P ══════════   9. Save to disk
   (chunked, any size)             (no server involved)
```



## Quick Start

### Local development

```bash
# 1. Clone / enter project
cd waffledrop

# 2. Install Python deps
pip install -r backend/requirements.txt

# 3. Run the server
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 4. Open http://localhost:8000
```

### Docker (recommended)

```bash
# Build & run
docker compose up --build

# Background
docker compose up -d --build

# Logs
docker compose logs -f

# Stop
docker compose down
```

---

## Deployment

### Option A — Docker on any VPS (DigitalOcean, Linode, Hetzner)

```bash
# On your server
git clone <your-repo> waffledrop
cd waffledrop

# Edit nginx.conf: replace yourdomain.com
# Add SSL certs to ./certs/ (use certbot)
# Uncomment the nginx service in docker-compose.yml

docker compose up -d --build
```

### Option B — Railway / Render / Fly.io

These platforms auto-detect the Dockerfile. Just push and deploy.

**Railway:**
```bash
railway init
railway up
```

**Render:** Connect GitHub repo → set `Dockerfile` as build method → deploy.

**Fly.io:**
```bash
fly launch
fly deploy
```

### Option C — Systemd service (bare metal)

```ini
# /etc/systemd/system/waffledrop.service
[Unit]
Description=WaffleDrop Signaling Server
After=network.target

[Service]
WorkingDirectory=/opt/waffledrop/backend
ExecStart=/usr/local/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
Restart=always
RestartSec=5
User=www-data
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable waffledrop
systemctl start waffledrop
```

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
waffledrop/
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
├── Dockerfile
├── docker-compose.yml
├── nginx.conf               # Production reverse proxy
└── README.md
```

---

## Technical Details

- **Signaling**: FastAPI WebSocket, in-memory room registry, auto-cleanup after 2h or disconnect
- **P2P**: RTCPeerConnection with STUN servers (Google + Cloudflare)
- **Transfer**: RTCDataChannel, ordered, 64 KB chunks with backpressure via `bufferedAmountLowThreshold`
- **Encryption**: DTLS 1.3 (built into WebRTC spec, no configuration needed)
- **No NAT traversal server (TURN)**: Pure STUN is used; for enterprise/strict-NAT environments, add a TURN server to `ICE_SERVERS` in `engine.js`

### Adding a TURN server

```js
// In frontend/static/js/engine.js, add to ICE_SERVERS:
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
- For production, put behind nginx with HTTPS + rate limiting (config included)

---

## License

MIT — use freely, attribution appreciated.
