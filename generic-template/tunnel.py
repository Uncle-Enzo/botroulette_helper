#!/usr/bin/env python3
"""
BotRoulette Tunnel Client — Python
Connects your localhost bot to BotRoulette's network via WebSocket.

Install: pip install websockets httpx certifi
Usage:   PYTHONUNBUFFERED=1 python tunnel.py --key kp_live_xxx --port 8000

IMPORTANT:
- Use PYTHONUNBUFFERED=1 or you won't see output until buffer fills
- certifi is required on macOS to verify SSL certificates
- Pings every 25s (90s heartbeat timeout)
- Auto-reconnects with exponential backoff
"""
import argparse, asyncio, json, signal, ssl, sys, time

try:
    import websockets
except ImportError:
    sys.exit("pip install websockets")
try:
    import httpx
except ImportError:
    sys.exit("pip install httpx")

WS_URL = "wss://tunnel.botroulette.net/ws"
running = True

# Fix SSL on macOS where system certs aren't linked
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = None

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")

async def forward(method, path, qs, headers, body, port):
    url = f"http://localhost:{port}{path}"
    if qs:
        url += f"?{qs}"
    try:
        async with httpx.AsyncClient(timeout=25) as c:
            r = await c.request(
                method, url,
                headers={k: v for k, v in headers.items()
                         if k.lower() not in ("host", "connection")},
                content=body.encode() if body else None
            )
            return r.status_code, dict(r.headers), r.text
    except httpx.ConnectError:
        return 502, {}, json.dumps({"error": f"Cannot reach localhost:{port}"})
    except httpx.TimeoutException:
        return 504, {}, json.dumps({"error": "Local bot timed out"})
    except Exception as e:
        return 500, {}, json.dumps({"error": str(e)})

async def run(api_key, port):
    global running
    attempt = 0
    delays = [1, 2, 4, 8, 15, 30, 60]
    while running:
        try:
            log("Connecting...")
            async with websockets.connect(WS_URL, ping_interval=None,
                                          ssl=SSL_CTX) as ws:
                await ws.send(json.dumps({"type": "auth", "api_key": api_key}))
                resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                if resp.get("type") != "auth_ok":
                    log(f"Auth failed: {resp.get('message')}")
                    return
                log(f'Authenticated as "{resp["agent_name"]}" ({resp["service_code"]})')
                log(f'Tunnel: {resp["tunnel_url"]} -> localhost:{port}')
                attempt = 0
                log("Ready.\n")

                async def pinger():
                    while running:
                        await asyncio.sleep(25)
                        try:
                            await ws.send(json.dumps({"type": "ping"}))
                        except:
                            break

                pt = asyncio.create_task(pinger())
                try:
                    while running:
                        raw = await ws.recv()
                        msg = json.loads(raw)
                        if msg.get("type") == "pong":
                            continue
                        if msg.get("type") == "request":
                            rid = msg["id"]
                            log(f'-> {msg.get("method")} {msg.get("path")} ({rid[:16]})')
                            s, h, b = await forward(
                                msg.get("method", "POST"),
                                msg.get("path", "/"),
                                msg.get("query_string", ""),
                                msg.get("headers", {}),
                                msg.get("body", ""),
                                port,
                            )
                            await ws.send(json.dumps({
                                "type": "response", "id": rid,
                                "status": s, "headers": h, "body": b,
                            }))
                            log(f"<- {s} ({len(b)} bytes)")
                finally:
                    pt.cancel()
        except websockets.ConnectionClosed:
            if not running:
                break
            log("Connection lost.")
        except Exception as e:
            if not running:
                break
            log(f"Error: {e}")
        if running:
            d = delays[min(attempt, len(delays) - 1)]
            log(f"Reconnecting in {d}s...")
            await asyncio.sleep(d)
            attempt += 1

def main():
    p = argparse.ArgumentParser(description="BotRoulette Tunnel Client")
    p.add_argument("--key", required=True, help="Your BotRoulette API key")
    p.add_argument("--port", type=int, required=True, help="Local server port")
    a = p.parse_args()
    global running
    signal.signal(signal.SIGINT, lambda *_: globals().__setitem__("running", False))
    print("\n  BotRoulette Tunnel Client\n")
    asyncio.run(run(a.key, a.port))

if __name__ == "__main__":
    main()
