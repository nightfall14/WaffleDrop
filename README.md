# WaffleDrop
Browser-based peer-to-peer file sharing app built with FastAPI (signaling server) and WebRTC (data transfer). Files are never stored on the server — the FastAPI backend only brokers the WebRTC handshake, then gets out of the way. All data flows directly browser-to-browser, encrypted with DTLS 1.3.
