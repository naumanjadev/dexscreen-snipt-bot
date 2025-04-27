#!/bin/bash

echo "=== Advanced Pump.fun Connectivity Troubleshooting ==="
echo ""

echo "1. Testing basic DNS resolution..."
echo "Running: dig socket.pump.fun"
dig socket.pump.fun

echo ""
echo "2. Testing basic connectivity with ping..."
echo "Running: ping -c 4 52.198.55.31"
ping -c 4 52.198.55.31

echo ""
echo "3. Testing HTTP connectivity with curl (verbose)..."
echo "Running: curl -v --connect-timeout 10 https://api.pump.fun/health"
curl -v --connect-timeout 10 https://api.pump.fun/health

echo ""
echo "4. Testing with TLS version specification..."
echo "Running: curl -v --tlsv1.2 --connect-timeout 10 https://api.pump.fun/health"
curl -v --tlsv1.2 --connect-timeout 10 https://api.pump.fun/health

echo ""
echo "5. Testing with certificate verification disabled (ONLY FOR DIAGNOSTIC PURPOSES)..."
echo "Running: curl -v --insecure --connect-timeout 10 https://api.pump.fun/health"
curl -v --insecure --connect-timeout 10 https://api.pump.fun/health

echo ""
echo "6. Testing outbound HTTPS connectivity to another website..."
echo "Running: curl -v --connect-timeout 10 https://www.google.com"
curl -v --connect-timeout 10 https://www.google.com

echo ""
echo "7. Checking if there are any proxy settings in the environment..."
echo "HTTP_PROXY: $HTTP_PROXY"
echo "HTTPS_PROXY: $HTTPS_PROXY"
echo "http_proxy: $http_proxy"
echo "https_proxy: $https_proxy"

echo ""
echo "8. Checking firewall status..."
echo "Running: iptables -L OUTPUT -n"
iptables -L OUTPUT -n

echo ""
echo "9. Testing WebSocket connectivity (will timeout after 5 seconds)..."
echo "Running: curl --include --no-buffer --header 'Connection: Upgrade' --header 'Upgrade: websocket' -v --connect-timeout 5 https://socket.pump.fun"
curl --include --no-buffer --header 'Connection: Upgrade' --header 'Upgrade: websocket' -v --connect-timeout 5 https://socket.pump.fun

echo ""
echo "10. Checking current SSL/TLS capabilities..."
echo "Running: openssl ciphers -v | head"
openssl ciphers -v | head

echo ""
echo "11. Tracing route to pump.fun servers..."
echo "Running: traceroute -T -p 443 52.198.55.31"
traceroute -T -p 443 52.198.55.31 || echo "Traceroute not available or failed"

echo ""
echo "Troubleshooting complete. Please share the full output with support." 