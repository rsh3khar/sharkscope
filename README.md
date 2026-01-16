# SharkScope

Real-time network traffic visualization. See your connections flow across a 2D world map or 3D globe as they happen.

## Features

- **Real-time visualization** - Watch network traffic flow on a 2D world map or 3D globe
- **Geographic mapping** - See where your connections are going with automatic IP geolocation
- **Process detection** - Know which apps are making each connection (macOS/Linux)
- **Packet recording** - Record traffic to pcap files for analysis in Wireshark
- **Auto-updating GeoIP** - Database downloads automatically, no account required
- **Dark mode UI** - Clean interface with real-time animations

## Requirements

- **Python 3.9+**
- **Wireshark/tshark** - For packet capture

## Installation

```bash
pip install sharkscope
```

### Install Wireshark

SharkScope uses `tshark` (Wireshark's command-line tool) for packet capture.

**macOS:**
```bash
brew install --cask wireshark
```

**Ubuntu/Debian:**
```bash
sudo apt install tshark
```

**Windows:**
Download from [wireshark.org](https://www.wireshark.org/download.html)

## Usage

```bash
# Start SharkScope (opens browser automatically)
sharkscope

# Specify port
sharkscope --port 9090

# Don't open browser
sharkscope --no-browser

# Update GeoIP database
sharkscope --update-geoip

# Run in demo mode (no tshark required)
sharkscope --demo
```

The GeoIP database downloads automatically on first run. Use `--update-geoip` to refresh it.

## Command Line Options

| Option | Description |
|--------|-------------|
| `-p, --port PORT` | Port to run on (default: 5762) |
| `--host HOST` | Host to bind to (default: 127.0.0.1) |
| `--no-browser` | Don't auto-open browser |
| `--no-geoip` | Run without geographic mapping |
| `--update-geoip` | Download/update GeoIP database |
| `--demo` | Demo mode with simulated data |
| `-v, --version` | Show version |

## How It Works

1. **Packet Capture** - Uses tshark to capture network packets
2. **GeoIP Lookup** - Maps IP addresses to geographic locations using GeoLite2
3. **Process Detection** - Uses lsof to identify which applications own connections
4. **Visualization** - Renders connections on an interactive 3D globe or 2D map

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Wireshark](https://www.wireshark.org/) - Network protocol analyzer
- [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) - IP geolocation database
- [Three.js](https://threejs.org/) - 3D globe visualization
