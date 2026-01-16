#!/usr/bin/env python3
"""
Build script for SharkScope.

This script:
1. Builds the frontend (npm run build)
2. Copies the built files to the package's static directory
3. Builds the Python package (pip wheel)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional


def run(cmd: List[str], cwd: Optional[Path] = None, check: bool = True):
    """Run a command and print output."""
    print(f"  → {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, capture_output=False)
    if check and result.returncode != 0:
        print(f"Command failed with exit code {result.returncode}")
        sys.exit(1)
    return result


def main():
    # Paths
    project_root = Path(__file__).parent.parent
    frontend_dir = project_root / "frontend"
    static_dir = project_root / "src" / "sharkscope" / "static"
    dist_dir = project_root / "dist"

    print("=" * 50)
    print("SharkScope Build")
    print("=" * 50)

    # Step 1: Build frontend
    print("\n[1/3] Building frontend...")
    if not frontend_dir.exists():
        print(f"Error: Frontend directory not found: {frontend_dir}")
        sys.exit(1)

    run(["npm", "install"], cwd=frontend_dir)
    run(["npm", "run", "build"], cwd=frontend_dir)

    frontend_build = frontend_dir / "dist"
    if not frontend_build.exists():
        print(f"Error: Frontend build directory not found: {frontend_build}")
        sys.exit(1)

    # Step 2: Copy to static directory
    print("\n[2/3] Copying frontend to package...")
    if static_dir.exists():
        shutil.rmtree(static_dir)
    shutil.copytree(frontend_build, static_dir)
    print(f"  Copied {sum(1 for _ in static_dir.rglob('*') if _.is_file())} files")

    # Step 3: Build Python package
    print("\n[3/3] Building Python package...")
    if dist_dir.exists():
        shutil.rmtree(dist_dir)

    run([sys.executable, "-m", "pip", "wheel", ".", "-w", "dist", "--no-deps"], cwd=project_root)

    # Also build sdist
    run([sys.executable, "-m", "build", "--sdist"], cwd=project_root, check=False)

    # Summary
    print("\n" + "=" * 50)
    print("Build complete!")
    print("=" * 50)

    wheels = list(dist_dir.glob("*.whl"))
    if wheels:
        print(f"\nWheel: {wheels[0].name}")
        print(f"Size:  {wheels[0].stat().st_size / 1024 / 1024:.2f} MB")

    print(f"\nTo install locally:")
    print(f"  pip install {wheels[0] if wheels else 'dist/*.whl'}")

    print(f"\nTo publish to PyPI:")
    print(f"  pip install twine")
    print(f"  twine upload dist/*")


if __name__ == "__main__":
    main()
