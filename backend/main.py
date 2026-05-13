"""
WaffleDrop Signaling Server
FastAPI + WebSocket-based WebRTC signaling.
Handles room creation, peer discovery, and SDP/ICE relay.
"""

import json
import uuid
import logging
import asyncio
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Resolve frontend path relative to this file's parent (project root)
BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("waffledrop")

app = FastAPI(title="WaffleDrop Signaling Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Data models ─────────────────────────────────────────────────────────────

class Room:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.created_at = datetime.utcnow()
        self.sender: Optional[WebSocket] = None
        self.receiver: Optional[WebSocket] = None
        self.sender_id: Optional[str] = None
        self.receiver_id: Optional[str] = None
        self.file_meta: Optional[dict] = None  # stored for receiver to see before connecting
        self.closed = False

    def is_expired(self) -> bool:
        return datetime.utcnow() - self.created_at > timedelta(hours=2)

    def peer_count(self) -> int:
        return sum(1 for ws in [self.sender, self.receiver] if ws is not None)


# ─── Room Registry ────────────────────────────────────────────────────────────

rooms: Dict[str, Room] = {}


def cleanup_rooms():
    expired = [rid for rid, r in rooms.items() if r.is_expired() or r.closed]
    for rid in expired:
        del rooms[rid]
    if expired:
        logger.info(f"Cleaned up {len(expired)} rooms")


# ─── REST endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    cleanup_rooms()
    return {
        "status": "ok",
        "active_rooms": len(rooms),
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/api/room")
async def create_room():
    """Sender calls this to get a room ID before connecting via WebSocket."""
    cleanup_rooms()
    room_id = uuid.uuid4().hex[:8].upper()
    # Ensure unique
    while room_id in rooms:
        room_id = uuid.uuid4().hex[:8].upper()
    rooms[room_id] = Room(room_id)
    logger.info(f"Room created: {room_id}")
    return {"room_id": room_id}


@app.get("/api/room/{room_id}")
async def get_room_info(room_id: str):
    room_id = room_id.upper()
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    room = rooms[room_id]
    if room.is_expired():
        del rooms[room_id]
        raise HTTPException(status_code=410, detail="Room expired")
    return {
        "room_id": room_id,
        "has_sender": room.sender is not None,
        "has_receiver": room.receiver is not None,
        "file_meta": room.file_meta,
    }


@app.get("/api/stats")
async def stats():
    return {
        "rooms": len(rooms),
        "active_transfers": sum(1 for r in rooms.values() if r.sender and r.receiver),
        "waiting": sum(1 for r in rooms.values() if r.sender and not r.receiver),
    }


# ─── WebSocket signaling ──────────────────────────────────────────────────────

@app.websocket("/ws/{room_id}/{role}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, role: str):
    """
    role: 'sender' | 'receiver'
    Relays WebRTC SDP offers/answers and ICE candidates between peers.
    Also relays file metadata so receiver can show info before download starts.
    """
    room_id = room_id.upper()
    await websocket.accept()
    peer_id = uuid.uuid4().hex[:6]

    if room_id not in rooms:
        await websocket.send_json({"type": "error", "message": "Room not found"})
        await websocket.close(code=4004)
        return

    room = rooms[room_id]

    if role == "sender":
        if room.sender is not None:
            await websocket.send_json({"type": "error", "message": "Room already has a sender"})
            await websocket.close(code=4001)
            return
        room.sender = websocket
        room.sender_id = peer_id
        logger.info(f"Sender joined room {room_id} (peer {peer_id})")
        await websocket.send_json({"type": "joined", "role": "sender", "room_id": room_id, "peer_id": peer_id})

    elif role == "receiver":
        if room.sender is None:
            await websocket.send_json({"type": "error", "message": "No sender in room yet"})
            await websocket.close(code=4002)
            return
        if room.receiver is not None:
            await websocket.send_json({"type": "error", "message": "Room already has a receiver"})
            await websocket.close(code=4003)
            return
        room.receiver = websocket
        room.receiver_id = peer_id
        logger.info(f"Receiver joined room {room_id} (peer {peer_id})")
        await websocket.send_json({"type": "joined", "role": "receiver", "room_id": room_id, "peer_id": peer_id})

        # Notify sender that receiver joined
        if room.sender:
            await room.sender.send_json({"type": "receiver_joined", "peer_id": peer_id})

        # Send cached file meta to receiver if available
        if room.file_meta:
            await websocket.send_json({"type": "file_meta", "meta": room.file_meta})
    else:
        await websocket.send_json({"type": "error", "message": "Invalid role"})
        await websocket.close(code=4000)
        return

    try:
        async for raw in websocket.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")
            logger.debug(f"[{room_id}] {role} → {msg_type}")

            # Cache file metadata so late-joining receivers can see it
            if msg_type == "file_meta" and role == "sender":
                room.file_meta = msg.get("meta")

            # Relay to the other peer
            target = room.receiver if role == "sender" else room.sender
            if target:
                try:
                    await target.send_json(msg)
                except Exception as e:
                    logger.warning(f"Failed to relay to {role}: {e}")

            # Handle room close signal
            if msg_type == "transfer_complete":
                room.closed = True
                logger.info(f"Room {room_id} transfer complete")

    except WebSocketDisconnect:
        logger.info(f"{role} disconnected from room {room_id}")
    except Exception as e:
        logger.error(f"Error in room {room_id} ({role}): {e}")
    finally:
        if role == "sender":
            room.sender = None
            # Notify receiver that sender left
            if room.receiver:
                try:
                    await room.receiver.send_json({"type": "sender_disconnected"})
                except:
                    pass
        elif role == "receiver":
            room.receiver = None
            if room.sender:
                try:
                    await room.sender.send_json({"type": "receiver_disconnected"})
                except:
                    pass

        if room.sender is None and room.receiver is None:
            rooms.pop(room_id, None)
            logger.info(f"Room {room_id} cleaned up")


# ─── Serve frontend ───────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR / "static")), name="static")


@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Don't catch API/WS routes
    if full_path.startswith(("api/", "ws/", "health", "static/")):
        raise HTTPException(status_code=404)
    return FileResponse(str(FRONTEND_DIR / "index.html"))
