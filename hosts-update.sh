#!/bin/bash

echo "=== PumpPortal Hosts Update Script ==="
echo ""

# Check if script is being run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (with sudo)"
  exit 1
fi

# First, try to get the IP address for PumpPortal.fun
IP=$(dig +short pumpportal.fun)

if [ -z "$IP" ]; then
  # If direct resolution fails, try OpenDNS
  echo "Trying to resolve using OpenDNS..."
  IP=$(dig +short @208.67.222.222 pumpportal.fun)
fi

if [ -z "$IP" ]; then
  # Fallback to Google DNS
  echo "Trying to resolve using Google DNS..."
  IP=$(dig +short @8.8.8.8 pumpportal.fun)
fi

if [ -z "$IP" ]; then
  echo "Could not resolve pumpportal.fun IP address. Using the IP from the API documentation."
  # Fallback IP address (you should verify this)
  IP="52.198.55.31"
fi

echo "Using IP: $IP for PumpPortal domains"

# Add entries to /etc/hosts
echo "Updating /etc/hosts file..."
cp /etc/hosts /etc/hosts.backup

# Remove any existing entries
sed -i '/pumpportal.fun/d' /etc/hosts

# Add new entries
echo "$IP pumpportal.fun" >> /etc/hosts
echo "$IP api.pumpportal.fun" >> /etc/hosts
echo "$IP socket.pumpportal.fun" >> /etc/hosts
echo "$IP www.pumpportal.fun" >> /etc/hosts

echo "Done! Updated /etc/hosts with PumpPortal entries."
echo "Old hosts file is backed up at /etc/hosts.backup" 