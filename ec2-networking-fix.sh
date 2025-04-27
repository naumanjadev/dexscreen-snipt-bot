#!/bin/bash

echo "=== EC2 Outbound Connectivity Fix Script ==="
echo ""

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run this script with sudo privileges${NC}"
  exit 1
fi

echo -e "${YELLOW}This script will fix common EC2 connectivity issues for accessing external services${NC}"

echo -e "\n${GREEN}Step 1: Adding required DNS entries to /etc/hosts${NC}"
grep -q "pump.fun" /etc/hosts
if [ $? -ne 0 ]; then
  echo "52.198.55.31 socket.pump.fun" >> /etc/hosts
  echo "52.198.55.31 api.pump.fun" >> /etc/hosts
  echo "52.198.55.31 pump.fun" >> /etc/hosts
  echo -e "${GREEN}✓ Added pump.fun entries to /etc/hosts${NC}"
else
  echo -e "${GREEN}✓ pump.fun entries already exist in /etc/hosts${NC}"
fi

echo -e "\n${GREEN}Step 2: Setting up reliable DNS servers${NC}"
# Backup the original resolv.conf
cp /etc/resolv.conf /etc/resolv.conf.backup
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf
echo -e "${GREEN}✓ DNS servers configured to use Google (8.8.8.8) and Cloudflare (1.1.1.1)${NC}"

echo -e "\n${GREEN}Step 3: Configuring iptables to allow all outbound traffic${NC}"
# Clear any existing OUTPUT chain rules
iptables -F OUTPUT
# Allow all loopback traffic
iptables -A OUTPUT -o lo -j ACCEPT
# Allow established connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# Allow all outbound DNS traffic
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow all outbound HTTP/HTTPS traffic
iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
# Allow all other outbound traffic
iptables -A OUTPUT -j ACCEPT

echo -e "${GREEN}✓ Firewall configured to allow all outbound traffic${NC}"

echo -e "\n${GREEN}Step 4: Setting up proper MTU and TCP settings${NC}"
# Adjust MTU to standard value
ip link set dev eth0 mtu 1500

# Optimize TCP settings for better connections
cat > /etc/sysctl.d/99-network-tuning.conf << EOF
# Increase the maximum number of open file descriptors
fs.file-max = 100000

# Increase the maximum TCP buffer sizes
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

# Increase the TCP auto-tuning buffer limits
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Turn on TCP selective acknowledgement
net.ipv4.tcp_sack = 1

# Enable TCP window scaling
net.ipv4.tcp_window_scaling = 1

# Increase the TCP max connections
net.ipv4.tcp_max_syn_backlog = 8192

# Decrease the time default value for tcp_fin_timeout connection
net.ipv4.tcp_fin_timeout = 30

# Decrease the time default value for connections to keep alive
net.ipv4.tcp_keepalive_time = 1200

# Enable fast recycling of TIME_WAIT sockets
net.ipv4.tcp_tw_reuse = 1

# Don't cache ssthresh from previous connection
net.ipv4.tcp_no_metrics_save = 1
EOF

# Apply sysctl settings
sysctl -p /etc/sysctl.d/99-network-tuning.conf
echo -e "${GREEN}✓ Network settings optimized for better connectivity${NC}"

echo -e "\n${GREEN}Step 5: Installing and configuring Cloudflare Warp for improved connectivity${NC}"
if command -v warp-cli >/dev/null 2>&1; then
  echo -e "${YELLOW}Cloudflare Warp is already installed${NC}"
else
  # Check if we're on Ubuntu/Debian
  if command -v apt-get >/dev/null 2>&1; then
    echo -e "${YELLOW}Installing Cloudflare Warp on Ubuntu/Debian...${NC}"
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update
    apt-get install -y cloudflare-warp
  # Check if we're on Amazon Linux/CentOS/RHEL
  elif command -v yum >/dev/null 2>&1; then
    echo -e "${YELLOW}Installing Cloudflare Warp on Amazon Linux/CentOS/RHEL...${NC}"
    rpm -ivh https://pkg.cloudflareclient.com/cloudflare-release-el8.rpm
    yum install -y cloudflare-warp
  else
    echo -e "${RED}Could not determine the package manager. Skipping Warp installation.${NC}"
  fi
fi

# Try to configure and start Warp if installed
if command -v warp-cli >/dev/null 2>&1; then
  warp-cli register
  warp-cli set-mode proxy
  warp-cli connect
  echo -e "${GREEN}✓ Cloudflare Warp configured in proxy mode${NC}"
else
  echo -e "${YELLOW}Skipping Warp configuration as it's not installed${NC}"
fi

echo -e "\n${GREEN}Step 6: Testing connectivity to Pump.fun${NC}"
echo -e "${YELLOW}Testing DNS resolution...${NC}"
host socket.pump.fun
if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ DNS resolution working!${NC}"
else
  echo -e "${RED}✗ DNS resolution failed. Check your DNS configuration.${NC}"
fi

echo -e "\n${YELLOW}Testing HTTP connectivity...${NC}"
curl -s --connect-timeout 10 https://api.pump.fun/health > /dev/null
if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ HTTP connectivity working!${NC}"
else
  echo -e "${RED}✗ HTTP connectivity failed.${NC}"
  
  # Try with insecure option for diagnosis
  echo -e "${YELLOW}Attempting with certificate verification disabled...${NC}"
  curl -sk --connect-timeout 10 https://api.pump.fun/health > /dev/null
  if [ $? -eq 0 ]; then
    echo -e "${YELLOW}Connection works with certificate verification disabled.\nThis suggests a certificate/CA issue.${NC}"
  else
    echo -e "${RED}Connection still failed with certificate verification disabled.\nThis suggests network/routing issues.${NC}"
  fi
fi

echo -e "\n${GREEN}All fixes have been applied!${NC}"
echo -e "${YELLOW}If you're still experiencing issues:${NC}"
echo "1. Make sure your EC2 Security Group allows all outbound traffic"
echo "2. Contact your network administrator if you're behind a corporate proxy/firewall"
echo "3. Try running the detailed diagnostics script: sudo ./pump-fun-troubleshoot.sh"
echo -e "\n${GREEN}After applying these fixes, wait a few minutes and try the /pumpfun_diagnose command again.${NC}" 