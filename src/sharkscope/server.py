"""
SharkScope Server - FastAPI application for network traffic visualization.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import subprocess
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional


def normalize_ip(ip: str) -> str:
    """Normalize IP address for consistent cache key matching.

    IPv6 addresses can have multiple representations (compressed vs full),
    so we normalize to ensure lsof and tshark outputs match.
    """
    try:
        return str(ipaddress.ip_address(ip))
    except ValueError:
        return ip  # Return as-is if not a valid IP

import geoip2.database
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ============= CONFIG =============


def get_tshark_path() -> str:
    """Get the path to tshark binary."""
    return os.environ.get("SHARKSCOPE_TSHARK", "tshark")


def get_data_dir() -> Path:
    """Get the data directory for SharkScope."""
    return Path.home() / ".sharkscope"


def get_geoip_path() -> Path:
    """Get the path to GeoIP database."""
    # Check user data dir first
    user_db = get_data_dir() / "GeoLite2-City.mmdb"
    if user_db.exists():
        return user_db

    # Check package directory (development)
    pkg_db = Path(__file__).parent / "GeoLite2-City.mmdb"
    if pkg_db.exists():
        return pkg_db

    # Check v2/backend (development)
    dev_db = Path(__file__).parent.parent.parent.parent / "v2" / "backend" / "GeoLite2-City.mmdb"
    if dev_db.exists():
        return dev_db

    return user_db  # Return default even if doesn't exist


def get_recordings_dir() -> Path:
    """Get the recordings directory."""
    recordings_dir = get_data_dir() / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    return recordings_dir


def get_static_dir() -> Path:
    """Get the static files directory for frontend."""
    # Check package static dir
    pkg_static = Path(__file__).parent / "static"
    if pkg_static.exists() and (pkg_static / "index.html").exists():
        return pkg_static

    # Check development frontend build
    dev_static = Path(__file__).parent.parent.parent.parent / "v2" / "frontend" / "dist"
    if dev_static.exists():
        return dev_static

    return pkg_static


# ============= GEOIP =============

geoip_reader = None
geoip_cache = {}
online_lookup_cache = {}


def init_geoip():
    """Initialize GeoIP database reader."""
    global geoip_reader

    if os.environ.get("SHARKSCOPE_NO_GEOIP") == "1":
        print("GeoIP disabled by configuration")
        return

    geoip_path = get_geoip_path()
    if geoip_path.exists():
        geoip_reader = geoip2.database.Reader(str(geoip_path))
        print(f"GeoIP database loaded: {geoip_path}")
    else:
        print(f"Warning: GeoIP database not found at {geoip_path}")


def lookup_ip(ip: str) -> Optional[dict]:
    """Lookup geographic info for an IP address."""
    if ip in geoip_cache:
        return geoip_cache[ip]

    if not geoip_reader:
        return None

    # Skip private/local/multicast IPs
    if (ip.startswith(('10.', '192.168.', '172.16.', '172.17.', '172.18.',
                       '172.19.', '172.2', '172.30.', '172.31.', '127.', '0.', '169.254.',
                       '224.', '225.', '226.', '227.', '228.', '229.',
                       '230.', '231.', '232.', '233.', '234.', '235.', '236.', '237.', '238.', '239.'))
        or ip == '::1'
        or ip.startswith('fe80:')
        or ip.startswith('ff')
        or ip.startswith('fc')
        or ip.startswith('fd')):
        return None

    try:
        response = geoip_reader.city(ip)
        lat = response.location.latitude
        lon = response.location.longitude

        if lat is None or lon is None or (lat == 0 and lon == 0):
            result = {
                "ip": ip,
                "city": "Unknown",
                "country": "Unknown",
                "country_code": "",
                "lat": None,
                "lon": None,
                "org": response.traits.organization or "",
                "pending": True,
            }
            return result

        result = {
            "ip": ip,
            "city": response.city.name or "Unknown",
            "country": response.country.name or "Unknown",
            "country_code": response.country.iso_code or "",
            "lat": lat,
            "lon": lon,
            "org": response.traits.organization or "",
        }
        geoip_cache[ip] = result
        return result
    except Exception:
        result = {
            "ip": ip,
            "city": "Unknown",
            "country": "Unknown",
            "country_code": "",
            "lat": None,
            "lon": None,
            "org": "",
            "pending": True,
        }
        return result


# ============= PROCESS IDENTIFICATION =============

process_socket_cache = {}
process_cache_lock = threading.Lock()
process_refresh_thread = None
process_refresh_stop = threading.Event()


def get_process_name_from_pid(pid: str) -> Optional[str]:
    """Get the actual command name for a PID."""
    try:
        result = subprocess.run(
            ["ps", "-p", pid, "-o", "comm="],
            capture_output=True, text=True, timeout=1
        )
        if result.returncode == 0:
            name = result.stdout.strip()
            if name:
                name = name.split('/')[-1]
                return name if name else None
    except Exception:
        pass
    return None


def parse_lsof_output(output: str) -> dict:
    """Parse lsof output into socket cache."""
    socket_cache = {}
    pid_name_cache = {}

    for line in output.strip().split('\n')[1:]:
        parts = line.split()
        if len(parts) >= 9:
            lsof_name = parts[0].replace('\\x20', ' ')
            pid = parts[1]

            name_col = None
            for p in parts[8:]:
                if ':' in p:
                    name_col = p
                    break
            if not name_col:
                continue

            if pid not in pid_name_cache:
                actual_name = get_process_name_from_pid(pid)
                pid_name_cache[pid] = actual_name or lsof_name

            actual_name = pid_name_cache[pid]

            if lsof_name in ('node', 'python', 'python3', 'java', 'ruby', 'Python'):
                process_name = actual_name
            else:
                process_name = lsof_name

            process_info = {"process": process_name, "pid": pid}

            local_match = re.search(r':(\d+)(?:->|$)', name_col)
            if not local_match:
                continue
            local_port = int(local_match.group(1))

            remote_match = re.search(r'->\[([^\]]+)\]:(\d+)', name_col) or re.search(r'->([^:\[\]]+):(\d+)$', name_col)
            if remote_match:
                remote_ip = normalize_ip(remote_match.group(1))
                remote_port = int(remote_match.group(2))
                # Use | delimiter to avoid conflicts with IPv6 colons
                socket_key = f"{local_port}|{remote_ip}|{remote_port}"
                socket_cache[socket_key] = process_info

    return socket_cache


def background_process_refresh():
    """Background thread that continuously refreshes the process cache."""
    global process_socket_cache

    while not process_refresh_stop.is_set():
        try:
            result = subprocess.run(
                ["lsof", "-i", "-n", "-P"],
                capture_output=True, text=True, timeout=5
            )
            socket_cache = parse_lsof_output(result.stdout)

            with process_cache_lock:
                process_socket_cache = socket_cache

        except subprocess.TimeoutExpired:
            pass
        except Exception:
            pass

        for _ in range(3):
            if process_refresh_stop.is_set():
                break
            time.sleep(0.1)


def start_process_refresh_thread():
    """Start the background process refresh thread."""
    global process_refresh_thread

    if process_refresh_thread is not None and process_refresh_thread.is_alive():
        return

    process_refresh_stop.clear()
    process_refresh_thread = threading.Thread(
        target=background_process_refresh,
        daemon=True,
        name="ProcessRefresh"
    )
    process_refresh_thread.start()
    print("Background process detection started")


def stop_process_refresh_thread():
    """Stop the background process refresh thread."""
    global process_refresh_thread

    process_refresh_stop.set()
    if process_refresh_thread is not None:
        process_refresh_thread.join(timeout=2.0)
        process_refresh_thread = None
    print("Background process detection stopped")


def get_process_for_connection(src_port: int, dst_port: int, src_ip: str = None, dst_ip: str = None) -> Optional[dict]:
    """Get process info for a connection."""
    with process_cache_lock:
        # Normalize IPs to handle IPv6 format differences between lsof and tshark
        norm_src_ip = normalize_ip(src_ip) if src_ip else None
        norm_dst_ip = normalize_ip(dst_ip) if dst_ip else None

        # Use | delimiter to handle IPv6 addresses (which contain colons)
        # Try exact match first
        if src_port and norm_dst_ip and dst_port:
            socket_key = f"{src_port}|{norm_dst_ip}|{dst_port}"
            result = process_socket_cache.get(socket_key)
            if result:
                return result

        if dst_port and norm_src_ip and src_port:
            socket_key = f"{dst_port}|{norm_src_ip}|{src_port}"
            result = process_socket_cache.get(socket_key)
            if result:
                return result

        # Fallback: match by destination IP+port only (for outbound connections)
        # This handles cases where local port changed between lsof runs
        if norm_dst_ip and dst_port:
            dst_suffix = f"|{norm_dst_ip}|{dst_port}"
            for key, info in process_socket_cache.items():
                if key.endswith(dst_suffix):
                    return info

        return None


# ============= RECORDING =============

active_recordings = {}


async def start_recording(interfaces: List[str], session_id: str) -> dict:
    """Start recording packets to a pcap file."""
    if session_id in active_recordings:
        return {"error": "Recording already in progress", "session_id": session_id}

    recordings_dir = get_recordings_dir()
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    filename = f"capture_{timestamp}_{session_id[:8]}.pcap"
    filepath = recordings_dir / filename

    cmd = [get_tshark_path()]
    for iface in interfaces:
        cmd.extend(["-i", iface])
    cmd.extend(["-w", str(filepath), "-F", "pcap"])

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        active_recordings[session_id] = {
            "process": process,
            "filename": filename,
            "filepath": str(filepath),
            "interfaces": interfaces,
            "start_time": time.time(),
        }

        print(f"Started recording to {filename}")
        return {
            "status": "recording",
            "session_id": session_id,
            "filename": filename,
        }
    except Exception as e:
        return {"error": str(e)}


async def stop_recording(session_id: str) -> dict:
    """Stop an active recording."""
    if session_id not in active_recordings:
        return {"error": "No active recording found", "session_id": session_id}

    recording = active_recordings.pop(session_id)
    process = recording["process"]

    try:
        process.terminate()
        await asyncio.wait_for(process.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
    except Exception:
        pass

    filepath = Path(recording["filepath"])
    file_size = filepath.stat().st_size if filepath.exists() else 0
    duration = time.time() - recording["start_time"]

    print(f"Stopped recording {recording['filename']} ({file_size} bytes, {duration:.1f}s)")

    return {
        "status": "stopped",
        "session_id": session_id,
        "filename": recording["filename"],
        "file_size": file_size,
        "duration": duration,
        "download_url": f"/api/recordings/{recording['filename']}",
    }


# ============= APP FACTORY =============

def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_geoip()
        get_recordings_dir()  # Ensure recordings dir exists
        if os.environ.get("SHARKSCOPE_DEMO") != "1":
            start_process_refresh_thread()
        yield
        for session_id in list(active_recordings.keys()):
            await stop_recording(session_id)
        stop_process_refresh_thread()

    app = FastAPI(title="SharkScope", lifespan=lifespan)

    # API Routes
    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "geoip": geoip_reader is not None,
            "demo": os.environ.get("SHARKSCOPE_DEMO") == "1",
        }

    @app.get("/api/geoip/{ip}")
    async def geoip_lookup(ip: str):
        result = lookup_ip(ip)
        if result:
            return result
        return {"error": "Not found", "ip": ip}

    @app.get("/api/lookup/{ip}")
    async def lookup_ip_online(ip: str):
        """Lookup IP using online service when local DB fails."""
        import urllib.request

        if ip in online_lookup_cache:
            return online_lookup_cache[ip]

        try:
            url = f"http://ip-api.com/json/{ip}?fields=status,country,city,lat,lon,org,isp"
            with urllib.request.urlopen(url, timeout=5) as response:
                data = json.loads(response.read().decode())

            if data.get("status") == "success":
                result = {
                    "ip": ip,
                    "city": data.get("city", "Unknown"),
                    "country": data.get("country", "Unknown"),
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                    "org": data.get("org") or data.get("isp", ""),
                    "source": "ip-api.com",
                }
                online_lookup_cache[ip] = result
                return result

            error_result = {"error": "Lookup failed", "ip": ip}
            online_lookup_cache[ip] = error_result
            return error_result
        except Exception as e:
            return {"error": str(e), "ip": ip}

    @app.get("/api/my-location")
    async def get_my_location():
        """Detect user's location from their public IP."""
        import urllib.request
        try:
            with urllib.request.urlopen("https://api.ipify.org", timeout=5) as response:
                public_ip = response.read().decode().strip()

            if geoip_reader:
                try:
                    response = geoip_reader.city(public_ip)
                    return {
                        "ip": public_ip,
                        "city": response.city.name or "Unknown",
                        "country": response.country.name or "Unknown",
                        "country_code": response.country.iso_code or "",
                        "lat": response.location.latitude,
                        "lon": response.location.longitude,
                        "org": response.traits.organization or "",
                    }
                except Exception:
                    pass

            return {"error": "Could not determine location", "ip": public_ip}
        except Exception as e:
            return {"error": str(e)}

    @app.get("/api/recordings")
    async def list_recordings():
        """List available recordings."""
        recordings = []
        recordings_dir = get_recordings_dir()
        if recordings_dir.exists():
            for f in sorted(recordings_dir.glob("*.pcap"), key=lambda x: x.stat().st_mtime, reverse=True):
                stat = f.stat()
                recordings.append({
                    "filename": f.name,
                    "size": stat.st_size,
                    "created": stat.st_mtime,
                    "download_url": f"/api/recordings/{f.name}",
                })
        return {"recordings": recordings}

    @app.get("/api/recordings/{filename}")
    async def download_recording(filename: str):
        """Download a recording pcap file."""
        safe_filename = Path(filename).name
        filepath = get_recordings_dir() / safe_filename

        if not filepath.exists():
            return {"error": "Recording not found"}

        return FileResponse(
            filepath,
            media_type="application/vnd.tcpdump.pcap",
            filename=safe_filename,
        )

    @app.delete("/api/recordings/{filename}")
    async def delete_recording(filename: str):
        """Delete a recording file."""
        safe_filename = Path(filename).name
        filepath = get_recordings_dir() / safe_filename

        if not filepath.exists():
            return {"error": "Recording not found"}

        filepath.unlink()
        return {"status": "deleted", "filename": safe_filename}

    @app.get("/api/interfaces")
    async def list_interfaces():
        """List available network interfaces."""
        if os.environ.get("SHARKSCOPE_DEMO") == "1":
            return {
                "interfaces": [
                    {"id": "1", "name": "demo", "description": "1. demo (Demo Interface)"}
                ],
                "demo": True,
            }

        try:
            result = subprocess.run(
                [get_tshark_path(), "-D"],
                capture_output=True, text=True, timeout=5
            )
            interfaces = []
            for line in result.stdout.strip().split('\n'):
                match = re.match(r'(\d+)\. (\S+)', line)
                if match:
                    interfaces.append({
                        "id": match.group(1),
                        "name": match.group(2),
                        "description": line
                    })
            return {"interfaces": interfaces}
        except Exception as e:
            return {"error": str(e), "interfaces": []}

    @app.websocket("/ws/capture/{interface}")
    async def capture_websocket(websocket: WebSocket, interface: str):
        """WebSocket endpoint for live packet capture."""
        await websocket.accept()

        session_id = str(uuid.uuid4())
        interfaces = [i.strip() for i in interface.split(",") if i.strip()]
        print(f"Starting capture on interface(s): {interfaces}, session: {session_id[:8]}")

        await websocket.send_json({
            "type": "session",
            "session_id": session_id,
            "interfaces": interfaces,
        })

        # Demo mode
        if os.environ.get("SHARKSCOPE_DEMO") == "1":
            await run_demo_capture(websocket, session_id)
            return

        # Real capture mode
        await run_real_capture(websocket, session_id, interfaces)

    # Mount static files at /static, serve index.html for SPA routes
    static_dir = get_static_dir()
    if static_dir.exists():
        # Mount assets at /assets
        assets_dir = static_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        # Serve individual static files
        @app.get("/vite.svg")
        async def vite_svg():
            return FileResponse(static_dir / "vite.svg")

        # Catch-all for SPA - must be HTTP only (not WebSocket)
        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            # Serve index.html for all non-API, non-WebSocket routes
            index_path = static_dir / "index.html"
            if index_path.exists():
                return FileResponse(index_path)
            return {"error": "Frontend not found"}

        print(f"Serving frontend from: {static_dir}")

    return app


async def run_demo_capture(websocket: WebSocket, session_id: str):
    """Run demo capture with simulated data."""
    import random

    demo_destinations = [
        {"city": "San Francisco", "country": "United States", "lat": 37.7749, "lon": -122.4194},
        {"city": "New York", "country": "United States", "lat": 40.7128, "lon": -74.0060},
        {"city": "London", "country": "United Kingdom", "lat": 51.5074, "lon": -0.1278},
        {"city": "Tokyo", "country": "Japan", "lat": 35.6762, "lon": 139.6503},
        {"city": "Sydney", "country": "Australia", "lat": -33.8688, "lon": 151.2093},
        {"city": "Frankfurt", "country": "Germany", "lat": 50.1109, "lon": 8.6821},
        {"city": "Singapore", "country": "Singapore", "lat": 1.3521, "lon": 103.8198},
    ]

    demo_apps = ["Chrome", "Safari", "Slack", "Zoom", "Spotify", "Discord", "curl", "node"]
    demo_protocols = ["HTTPS", "HTTP", "QUIC", "TCP", "UDP"]

    home_geo = {"city": "Your Location", "country": "Your Country", "lat": 37.4, "lon": -122.1, "isHome": True}

    # Track seen flows to properly mark new flows (by IP pair)
    seen_flows = set()
    packet_count = 0

    try:
        while True:
            dst = random.choice(demo_destinations)
            dst_ip = f"{random.randint(1,223)}.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
            dst_geo = {
                "ip": dst_ip,
                **dst,
            }

            # Flow key matches frontend's connection key format
            flow_key = tuple(sorted(["192.168.1.100", dst_ip]))

            # First 20 packets are always new flows to populate the map quickly
            # After that, new IPs are new flows, same IPs update existing
            is_new_flow = packet_count < 20 or flow_key not in seen_flows
            if is_new_flow:
                seen_flows.add(flow_key)
            packet_count += 1

            message = {
                "type": "packet",
                "new_flow": is_new_flow,
                "src_ip": "192.168.1.100",
                "dst_ip": dst_geo["ip"],
                "src_port": random.randint(50000, 65535),
                "dst_port": random.choice([443, 80, 8080, 53, 22]),
                "protocol": random.choice(demo_protocols),
                "length": random.randint(64, 1500),
                "timestamp": time.time(),
                "src_geo": home_geo,
                "dst_geo": dst_geo,
                "process": random.choice(demo_apps),
                "pid": str(random.randint(1000, 9999)),
            }

            await websocket.send_json(message)
            await asyncio.sleep(random.uniform(0.1, 0.5))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        print(f"Demo session {session_id[:8]} ended")


async def run_real_capture(websocket: WebSocket, session_id: str, interfaces: List[str]):
    """Run real packet capture with tshark."""
    seen_flows = set()
    process = None
    is_recording = False

    unknown_ips_queue = asyncio.Queue()
    looked_up_ips = set()

    async def handle_incoming_messages():
        nonlocal is_recording
        try:
            while True:
                data = await websocket.receive_json()
                cmd_type = data.get("type")

                if cmd_type == "start_recording":
                    result = await start_recording(interfaces, session_id)
                    is_recording = "error" not in result
                    await websocket.send_json({"type": "recording_status", **result})

                elif cmd_type == "stop_recording":
                    result = await stop_recording(session_id)
                    is_recording = False
                    await websocket.send_json({"type": "recording_status", **result})

        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def background_ip_lookup():
        import urllib.request

        def try_ip_api(ip):
            url = f"http://ip-api.com/json/{ip}?fields=status,country,city,lat,lon,org,isp"
            with urllib.request.urlopen(url, timeout=5) as response:
                data = json.loads(response.read().decode())
            if data.get("status") == "success":
                lat, lon = data.get("lat"), data.get("lon")
                if lat is not None and lon is not None and not (lat == 0 and lon == 0):
                    return {
                        "ip": ip,
                        "city": data.get("city") or "Unknown",
                        "country": data.get("country") or "Unknown",
                        "lat": lat,
                        "lon": lon,
                        "org": data.get("org") or data.get("isp", ""),
                        "source": "ip-api.com",
                    }
            return None

        while True:
            try:
                try:
                    ip = await asyncio.wait_for(unknown_ips_queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if ip in looked_up_ips:
                    continue
                looked_up_ips.add(ip)

                if ip in online_lookup_cache:
                    cached = online_lookup_cache[ip]
                    if cached.get("lat") and cached.get("lon") and not cached.get("error"):
                        await websocket.send_json({"type": "geo_update", "ip": ip, "geo": cached})
                    continue

                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(None, try_ip_api, ip)

                if result:
                    online_lookup_cache[ip] = result
                    geoip_cache[ip] = result
                    await websocket.send_json({"type": "geo_update", "ip": ip, "geo": result})
                else:
                    failed_result = {
                        "ip": ip,
                        "city": "Unknown",
                        "country": "Unknown Location",
                        "lat": -85,
                        "lon": 0,
                        "org": "",
                        "unknown": True,
                    }
                    online_lookup_cache[ip] = failed_result
                    geoip_cache[ip] = failed_result
                    await websocket.send_json({"type": "geo_update", "ip": ip, "geo": failed_result})

                await asyncio.sleep(0.5)

            except asyncio.CancelledError:
                break
            except Exception:
                pass

    async def process_packets():
        nonlocal process
        try:
            cmd = [get_tshark_path()]
            for iface in interfaces:
                cmd.extend(["-i", iface])
            cmd.extend([
                "-l", "-T", "fields",
                "-e", "frame.time_epoch",
                "-e", "ip.src", "-e", "ip.dst",
                "-e", "ipv6.src", "-e", "ipv6.dst",
                "-e", "tcp.srcport", "-e", "tcp.dstport",
                "-e", "udp.srcport", "-e", "udp.dstport",
                "-e", "frame.len", "-e", "_ws.col.Protocol",
                "-E", "separator=|", "-Y", "ip || ipv6",
            ])

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            while True:
                line = await process.stdout.readline()
                if not line:
                    break

                line = line.decode().strip()
                if not line:
                    continue

                parts = line.split("|")
                if len(parts) < 11:
                    continue

                timestamp, ip_src, ip_dst, ipv6_src, ipv6_dst, tcp_sport, tcp_dport, udp_sport, udp_dport, length, protocol = parts

                src_ip = ip_src or ipv6_src
                dst_ip = ip_dst or ipv6_dst

                if not src_ip or not dst_ip:
                    continue

                src_port = int(tcp_sport or udp_sport or 0) or None
                dst_port = int(tcp_dport or udp_dport or 0) or None

                src_geo = lookup_ip(src_ip)
                dst_geo = lookup_ip(dst_ip)

                if not src_geo and not dst_geo:
                    continue

                if src_geo and src_geo.get("pending") and src_ip not in looked_up_ips:
                    await unknown_ips_queue.put(src_ip)
                if dst_geo and dst_geo.get("pending") and dst_ip not in looked_up_ips:
                    await unknown_ips_queue.put(dst_ip)

                flow_key = tuple(sorted([src_ip, dst_ip]))
                is_new_flow = flow_key not in seen_flows
                if is_new_flow:
                    seen_flows.add(flow_key)

                process_info = None
                if src_port and dst_port:
                    process_info = get_process_for_connection(src_port, dst_port, src_ip, dst_ip)

                # Track new flows without process for later lookup
                if is_new_flow and not process_info and src_port and dst_port:
                    conn_key = (src_port, dst_port, src_ip, dst_ip)
                    pending_process_lookups[conn_key] = flow_key

                message = {
                    "type": "packet",
                    "new_flow": is_new_flow,
                    "src_ip": src_ip,
                    "dst_ip": dst_ip,
                    "src_port": src_port,
                    "dst_port": dst_port,
                    "protocol": protocol or "IP",
                    "length": int(length) if length else 0,
                    "timestamp": float(timestamp) if timestamp else 0,
                    "src_geo": src_geo,
                    "dst_geo": dst_geo,
                }

                if process_info:
                    message["process"] = process_info["process"]
                    message["pid"] = process_info["pid"]

                await websocket.send_json(message)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            try:
                await websocket.send_json({"type": "error", "error": str(e)})
            except Exception:
                pass

    # Track connections without process info for later lookup
    pending_process_lookups = {}  # key: (src_port, dst_port, src_ip, dst_ip) -> flow_key

    async def background_process_lookup():
        """Periodically retry process lookup for connections that didn't have it."""
        while True:
            try:
                await asyncio.sleep(0.5)  # Check every 500ms

                if not pending_process_lookups:
                    continue

                # Check pending lookups against current cache
                resolved = []
                for conn_key, flow_key in list(pending_process_lookups.items()):
                    src_port, dst_port, src_ip, dst_ip = conn_key
                    process_info = get_process_for_connection(src_port, dst_port, src_ip, dst_ip)
                    if process_info:
                        resolved.append(conn_key)
                        # Send process update to frontend
                        await websocket.send_json({
                            "type": "process_update",
                            "src_ip": src_ip,
                            "dst_ip": dst_ip,
                            "process": process_info["process"],
                            "pid": process_info["pid"],
                        })

                # Remove resolved entries
                for key in resolved:
                    pending_process_lookups.pop(key, None)

            except asyncio.CancelledError:
                break
            except Exception:
                pass

    packet_task = asyncio.create_task(process_packets())
    message_task = asyncio.create_task(handle_incoming_messages())
    lookup_task = asyncio.create_task(background_ip_lookup())
    process_lookup_task = asyncio.create_task(background_process_lookup())

    try:
        done, pending = await asyncio.wait(
            [packet_task, message_task, lookup_task, process_lookup_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        if session_id in active_recordings:
            await stop_recording(session_id)

        if process:
            try:
                process.terminate()
                await process.wait()
            except Exception:
                pass

        try:
            await websocket.close()
        except Exception:
            pass

        print(f"Session {session_id[:8]} ended")
