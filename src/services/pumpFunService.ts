import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { swapTokens } from './dexService';
import { notifyUserById } from '../bots/telegramBot';
import { getUserWallet, loadUserKeypair } from './walletService';
import axios from 'axios';
import WebSocket from 'ws';
import dns from 'dns';
import { promisify } from 'util';

// Promisify dns.lookup for easier usage
const dnsLookup = promisify(dns.lookup);

// Constants for Pump.fun
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_CURVE_SEED = Buffer.from('bonding-curve');
const PUMP_CURVE_STATE_SIGNATURE = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
const PUMP_CURVE_TOKEN_DECIMALS = 6;
const SOL_MINT = new PublicKey('11111111111111111111111111111111');

// Active listeners by user ID
const activeListeners: Map<number, {
  wsConnection: WebSocket | null;
  intervalId: NodeJS.Timeout | null;
  optimizationIntervalId?: NodeJS.Timeout;
  heartbeatIntervalId?: NodeJS.Timeout;
  lastMessageTimestamp: number;
  connectionHealthCheckId?: NodeJS.Timeout;
  settings: PumpFunSettings;
  status: 'idle' | 'monitoring' | 'trading';
  recentTokens: Set<string>;
  tradeHistory: Array<{
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    action: 'buy' | 'sell';
    amount: number;
    price: number;
    timestamp: number;
    txId?: string;
    boost?: number;
  }>;
}> = new Map();

// Settings interface for Pump.fun trading
export interface PumpFunSettings {
  minBoostAmount: number;   // Minimum boost amount in USD for token to be interesting
  buyAmount: number;        // Amount of SOL to spend per buy
  autoSell: boolean;        // Whether to automatically sell tokens
  profitTarget: number;     // Target profit percentage to trigger sell
  stopLoss: number;         // Stop loss percentage from buy price
  maxHoldTime: number;      // Maximum time to hold a token in seconds
  onlyBuyTokensWithName: string | null; // Only buy tokens with this string in name or symbol
  ignoreTokensWithBoostBelow: number;   // Ignore tokens with boost below this value
  tradingBudget: number;    // Maximum SOL to use for trading
  priorityFee: boolean;     // Whether to use priority fees for transactions
  slippage: number;         // Slippage tolerance percentage
}

// Initialize default settings
const defaultSettings: PumpFunSettings = {
  minBoostAmount: 2.0,
  buyAmount: 0.05,
  autoSell: true,
  profitTarget: 30,
  stopLoss: 15,
  maxHoldTime: 1800, // 30 minutes
  onlyBuyTokensWithName: null,
  ignoreTokensWithBoostBelow: 2.0,  // Increased from 1.0 to 2.0 for better token quality
  tradingBudget: 0.5,
  priorityFee: true,
  slippage: 1.0
};

// Pump.fun bonding curve state interface
interface PumpCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

// Token metadata interface
interface TokenMetadata {
  name: string;
  symbol: string;
  image?: string;
  description?: string;
}

// New interface for performance tracking
interface PerformanceMetrics {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  profitableTrades: number;
  totalProfit: number;
  averageProfit: number;
  averageHoldTime: number;
  winRate: number;
  bestToken: string;
  bestProfitPercent: number;
}

// Helper functions for buffer reading
function readBytes(buf: Buffer, offset: number, length: number): Buffer {
  const end = offset + length;
  if (buf.byteLength < end) throw new RangeError("range out of bounds");
  return buf.subarray(offset, end);
}

function readBigUintLE(buf: Buffer, offset: number, length: number): bigint {
  switch (length) {
    case 1: return BigInt(buf.readUint8(offset));
    case 2: return BigInt(buf.readUint16LE(offset));
    case 4: return BigInt(buf.readUint32LE(offset));
    case 8: return buf.readBigUint64LE(offset);
  }
  throw new Error(`unsupported data size (${length} bytes)`);
}

function readBoolean(buf: Buffer, offset: number, length: number): boolean {
  const data = readBytes(buf, offset, length);
  for (const b of data) {
    if (b) return true;
  }
  return false;
}

/**
 * Find the bonding curve address for a Pump.fun token
 * @param tokenMint The token mint address
 * @returns The bonding curve address
 */
function findPumpCurveAddress(tokenMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([
    PUMP_CURVE_SEED,
    tokenMint.toBuffer()
  ], PUMP_PROGRAM_ID)[0];
}

/**
 * Get the state of a Pump.fun bonding curve
 * @param connection Solana connection
 * @param curveAddress Bonding curve address
 * @returns The bonding curve state
 */
async function getPumpCurveState(connection: Connection, curveAddress: PublicKey): Promise<PumpCurveState> {
  try {
    const response = await connection.getAccountInfo(curveAddress);
    if (!response || !response.data || response.data.byteLength < PUMP_CURVE_STATE_SIGNATURE.byteLength + 0x29) {
      throw new Error("Unexpected curve state data structure");
    }

    const idlSignature = readBytes(response.data, 0, PUMP_CURVE_STATE_SIGNATURE.byteLength);
    if (Buffer.compare(idlSignature, Buffer.from(PUMP_CURVE_STATE_SIGNATURE)) !== 0) {
      throw new Error("Unexpected curve state IDL signature");
    }

    return {
      virtualTokenReserves: readBigUintLE(response.data, 0x08, 8),
      virtualSolReserves: readBigUintLE(response.data, 0x10, 8),
      realTokenReserves: readBigUintLE(response.data, 0x18, 8),
      realSolReserves: readBigUintLE(response.data, 0x20, 8),
      tokenTotalSupply: readBigUintLE(response.data, 0x28, 8),
      complete: readBoolean(response.data, 0x30, 1)
    };
  } catch (error: any) {
    logger.error(`Error fetching Pump.fun curve state: ${error.message}`);
    throw error;
  }
}

/**
 * Calculate the token price (in SOL) based on the bonding curve state
 * @param curveState The bonding curve state
 * @returns The token price in SOL
 */
function calculatePumpCurvePrice(curveState: PumpCurveState): number {
  if (curveState.virtualTokenReserves <= 0n || curveState.virtualSolReserves <= 0n) {
    throw new RangeError("Curve state contains invalid reserve data");
  }

  return (Number(curveState.virtualSolReserves) / LAMPORTS_PER_SOL) / 
         (Number(curveState.virtualTokenReserves) / (10 ** PUMP_CURVE_TOKEN_DECIMALS));
}

/**
 * Calculate the bonding curve progress percentage
 * @param curveState The bonding curve state
 * @returns The progress percentage (0-100)
 */
function calculateBondingCurveProgress(curveState: PumpCurveState): number {
  // Formula: BondingCurveProgress = 100 - ((leftTokens * 100) / initialRealTokenReserves)
  const INITIAL_REAL_TOKEN_RESERVES = 793100000000000n;
  
  if (curveState.realTokenReserves >= INITIAL_REAL_TOKEN_RESERVES) {
    return 0;
  }
  
  return 100 - (Number(curveState.realTokenReserves * 10000n / INITIAL_REAL_TOKEN_RESERVES) / 100);
}

/**
 * Fetch token metadata from Solana
 * @param connection Solana connection
 * @param tokenMint Token mint address
 * @returns Token metadata
 */
async function fetchTokenMetadata(tokenMint: string): Promise<TokenMetadata> {
  try {
    // First try to fetch from the blockchain directly
    const response = await axios.get(`https://api.mainnet-beta.solana.com`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [
          tokenMint,
          { "encoding": "jsonParsed" }
        ]
      })
    });

    if (response.data && response.data.result && response.data.result.value) {
      const tokenData = response.data.result.value;
      if (tokenData.data.parsed && tokenData.data.parsed.info) {
        const info = tokenData.data.parsed.info;
        return {
          name: info.name || 'Unknown',
          symbol: info.symbol || 'UNKNOWN',
        };
      }
    }

    // If that fails, fallback to Jupiter API for token info
    const jupiterResponse = await axios.get(`https://token.jup.ag/all`);
    if (jupiterResponse.data && Array.isArray(jupiterResponse.data)) {
      const tokenInfo = jupiterResponse.data.find(
        (token: any) => token.address === tokenMint
      );
      
      if (tokenInfo) {
        return {
          name: tokenInfo.name || 'Unknown',
          symbol: tokenInfo.symbol || 'UNKNOWN',
          image: tokenInfo.logoURI,
          description: tokenInfo.description
        };
      }
    }

    // Default fallback
    return {
      name: 'Unknown Token',
      symbol: 'UNKNOWN'
    };
  } catch (error: any) {
    logger.error(`Error fetching token metadata: ${error.message}`);
    return {
      name: 'Unknown Token',
      symbol: 'UNKNOWN'
    };
  }
}

/**
 * Connect to Pump.fun WebSocket to listen for new tokens
 * @param userId The user ID
 * @returns A promise that resolves when connected
 */
async function connectToPumpFunWebSocket(userId: number): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("No active listener found for user");
  }

  try {
    // Close existing connection if any
    if (listener.wsConnection) {
      listener.wsConnection.close();
    }

    // Clear any existing heartbeat interval
    if (listener.heartbeatIntervalId) {
      clearInterval(listener.heartbeatIntervalId);
      listener.heartbeatIntervalId = undefined;
    }

    // Clear any existing health check interval
    if (listener.connectionHealthCheckId) {
      clearInterval(listener.connectionHealthCheckId);
      listener.connectionHealthCheckId = undefined;
    }

    // Try multiple connection endpoints in case one fails
    const endpoints = [
      'wss://socket.pump.fun/socket',
      'wss://api.pump.fun/socket',
      'wss://www.pump.fun/socket',
      'wss://pump.fun/socket',
      'wss://socket.pump.fun:443/socket' // Try explicitly setting port 443
    ];
    
    let connected = false;
    let lastError = null;
    
    // Try each endpoint until one succeeds
    for (const endpoint of endpoints) {
      if (connected) break;
      
      try {
        logger.info(`Attempting to connect to ${endpoint} for user ${userId}`);
        const ws = new WebSocket(endpoint, {
          handshakeTimeout: 10000, // 10 seconds timeout for handshake
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          // Force IPv4 if needed
          // family: 4
        });
        
        // Create a promise that resolves on connection or rejects on error
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
            ws.terminate();
          }, 15000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            resolve(true);
          });
          
          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        
        // If we get here, connection succeeded
        connected = true;
        
        // Update last message timestamp
        listener.lastMessageTimestamp = Date.now();
        
        // Setup event handlers
        ws.on('open', () => {
          logger.info(`WebSocket connection opened for user ${userId} at ${endpoint}`);
          notifyUserById(userId, `🔌 Connected to Pump.fun WebSocket API`);
          
          // Subscribe to new token events
          ws.send(JSON.stringify({
            type: 'subscribe',
            channel: 'tokens:new'
          }));

          // Setup heartbeat ping to keep connection alive (every 30 seconds)
          listener.heartbeatIntervalId = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              logger.debug(`Sending heartbeat ping for user ${userId}`);
              ws.ping();
              
              // Also send subscription message periodically to keep connection active
              try {
                ws.send(JSON.stringify({ 
                  type: 'ping',
                  timestamp: Date.now()
                }));
              } catch (err: any) {
                logger.warn(`Error sending heartbeat message: ${err.message}`);
              }
            }
          }, 30000);

          // Setup health check to detect stale connections (check every minute)
          listener.connectionHealthCheckId = setInterval(() => {
            const now = Date.now();
            const minutesSinceLastMessage = (now - listener.lastMessageTimestamp) / (1000 * 60);
            
            // If no message received for 5 minutes, consider connection stale
            if (minutesSinceLastMessage > 5) {
              logger.warn(`No messages received for ${minutesSinceLastMessage.toFixed(1)} minutes for user ${userId}. Reconnecting...`);
              
              // Notify user of stale connection
              notifyUserById(userId, `⚠️ No messages received from Pump.fun for ${minutesSinceLastMessage.toFixed(0)} minutes. Reconnecting...`);
              
              // Force reconnection
              ws.terminate();
              
              // Reconnect with slight delay
              setTimeout(() => {
                if (activeListeners.has(userId)) {
                  connectToPumpFunWebSocket(userId);
                }
              }, 1000);
            }
          }, 60000);
        });

        ws.on('message', async (data: WebSocket.Data) => {
          try {
            // Update last message timestamp
            listener.lastMessageTimestamp = Date.now();
            
            const message = JSON.parse(data.toString());
            
            // Check if it's a new token event
            if (message.type === 'new_token' && message.data && message.data.mint) {
              const tokenMint = message.data.mint;
              
              // Skip if we've already seen this token
              if (listener.recentTokens.has(tokenMint)) {
                return;
              }
              
              // Add to recent tokens set
              listener.recentTokens.add(tokenMint);
              
              // Process the new token
              await processNewToken(userId, tokenMint);
            }
            // We also handle pong responses to update timestamps
            else if (message.type === 'pong' || message.type === 'ping') {
              logger.debug(`Received ${message.type} from server for user ${userId}`);
            }
          } catch (error: any) {
            logger.error(`Error processing WebSocket message: ${error.message}`);
          }
        });

        // Handle pong responses
        ws.on('pong', () => {
          // Update last message timestamp
          listener.lastMessageTimestamp = Date.now();
          logger.debug(`Received pong from server for user ${userId}`);
        });

        ws.on('error', (error) => {
          logger.error(`WebSocket error for user ${userId}: ${error.message}`);
          notifyUserById(userId, `⚠️ WebSocket connection error: ${error.message}`);
          
          // Attempt to reconnect after a delay
          setTimeout(() => {
            if (activeListeners.has(userId)) {
              connectToPumpFunWebSocket(userId);
            }
          }, 5000);
        });

        ws.on('close', () => {
          logger.info(`WebSocket connection closed for user ${userId}`);
          
          // Clear heartbeat interval
          if (listener.heartbeatIntervalId) {
            clearInterval(listener.heartbeatIntervalId);
            listener.heartbeatIntervalId = undefined;
          }
          
          // Clear health check interval
          if (listener.connectionHealthCheckId) {
            clearInterval(listener.connectionHealthCheckId);
            listener.connectionHealthCheckId = undefined;
          }
          
          // Attempt to reconnect after a delay, but only if it wasn't terminated by user action
          setTimeout(() => {
            if (activeListeners.has(userId)) {
              connectToPumpFunWebSocket(userId);
            }
          }, 5000);
        });

        // Save the WebSocket connection
        listener.wsConnection = ws;
        
      } catch (error: any) {
        // Log the error but continue to try other endpoints
        lastError = error;
        logger.warn(`Failed to connect to ${endpoint}: ${error.message}`);
      }
    }
    
    // If we couldn't connect to any endpoint, throw the last error
    if (!connected && lastError) {
      throw lastError;
    }
    
  } catch (error: any) {
    logger.error(`Error setting up WebSocket for user ${userId}: ${error.message}`);
    notifyUserById(userId, `⚠️ Could not connect to Pump.fun. Please try again later or check if service is available.`);
    
    // Set a retry after some time
    setTimeout(() => {
      if (activeListeners.has(userId)) {
        connectToPumpFunWebSocket(userId);
      }
    }, 30000); // Retry after 30 seconds
  }
}

/**
 * Process a new token from Pump.fun
 * @param userId The user ID
 * @param tokenMint The token mint address
 */
async function processNewToken(userId: number, tokenMint: string): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return;
  }

  try {
    // Create Solana connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    
    // Get token metadata
    const metadata = await fetchTokenMetadata(tokenMint);
    
    // Get bonding curve data
    const curveAddress = findPumpCurveAddress(new PublicKey(tokenMint));
    const curveState = await getPumpCurveState(connection, curveAddress);
    
    // Calculate key metrics
    const tokenPrice = calculatePumpCurvePrice(curveState);
    const bondingProgress = calculateBondingCurveProgress(curveState);
    
    // Get boost amount (approximation based on recent transactions)
    let boostAmount = 0;
    let liquidityUsd = 0;
    let priceChange = 0;
    
    try {
      const boostResponse = await axios.get(`https://api.dexscreener.com/token-boosts/latest/v1/solana/${tokenMint}`);
      if (boostResponse.data && boostResponse.data.totalAmount) {
        boostAmount = boostResponse.data.totalAmount;
      }
      
      // Try to get liquidity information from DexScreener
      const pairInfoResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
      if (pairInfoResponse.data && pairInfoResponse.data.pairs && pairInfoResponse.data.pairs.length > 0) {
        const pairInfo = pairInfoResponse.data.pairs[0];
        if (pairInfo.liquidity && pairInfo.liquidity.usd) {
          liquidityUsd = pairInfo.liquidity.usd;
        }
        if (pairInfo.priceChange && pairInfo.priceChange.h1) {
          priceChange = pairInfo.priceChange.h1;
        }
      }
    } catch (error) {
      // Silently fail if APIs are unavailable
    }
    
    // Check if the token meets our criteria for notification
    const shouldNotify = boostAmount >= listener.settings.ignoreTokensWithBoostBelow;
    const matchesFilter = !listener.settings.onlyBuyTokensWithName || 
                         metadata.name.toLowerCase().includes(listener.settings.onlyBuyTokensWithName.toLowerCase()) ||
                         metadata.symbol.toLowerCase().includes(listener.settings.onlyBuyTokensWithName.toLowerCase());
    
    if (shouldNotify && matchesFilter) {
      // Format the notification message with enhanced details
      const message = `🚀 <b>New Token Detected!</b>\n\n` +
                     `<b>Name:</b> ${metadata.name}\n` +
                     `<b>Symbol:</b> ${metadata.symbol}\n` +
                     `<b>Address:</b> <code>${tokenMint}</code>\n` +
                     `<b>Price:</b> ${tokenPrice.toFixed(8)} SOL\n` +
                     `<b>Bonding Progress:</b> ${bondingProgress.toFixed(2)}%\n` +
                     `<b>Boost Amount:</b> $${boostAmount.toFixed(2)}\n` +
                     (liquidityUsd > 0 ? `<b>Liquidity:</b> $${liquidityUsd.toFixed(2)}\n` : '') +
                     (priceChange !== 0 ? `<b>1h Change:</b> ${priceChange.toFixed(2)}%\n` : '') + 
                     `\n`;
      
      await notifyUserById(userId, message);
      
      // Enhanced buy decision with liquidity check
      const hasMinimumLiquidity = liquidityUsd >= 25000 || liquidityUsd === 0; // If we can't get liquidity data, proceed anyway
      const hasPositiveTrend = priceChange >= -5; // Not falling rapidly
      
      // Check if we should auto-buy this token with enhanced criteria
      const shouldBuy = boostAmount >= listener.settings.minBoostAmount && 
                        listener.status === 'trading' &&
                        matchesFilter &&
                        hasMinimumLiquidity &&
                        hasPositiveTrend;
      
      if (shouldBuy) {
        await buyToken(userId, tokenMint, metadata.name, metadata.symbol);
      } else if (listener.status === 'trading' && boostAmount >= listener.settings.minBoostAmount) {
        // If we're in trading mode but didn't buy, explain why
        let reasonMessage = `⚠️ <b>Auto-buy skipped for ${metadata.symbol}</b>\n\n`;
        if (!hasMinimumLiquidity) {
          reasonMessage += `- Insufficient liquidity ($${liquidityUsd.toFixed(2)})\n`;
        }
        if (!hasPositiveTrend && priceChange !== 0) {
          reasonMessage += `- Negative price trend (${priceChange.toFixed(2)}%)\n`;
        }
        await notifyUserById(userId, reasonMessage);
      }
    }
  } catch (error: any) {
    logger.error(`Error processing new token ${tokenMint} for user ${userId}: ${error.message}`);
  }
}

/**
 * Buy a Pump.fun token
 * @param userId The user ID
 * @param tokenMint The token mint address
 * @param tokenName The token name
 * @param tokenSymbol The token symbol
 */
async function buyToken(userId: number, tokenMint: string, tokenName: string, tokenSymbol: string): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("No active listener found for user");
  }

  try {
    // Get user wallet
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      throw new Error("User wallet not found");
    }
    
    // Load keypair
    const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    
    // Create connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    
    // Get the token price before buying
    const curveAddress = findPumpCurveAddress(new PublicKey(tokenMint));
    const curveState = await getPumpCurveState(connection, curveAddress);
    const tokenPrice = calculatePumpCurvePrice(curveState);
    
    // Prepare buy parameters
    const buyAmount = listener.settings.buyAmount;
    const mintPublicKey = new PublicKey(tokenMint);
    
    // Execute the swap (SOL to token)
    const result = await swapTokens({
      connection,
      walletKeypair: keypair,
      sourceTokenMint: SOL_MINT,
      destinationTokenMint: mintPublicKey,
      amountInLamports: Math.floor(buyAmount * LAMPORTS_PER_SOL),
      slippage: listener.settings.slippage,
      priorityFee: listener.settings.priorityFee
    });
    
    if (result.success) {
      // Record the trade
      listener.tradeHistory.push({
        tokenAddress: tokenMint,
        tokenName,
        tokenSymbol,
        action: 'buy',
        amount: buyAmount,
        price: tokenPrice,
        timestamp: Date.now(),
        txId: result.txId,
        boost: result.boost
      });
      
      // Notify user
      const message = `✅ <b>Buy Successful!</b>\n\n` +
                      `<b>Token:</b> ${tokenName} (${tokenSymbol})\n` +
                      `<b>Amount:</b> ${buyAmount} SOL\n` +
                      `<b>Price:</b> ${tokenPrice.toFixed(8)} SOL\n` +
                      `<b>Transaction:</b> <a href="https://solscan.io/tx/${result.txId}">View on Solscan</a>\n\n`;
      
      await notifyUserById(userId, message);
      
      // Set up automatic monitoring for sell conditions if enabled
      if (listener.settings.autoSell) {
        setupTokenMonitoring(userId, tokenMint, tokenName, tokenSymbol, tokenPrice);
      }
    } else {
      logger.error(`Buy failed for token ${tokenMint}: ${result.error}`);
      await notifyUserById(userId, `❌ Buy failed for ${tokenSymbol}: ${result.error}`);
    }
  } catch (error: any) {
    logger.error(`Error buying token ${tokenMint} for user ${userId}: ${error.message}`);
    await notifyUserById(userId, `❌ Error buying token: ${error.message}`);
  }
}

/**
 * Set up monitoring for a token to check sell conditions
 * @param userId The user ID
 * @param tokenMint The token mint address
 * @param tokenName The token name
 * @param tokenSymbol The token symbol
 * @param buyPrice The price at which the token was bought
 */
function setupTokenMonitoring(
  userId: number, 
  tokenMint: string, 
  tokenName: string, 
  tokenSymbol: string, 
  buyPrice: number
): void {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return;
  }

  // Create a dedicated interval for this token
  const monitoringInterval = setInterval(async () => {
    try {
      // Create connection
      const connection = new Connection(config.solanaRpcUrl, 'confirmed');
      
      // Get current price
      const curveAddress = findPumpCurveAddress(new PublicKey(tokenMint));
      const curveState = await getPumpCurveState(connection, curveAddress);
      const currentPrice = calculatePumpCurvePrice(curveState);
      const bondingProgress = calculateBondingCurveProgress(curveState);
      
      // Calculate price change percentage
      const priceChangePercent = ((currentPrice - buyPrice) / buyPrice) * 100;
      
      // Check sell conditions:
      // 1. Profit target reached
      // 2. Stop loss triggered
      // 3. Bonding curve near completion (>95%)
      // 4. Max hold time exceeded
      const buyTimestamp = listener.tradeHistory.find(
        trade => trade.tokenAddress === tokenMint && trade.action === 'buy'
      )?.timestamp || Date.now();
      
      const timeSinceBuy = (Date.now() - buyTimestamp) / 1000; // in seconds
      
      const shouldSell = 
        priceChangePercent >= listener.settings.profitTarget || // profit target
        priceChangePercent <= -listener.settings.stopLoss || // stop loss
        bondingProgress >= 95 || // near bonding curve completion
        timeSinceBuy >= listener.settings.maxHoldTime; // max hold time
      
      if (shouldSell) {
        // Stop monitoring
        clearInterval(monitoringInterval);
        
        // Execute sell
        await sellToken(userId, tokenMint, tokenName, tokenSymbol, currentPrice, priceChangePercent);
      }
    } catch (error: any) {
      logger.error(`Error monitoring token ${tokenMint} for user ${userId}: ${error.message}`);
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Sell a Pump.fun token
 * @param userId The user ID
 * @param tokenMint The token mint address
 * @param tokenName The token name
 * @param tokenSymbol The token symbol
 * @param currentPrice The current token price
 * @param priceChangePercent The price change percentage since buying
 */
async function sellToken(
  userId: number, 
  tokenMint: string, 
  tokenName: string, 
  tokenSymbol: string,
  currentPrice: number,
  priceChangePercent: number
): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("No active listener found for user");
  }

  try {
    // Get user wallet
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      throw new Error("User wallet not found");
    }
    
    // Load keypair
    const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    
    // Create connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    
    // Get token balance
    const tokenPublicKey = new PublicKey(tokenMint);

    // Determine sell percentage based on profit level for scaled selling
    let sellPercentage = 100; // Default to 100% (sell all)
    let sellReason = '';
    
    // For profit-based sells, scale the percentage
    if (priceChangePercent >= listener.settings.profitTarget) {
      sellReason = 'Profit target reached';
      
      // Implement scaled selling based on profit level
      if (priceChangePercent >= 50) {
        // For 50%+ profit, sell 90% (keep small moonbag)
        sellPercentage = 90;
      } else if (priceChangePercent >= 30) {
        // For 30-50% profit, sell 75%
        sellPercentage = 75;
      } else if (priceChangePercent >= 15) {
        // For 15-30% profit, sell 50%
        sellPercentage = 50;
      } else if (priceChangePercent >= 5) {
        // For 5-15% profit, sell 25%
        sellPercentage = 25;
      }
    } else if (priceChangePercent <= -listener.settings.stopLoss) {
      sellReason = 'Stop loss triggered';
      sellPercentage = 100; // Sell 100% for stop loss
    } else {
      // Check other conditions
      const buyTimestamp = listener.tradeHistory.find(
        trade => trade.tokenAddress === tokenMint && trade.action === 'buy'
      )?.timestamp || Date.now();
      
      const timeSinceBuy = (Date.now() - buyTimestamp) / 1000; // in seconds
      
      if (timeSinceBuy >= listener.settings.maxHoldTime) {
        sellReason = 'Maximum hold time exceeded';
        sellPercentage = 100;
      } else {
        sellReason = 'Bonding curve near completion';
        sellPercentage = 100;
      }
    }
    
    // Execute the swap (token to SOL) with the calculated sell percentage
    const result = await swapTokens({
      connection,
      walletKeypair: keypair,
      sourceTokenMint: tokenPublicKey,
      destinationTokenMint: SOL_MINT,
      amountInLamports: 0, // When selling, 0 means sell all and will be replaced by percentage calculation
      sellPercentage: sellPercentage, // Pass the calculated percentage
      slippage: listener.settings.slippage,
      priorityFee: listener.settings.priorityFee
    });
    
    if (result.success) {
      // Record the trade
      listener.tradeHistory.push({
        tokenAddress: tokenMint,
        tokenName,
        tokenSymbol,
        action: 'sell',
        amount: 0, // Sold based on percentage
        price: currentPrice,
        timestamp: Date.now(),
        txId: result.txId
      });
      
      // Notify user with enhanced details
      const message = `💰 <b>Sell ${sellPercentage === 100 ? 'Complete' : `${sellPercentage}%`}!</b>\n\n` +
                      `<b>Token:</b> ${tokenName} (${tokenSymbol})\n` +
                      `<b>Price:</b> ${currentPrice.toFixed(8)} SOL\n` +
                      `<b>Price Change:</b> ${priceChangePercent.toFixed(2)}%\n` +
                      `<b>Reason:</b> ${sellReason}\n` +
                      `<b>Sell Percentage:</b> ${sellPercentage}%\n` +
                      `<b>Transaction:</b> <a href="https://solscan.io/tx/${result.txId}">View on Solscan</a>\n\n`;
      
      await notifyUserById(userId, message);
    } else {
      logger.error(`Sell failed for token ${tokenMint}: ${result.error}`);
      await notifyUserById(userId, `❌ Sell failed for ${tokenSymbol}: ${result.error}`);
    }
  } catch (error: any) {
    logger.error(`Error selling token ${tokenMint} for user ${userId}: ${error.message}`);
    await notifyUserById(userId, `❌ Error selling token: ${error.message}`);
  }
}

/**
 * Check if pump.fun services are reachable
 * @returns A boolean indicating whether the service is reachable
 */
async function isPumpFunReachable(): Promise<boolean> {
  try {
    // First, try to resolve the domain
    try {
      await dnsLookup('socket.pump.fun');
      logger.info('Domain socket.pump.fun successfully resolved');
    } catch (error: any) {
      logger.warn('Cannot resolve socket.pump.fun domain, will try alternative domains');
      
      // Try alternative domains
      try {
        await dnsLookup('api.pump.fun');
        logger.info('Domain api.pump.fun successfully resolved');
      } catch (error: any) {
        try {
          await dnsLookup('pump.fun');
          logger.info('Domain pump.fun successfully resolved');
        } catch (error: any) {
          logger.error('All pump.fun domains failed to resolve');
          return false;
        }
      }
    }
    
    // Then try to connect to the API to check if service is up
    try {
      const response = await axios.get('https://pump.fun/api/health', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        logger.info('Pump.fun API is reachable');
        return true;
      }
    } catch (error: any) {
      logger.warn('Could not connect to Pump.fun API health endpoint');
    }
    
    // If API health check fails, try a simple HTTP request
    try {
      const response = await axios.get('https://pump.fun', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        logger.info('Pump.fun website is reachable');
        return true;
      }
    } catch (error: any) {
      logger.error('Could not connect to Pump.fun website');
    }
    
    return false;
  } catch (error: any) {
    logger.error(`Error checking Pump.fun reachability: ${error.message}`);
    return false;
  }
}

/**
 * Verify wallet has enough funds before trading
 * @param userId The user ID
 * @returns A promise that resolves with a boolean indicating if wallet has sufficient funds
 */
async function verifyWalletForTrading(userId: number): Promise<boolean> {
  try {
    // Get user wallet
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`No wallet found for user ${userId}`);
      return false;
    }
    
    // Load keypair
    const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    
    // Create connection
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    
    // Get wallet balance
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL;
    
    // Get settings
    const listener = activeListeners.get(userId);
    if (!listener) {
      logger.error(`No active listener for user ${userId}`);
      return false;
    }
    
    // Check if balance is sufficient for at least one buy
    const requiredBalance = listener.settings.buyAmount * 1.1; // Add 10% for fees
    
    if (balanceInSol < requiredBalance) {
      logger.warn(`Insufficient balance for user ${userId}. Has ${balanceInSol} SOL, needs ${requiredBalance} SOL`);
      notifyUserById(userId, `⚠️ Your wallet balance (${balanceInSol.toFixed(4)} SOL) is insufficient for trading. You need at least ${requiredBalance.toFixed(4)} SOL to trade.`);
      return false;
    }
    
    logger.info(`Wallet verified for user ${userId}. Balance: ${balanceInSol} SOL`);
    return true;
  } catch (error: any) {
    logger.error(`Error verifying wallet for user ${userId}: ${error.message}`);
    return false;
  }
}

// Modify startPumpFunListener to include wallet verification
export async function startPumpFunListener(userId: number, settings?: Partial<PumpFunSettings>): Promise<void> {
  // Check if pump.fun is reachable
  const isReachable = await isPumpFunReachable();
  
  if (!isReachable) {
    logger.error(`Cannot start Pump.fun listener for user ${userId} - service unreachable`);
    throw new Error('Cannot connect to Pump.fun service. Please check your internet connection or try again later.');
  }
  
  // Verify wallet exists
  const userWallet = await getUserWallet(userId);
  if (!userWallet) {
    logger.error(`No wallet found for user ${userId} when starting Pump.fun listener`);
    throw new Error('You need to set up a wallet first. Use /wallet to create one.');
  }
  
  // Stop existing listener if any
  stopPumpFunListener(userId);
  
  // Create new listener with merged settings
  const listenerSettings = {
    ...defaultSettings,
    ...settings
  };
  
  // Create and store the listener
  activeListeners.set(userId, {
    wsConnection: null,
    intervalId: null,
    lastMessageTimestamp: Date.now(),
    settings: listenerSettings,
    status: 'monitoring', // Start in monitoring mode
    recentTokens: new Set<string>(),
    tradeHistory: []
  });
  
  // Connect to WebSocket
  await connectToPumpFunWebSocket(userId);
  
  // Notify user
  await notifyUserById(userId, `🎧 Pump.fun listener started. Monitoring for new tokens with boost ≥ $${listenerSettings.ignoreTokensWithBoostBelow}.`);
  
  logger.info(`Started Pump.fun listener for user ${userId}`);
}

// Modify startPumpFunTrading to include wallet verification
export async function startPumpFunTrading(userId: number): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("Please start the listener first with /start_pumpfun");
  }
  
  // Verify wallet has sufficient funds
  const walletValid = await verifyWalletForTrading(userId);
  if (!walletValid) {
    throw new Error("Your wallet doesn't have sufficient funds to start trading. Please add SOL to your wallet and try again.");
  }
  
  // Update status to trading
  listener.status = 'trading';
  
  // Setup auto-optimization
  setupAutoOptimization(userId);
  
  // Notify user
  await notifyUserById(userId, `🤖 Pump.fun trading bot activated! Will automatically buy new tokens with boost ≥ $${listener.settings.minBoostAmount} using ${listener.settings.buyAmount} SOL per trade.\n\nAuto-optimization is enabled and will adjust your settings after 5+ trades.`);
  
  logger.info(`Started Pump.fun trading for user ${userId}`);
}

// Enhance stopPumpFunListener to clean up all intervals
export function stopPumpFunListener(userId: number): void {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return;
  }
  
  // Close WebSocket connection
  if (listener.wsConnection) {
    listener.wsConnection.close();
  }
  
  // Clear all intervals
  if (listener.intervalId) {
    clearInterval(listener.intervalId);
  }
  
  if (listener.optimizationIntervalId) {
    clearInterval(listener.optimizationIntervalId);
  }
  
  if (listener.heartbeatIntervalId) {
    clearInterval(listener.heartbeatIntervalId);
  }
  
  if (listener.connectionHealthCheckId) {
    clearInterval(listener.connectionHealthCheckId);
  }
  
  // Remove listener
  activeListeners.delete(userId);
  
  logger.info(`Stopped Pump.fun listener for user ${userId}`);
}

/**
 * Update Pump.fun listener settings
 * @param userId The user ID
 * @param settings New settings
 */
export function updatePumpFunSettings(userId: number, settings: Partial<PumpFunSettings>): void {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("Listener not active");
  }
  
  // Update settings
  listener.settings = {
    ...listener.settings,
    ...settings
  };
  
  logger.info(`Updated Pump.fun settings for user ${userId}`);
}

/**
 * Get current Pump.fun settings
 * @param userId The user ID
 * @returns The current settings
 */
export function getPumpFunSettings(userId: number): PumpFunSettings | null {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return null;
  }
  
  return listener.settings;
}

/**
 * Check if Pump.fun listener is active
 * @param userId The user ID
 * @returns Whether the listener is active
 */
export function isPumpFunListenerActive(userId: number): boolean {
  return activeListeners.has(userId);
}

/**
 * Get Pump.fun listener status
 * @param userId The user ID
 * @returns The listener status
 */
export function getPumpFunListenerStatus(userId: number): 'idle' | 'monitoring' | 'trading' | null {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return null;
  }
  
  return listener.status;
}

/**
 * Get trading history for a user
 * @param userId The user ID
 * @returns Array of trade history items
 */
export function getPumpFunTradingHistory(userId: number): Array<{
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  action: 'buy' | 'sell';
  amount: number;
  price: number;
  timestamp: number;
  txId?: string;
  boost?: number;
}> | null {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return null;
  }
  
  return [...listener.tradeHistory];
}

// Performance optimization system
function analyzePerformance(userId: number): PerformanceMetrics {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("No active listener found for user");
  }

  const history = listener.tradeHistory;
  const buyTrades = history.filter(trade => trade.action === 'buy');
  const sellTrades = history.filter(trade => trade.action === 'sell');
  
  // Initialize metrics
  const metrics: PerformanceMetrics = {
    totalTrades: buyTrades.length,
    successfulTrades: 0,
    failedTrades: 0,
    profitableTrades: 0,
    totalProfit: 0,
    averageProfit: 0,
    averageHoldTime: 0,
    winRate: 0,
    bestToken: '',
    bestProfitPercent: 0
  };
  
  // Map to track completed trades (buy+sell pairs)
  const completedTrades: Map<string, {
    buyPrice: number;
    sellPrice: number;
    profit: number;
    profitPercent: number;
    buyTime: number;
    sellTime: number;
    tokenName: string;
  }> = new Map();
  
  // Match buys with sells
  for (const buy of buyTrades) {
    const matchingSell = sellTrades.find(sell => sell.tokenAddress === buy.tokenAddress);
    if (matchingSell) {
      const profit = (matchingSell.price - buy.price) / buy.price * 100;
      const holdTime = (matchingSell.timestamp - buy.timestamp) / 1000; // seconds
      
      completedTrades.set(buy.tokenAddress, {
        buyPrice: buy.price,
        sellPrice: matchingSell.price,
        profit: matchingSell.price - buy.price,
        profitPercent: profit,
        buyTime: buy.timestamp,
        sellTime: matchingSell.timestamp,
        tokenName: buy.tokenName
      });
      
      // Update metrics
      metrics.successfulTrades++;
      if (profit > 0) {
        metrics.profitableTrades++;
        metrics.totalProfit += profit;
      }
      
      // Track best performing token
      if (profit > metrics.bestProfitPercent) {
        metrics.bestProfitPercent = profit;
        metrics.bestToken = buy.tokenName;
      }
    }
  }
  
  // Calculate averages
  if (metrics.successfulTrades > 0) {
    metrics.averageProfit = metrics.totalProfit / metrics.successfulTrades;
    metrics.winRate = (metrics.profitableTrades / metrics.successfulTrades) * 100;
    
    // Calculate average hold time
    let totalHoldTime = 0;
    completedTrades.forEach(trade => {
      totalHoldTime += (trade.sellTime - trade.buyTime) / 1000;
    });
    metrics.averageHoldTime = totalHoldTime / metrics.successfulTrades;
  }
  
  metrics.failedTrades = metrics.totalTrades - metrics.successfulTrades;
  
  return metrics;
}

/**
 * Automatically optimize trading settings based on performance
 */
export async function autoOptimizeSettings(userId: number): Promise<void> {
  try {
    const listener = activeListeners.get(userId);
    if (!listener || listener.tradeHistory.length < 5) {
      return; // Not enough data to optimize
    }
    
    const metrics = analyzePerformance(userId);
    
    // Only optimize if we have enough completed trades
    if (metrics.successfulTrades < 3) {
      return;
    }
    
    const currentSettings = listener.settings;
    let newSettings: Partial<PumpFunSettings> = {};
    
    // Optimize profit target based on average profit
    if (metrics.averageProfit > 0) {
      // If we're consistently hitting higher than our target, increase it slightly
      if (metrics.averageProfit > currentSettings.profitTarget * 1.5) {
        newSettings.profitTarget = Math.min(100, Math.round(metrics.averageProfit * 0.9));
      } 
      // If we're consistently selling below our target, lower it to be more realistic
      else if (metrics.averageProfit < currentSettings.profitTarget * 0.5 && metrics.successfulTrades > 5) {
        newSettings.profitTarget = Math.max(10, Math.round(metrics.averageProfit * 1.2));
      }
    }
    
    // Optimize stop loss based on win rate
    if (metrics.winRate < 40 && currentSettings.stopLoss > 10) {
      // If win rate is low, tighten stop loss
      newSettings.stopLoss = Math.max(5, currentSettings.stopLoss - 5);
    } else if (metrics.winRate > 70 && currentSettings.stopLoss < 25) {
      // If win rate is high, we can risk a bit more
      newSettings.stopLoss = Math.min(30, currentSettings.stopLoss + 3);
    }
    
    // Optimize max hold time based on average hold time
    if (metrics.averageHoldTime > 0) {
      const optimalHoldTime = Math.round(metrics.averageHoldTime * 1.5);
      if (Math.abs(optimalHoldTime - currentSettings.maxHoldTime) > 300) { // If difference is > 5 minutes
        newSettings.maxHoldTime = Math.min(3600, Math.max(300, optimalHoldTime));
      }
    }
    
    // Define sellTrades - all sell trades from user's history
    const sellTrades = listener.tradeHistory.filter(trade => trade.action === 'sell');
    
    // Optimize minimum boost amount based on successful trades
    const successfulBoosts = listener.tradeHistory
      .filter(trade => trade.action === 'buy' && 
               sellTrades.some(sell => sell.tokenAddress === trade.tokenAddress && 
                                      (sell.price > trade.price)))
      .map(trade => trade.boost || 0);
      
    if (successfulBoosts.length > 3) {
      const avgSuccessfulBoost = successfulBoosts.reduce((a, b) => a + b, 0) / successfulBoosts.length;
      if (avgSuccessfulBoost > 0 && Math.abs(avgSuccessfulBoost - currentSettings.minBoostAmount) > 1) {
        newSettings.minBoostAmount = Math.max(1, avgSuccessfulBoost * 0.8);
      }
    }
    
    // Apply new settings if there are any changes
    if (Object.keys(newSettings).length > 0) {
      updatePumpFunSettings(userId, newSettings);
      
      // Notify user about the optimization
      const changes = Object.entries(newSettings)
        .map(([key, value]) => {
          const readableKey = key
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase());
          
          // Format the value based on setting type
          let formattedValue = value;
          if (key === 'maxHoldTime') {
            formattedValue = Math.floor(Number(value) / 60) + ' minutes';
          } else if (key === 'profitTarget' || key === 'stopLoss') {
            formattedValue = value + '%';
          } else if (key === 'minBoostAmount') {
            formattedValue = '$' + value;
          }
          
          return `${readableKey}: ${formattedValue}`;
        })
        .join('\n');
      
      await notifyUserById(userId, 
        `🤖 <b>Auto-Optimization Applied</b>\n\nBased on your trading history, I've optimized these settings:\n\n${changes}\n\nThese adjustments should improve your trading results.`
      );
    }
  } catch (error: any) {
    logger.error(`Error in auto-optimization for user ${userId}: ${error.message}`);
  }
}

// Setup auto-optimization to run every 4 hours
export function setupAutoOptimization(userId: number): void {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return;
  }
  
  // Run optimization every 4 hours
  const optimizationInterval = setInterval(async () => {
    if (listener.tradeHistory.length >= 5) {
      await autoOptimizeSettings(userId);
    }
  }, 4 * 60 * 60 * 1000);
  
  // Store the interval ID
  listener.optimizationIntervalId = optimizationInterval;
}

// Export activeListeners map for diagnostic purposes
export { activeListeners };

/**
 * Get WebSocket connection state for a user
 * @param userId User ID to check connection for
 * @returns Connection state information
 */
export function getPumpFunConnectionState(userId: number): {
  connected: boolean;
  readyState?: number;
  lastMessageTimestamp?: number;
  endpoint?: string;
} {
  const listener = activeListeners.get(userId);
  if (!listener || !listener.wsConnection) {
    return { connected: false };
  }

  return {
    connected: listener.wsConnection.readyState === WebSocket.OPEN,
    readyState: listener.wsConnection.readyState,
    lastMessageTimestamp: listener.lastMessageTimestamp,
    endpoint: listener.wsConnection.url
  };
}

/**
 * Run diagnostics on WebSocket connection
 * @param userId User ID to run diagnostics for
 * @returns Diagnostic results
 */
export async function runPumpFunDiagnostics(userId: number): Promise<{
  dns: boolean;
  dnsResults: string[];
  http: boolean;
  websocket: boolean;
  connectionState?: {
    connected: boolean;
    readyState?: number;
    lastMessageTimestamp?: number;
  } | undefined;
  errorMessage?: string | undefined;
}> {
  const results: {
    dns: boolean;
    dnsResults: string[];
    http: boolean;
    websocket: boolean;
    connectionState?: {
      connected: boolean;
      readyState?: number;
      lastMessageTimestamp?: number;
    };
    errorMessage?: string;
  } = {
    dns: false,
    dnsResults: [],
    http: false,
    websocket: false
  };

  try {
    // Test DNS resolution
    try {
      const domains = ['socket.pump.fun', 'api.pump.fun', 'pump.fun'];
      for (const domain of domains) {
        try {
          const resolved = await dnsLookup(domain);
          results.dnsResults.push(`✅ ${domain} resolves to ${resolved.address}`);
          results.dns = true;
        } catch (error: any) {
          results.dnsResults.push(`❌ ${domain} resolution failed: ${error.message}`);
        }
      }
    } catch (error: any) {
      results.dnsResults.push(`❌ DNS resolution test failed: ${error.message}`);
    }

    // Test HTTP connectivity
    try {
      const response = await axios.get('https://pump.fun', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        results.http = true;
      }
    } catch (error: any) {
      results.errorMessage = `HTTP test failed: ${error.message}`;
    }

    // Check WebSocket state for this user
    const listener = activeListeners.get(userId);
    if (listener && listener.wsConnection) {
      results.connectionState = {
        connected: listener.wsConnection.readyState === WebSocket.OPEN,
        readyState: listener.wsConnection.readyState,
        lastMessageTimestamp: listener.lastMessageTimestamp
      };
      
      if (listener.wsConnection.readyState === WebSocket.OPEN) {
        results.websocket = true;
      }
    }
    
    // If no active connection, test creating a temporary one
    if (!results.websocket) {
      try {
        // Try to open a temporary WebSocket connection
        const tempResult = await testWebSocketConnection();
        results.websocket = tempResult.success;
        if (!tempResult.success && tempResult.error) {
          results.errorMessage = tempResult.error;
        }
      } catch (error: any) {
        results.errorMessage = `WebSocket test failed: ${error.message}`;
      }
    }

    return results;
  } catch (error: any) {
    logger.error(`Error running diagnostics: ${error.message}`);
    return {
      ...results,
      errorMessage: `Diagnostic error: ${error.message}`
    };
  }
}

/**
 * Test WebSocket connection to pump.fun
 * @returns Test result
 */
async function testWebSocketConnection(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      // Close after 5 seconds regardless of outcome
      const timeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
          resolve({ success: false, error: 'Connection timeout' });
        }
      }, 5000);
      
      const ws = new WebSocket('wss://socket.pump.fun/socket', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      ws.on('open', () => {
        clearTimeout(timeout);
        // Close the test connection
        ws.close();
        resolve({ success: true });
      });
      
      ws.on('error', (error) => {
        clearTimeout(timeout);
        ws.terminate();
        resolve({ success: false, error: error.message });
      });
    } catch (error: any) {
      resolve({ success: false, error: error.message });
    }
  });
} 