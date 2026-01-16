"""SharkScope CLI - Command line interface for starting the server."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
import threading
from typing import Tuple

from . import __version__


def check_tshark() -> Tuple[bool, str]:
    """Check if tshark is installed and accessible.

    Returns:
        Tuple of (is_available, path_or_error_message)
    """
    # Check standard PATH
    tshark_path = shutil.which("tshark")
    if tshark_path:
        return True, tshark_path

    # Check common Wireshark installation paths
    common_paths = [
        "/Applications/Wireshark.app/Contents/MacOS/tshark",  # macOS
        "/usr/bin/tshark",  # Linux
        "/usr/local/bin/tshark",  # Linux alt
        "C:\\Program Files\\Wireshark\\tshark.exe",  # Windows
    ]

    for path in common_paths:
        if Path(path).exists():
            return True, path

    return False, "tshark not found"


def check_geoip_database() -> Tuple[bool, Path]:
    """Check if GeoIP database exists, download if not.

    Returns:
        Tuple of (exists, path)
    """
    # Check in package data directory
    data_dir = Path.home() / ".sharkscope"
    data_dir.mkdir(exist_ok=True)

    db_path = data_dir / "GeoLite2-City.mmdb"

    if db_path.exists():
        return True, db_path

    # Check in current directory (development)
    local_db = Path(__file__).parent / "GeoLite2-City.mmdb"
    if local_db.exists():
        return True, local_db

    return False, db_path


GEOIP_CDN_URL = "https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz"
GEOIP_MAX_AGE_DAYS = 30


def download_geoip_database(target_path: Path) -> bool:
    """Download GeoIP database from jsDelivr CDN (community mirror)."""
    import gzip
    import urllib.request

    print(f"Downloading GeoIP database...")
    print(f"  Source: {GEOIP_CDN_URL}")

    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_gz = target_path.with_suffix('.mmdb.gz')
        tmp_path = target_path.with_suffix('.tmp')

        # Download gzipped file
        with urllib.request.urlopen(GEOIP_CDN_URL, timeout=120) as response:
            total_size = int(response.headers.get('Content-Length', 0))
            downloaded = 0

            with open(tmp_gz, 'wb') as f:
                while True:
                    chunk = response.read(1024 * 1024)  # 1MB chunks
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size:
                        pct = downloaded * 100 // total_size
                        mb = downloaded / (1024 * 1024)
                        total_mb = total_size / (1024 * 1024)
                        print(f"\r  Downloading: {mb:.1f}MB / {total_mb:.1f}MB ({pct}%)", end="", flush=True)

        print()  # newline after progress

        # Decompress
        print("  Decompressing...", end="", flush=True)
        with gzip.open(tmp_gz, 'rb') as f_in:
            with open(tmp_path, 'wb') as f_out:
                while True:
                    chunk = f_in.read(1024 * 1024)
                    if not chunk:
                        break
                    f_out.write(chunk)

        # Cleanup and move
        tmp_gz.unlink()
        if target_path.exists():
            target_path.unlink()
        tmp_path.rename(target_path)

        size_mb = target_path.stat().st_size / (1024 * 1024)
        print(f" done ({size_mb:.1f}MB)")
        print(f"✓ Saved to: {target_path}")
        return True

    except Exception as e:
        print(f"\n✗ Download failed: {e}")
        for p in [tmp_gz, tmp_path]:
            if p.exists():
                p.unlink()
        return False


def get_geoip_age_days(db_path: Path) -> int:
    """Get the age of the GeoIP database in days."""
    if not db_path.exists():
        return -1
    import time
    age_seconds = time.time() - db_path.stat().st_mtime
    return int(age_seconds / 86400)


def is_port_available(host: str, port: int) -> bool:
    """Check if a port is available for binding."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            return True
    except OSError:
        return False


def open_browser(url: str, max_wait: float = 10.0):
    """Open browser after server is ready."""
    import urllib.request
    import time as time_module

    def _wait_and_open():
        health_url = f"{url}/api/health"
        start = time_module.time()

        # Poll until server responds or timeout
        while time_module.time() - start < max_wait:
            try:
                with urllib.request.urlopen(health_url, timeout=1) as resp:
                    if resp.status == 200:
                        webbrowser.open(url)
                        return
            except Exception:
                pass
            time_module.sleep(0.3)

        # Timeout - open anyway, user can refresh
        webbrowser.open(url)

    thread = threading.Thread(target=_wait_and_open, daemon=True)
    thread.start()


def print_banner():
    """Print SharkScope startup banner."""
    print(f"""
┌─────────────────────────────────────────┐
│  SharkScope v{__version__:<26} │
│  Real-time Network Traffic Visualizer   │
└─────────────────────────────────────────┘
""")


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="sharkscope",
        description="Real-time network traffic visualization with geographic mapping",
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=5762,
        help="Port to run the server on (default: 5762)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't automatically open browser",
    )
    parser.add_argument(
        "--no-geoip",
        action="store_true",
        help="Run without GeoIP database (no geographic mapping)",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Run in demo mode with sample data (no tshark required)",
    )
    parser.add_argument(
        "--update-geoip",
        action="store_true",
        help="Download/update the GeoIP database and exit",
    )
    parser.add_argument(
        "-v", "--version",
        action="version",
        version=f"sharkscope {__version__}",
    )

    args = parser.parse_args()

    print_banner()

    # Handle --update-geoip
    if args.update_geoip:
        _, geoip_path = check_geoip_database()
        if download_geoip_database(geoip_path):
            sys.exit(0)
        else:
            sys.exit(1)

    # Check tshark
    tshark_path = None
    if not args.demo:
        tshark_available, tshark_info = check_tshark()
        if not tshark_available:
            print("⚠️  tshark not found!")
            print("""
To capture network traffic, SharkScope requires Wireshark/tshark.

Install Wireshark:
  macOS:   brew install --cask wireshark
  Ubuntu:  sudo apt install tshark
  Windows: https://www.wireshark.org/download.html

Or run with --demo to see sample data without capturing.
""")
            if not args.demo:
                print("Starting in demo mode...\n")
                args.demo = True
        else:
            tshark_path = tshark_info
            print(f"✓ tshark found: {tshark_path}")

    # Check GeoIP database
    if not args.no_geoip:
        geoip_exists, geoip_path = check_geoip_database()
        if geoip_exists:
            age_days = get_geoip_age_days(geoip_path)
            if age_days > GEOIP_MAX_AGE_DAYS:
                print(f"⚠️  GeoIP database is {age_days} days old")
                print(f"   Run 'sharkscope --update-geoip' to update")
            else:
                print(f"✓ GeoIP database: {geoip_path}")
        else:
            print("GeoIP database not found. Downloading...")
            if download_geoip_database(geoip_path):
                print(f"✓ GeoIP database ready")
            else:
                print("⚠️  Running without GeoIP (no geographic mapping)")
                args.no_geoip = True

    # Set environment variables for server
    import os
    os.environ["SHARKSCOPE_HOST"] = args.host
    os.environ["SHARKSCOPE_PORT"] = str(args.port)
    os.environ["SHARKSCOPE_DEMO"] = "1" if args.demo else "0"
    os.environ["SHARKSCOPE_NO_GEOIP"] = "1" if args.no_geoip else "0"
    if tshark_path:
        os.environ["SHARKSCOPE_TSHARK"] = tshark_path

    # Check port availability
    if not is_port_available(args.host, args.port):
        print(f"\n✗ Port {args.port} is already in use")
        print(f"  Try: sharkscope --port {args.port + 1}")
        sys.exit(1)

    url = f"http://{args.host}:{args.port}"
    print(f"\n🌐 Starting server at {url}")

    # Open browser
    if not args.no_browser:
        print(f"🚀 Opening browser...")
        open_browser(url)

    print("\nPress Ctrl+C to stop\n")
    print("-" * 40)

    # Start server
    try:
        import uvicorn
        from .server import create_app

        app = create_app()
        uvicorn.run(
            app,
            host=args.host,
            port=args.port,
            log_level="info",
        )
    except KeyboardInterrupt:
        print("\n\nShutting down...")
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
