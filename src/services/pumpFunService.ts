import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { swapTokens } from './dexService';
import { notifyUserById } from '../bots/telegramBot';
import { getUserWallet, loadUserKeypair } from './walletService';
import axios from 'axios';
import WebSocket from 'ws';

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

    // Use pump.fun's WebSocket API via a public gateway
    const ws = new WebSocket('wss://socket.pump.fun/socket');

    // Setup event handlers
    ws.on('open', () => {
      logger.info(`WebSocket connection opened for user ${userId}`);
      notifyUserById(userId, `🔌 Connected to Pump.fun WebSocket API`);
      
      // Subscribe to new token events
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'tokens:new'
      }));
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
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
      } catch (error: any) {
        logger.error(`Error processing WebSocket message: ${error.message}`);
      }
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
      
      // Attempt to reconnect after a delay
      setTimeout(() => {
        if (activeListeners.has(userId)) {
          connectToPumpFunWebSocket(userId);
        }
      }, 5000);
    });

    // Save the WebSocket connection
    listener.wsConnection = ws;
  } catch (error: any) {
    logger.error(`Error setting up WebSocket for user ${userId}: ${error.message}`);
    throw error;
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
 * Start listening for new Pump.fun tokens
 * @param userId The user ID
 * @param settings Optional custom settings
 */
export async function startPumpFunListener(userId: number, settings?: Partial<PumpFunSettings>): Promise<void> {
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

/**
 * Start trading Pump.fun tokens
 * @param userId The user ID
 */
export async function startPumpFunTrading(userId: number): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("Please start the listener first with /start_listener");
  }
  
  // Update status to trading
  listener.status = 'trading';
  
  // Setup auto-optimization
  setupAutoOptimization(userId);
  
  // Notify user
  await notifyUserById(userId, `🤖 Pump.fun trading bot activated! Will automatically buy new tokens with boost ≥ $${listener.settings.minBoostAmount} using ${listener.settings.buyAmount} SOL per trade.\n\nAuto-optimization is enabled and will adjust your settings after 5+ trades.`);
  
  logger.info(`Started Pump.fun trading for user ${userId}`);
}

/**
 * Stop the Pump.fun listener
 * @param userId The user ID
 */
export function stopPumpFunListener(userId: number): void {
  const listener = activeListeners.get(userId);
  if (!listener) {
    return;
  }
  
  // Close WebSocket connection
  if (listener.wsConnection) {
    listener.wsConnection.close();
  }
  
  // Clear interval
  if (listener.intervalId) {
    clearInterval(listener.intervalId);
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