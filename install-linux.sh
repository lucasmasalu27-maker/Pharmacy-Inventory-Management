#!/usr/bin/env bash
# Add "Pharmacy Ledger" to the Linux applications menu.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/pharmacy-ledger.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Pharmacy Ledger
Comment=Stock ledger and dispensing register
Exec=$DIR/run-desktop.sh
Icon=$DIR/icons/icon-512.png
Terminal=true
Categories=Office;MedicalSoftware;
DESKTOP
echo "Installed. Find “Pharmacy Ledger” in your applications menu."
