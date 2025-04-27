#!/bin/bash

echo "=== Pump.fun Connection Fix Script ==="
echo ""

# Check if script is being run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (with sudo)"
  exit 1
fi

echo "1. Adding DNS entries to /etc/hosts..."
grep -q "pump.fun" /etc/hosts || {
  echo "52.198.55.31 socket.pump.fun" >> /etc/hosts
  echo "52.198.55.31 api.pump.fun" >> /etc/hosts 
  echo "52.198.55.31 pump.fun" >> /etc/hosts
}

echo "2. Configuring DNS resolver..."
grep -q "nameserver 8.8.8.8" /etc/resolv.conf || {
  echo "nameserver 8.8.8.8" >> /etc/resolv.conf
}

echo "3. Adding firewall rules to allow pump.fun connections..."
# Allow outbound HTTPS traffic to pump.fun servers
iptables -I OUTPUT -p tcp -d 52.198.55.31 --dport 443 -j ACCEPT
# Allow WebSocket connections
iptables -I OUTPUT -p tcp --dport 443 -m string --string "Upgrade: websocket" --algo bm -j ACCEPT

echo "4. Testing connectivity..."
echo "Testing DNS resolution..."
host socket.pump.fun || echo "DNS resolution still failing"

echo "Testing HTTP connectivity..."
curl -s --connect-timeout 5 https://api.pump.fun/health > /dev/null
if [ $? -eq 0 ]; then
  echo "✅ HTTP connection successful"
else
  echo "❌ HTTP connection failed"
fi

echo ""
echo "Connection fix completed. Please run /pumpfun_diagnose in the bot to verify the connection." 