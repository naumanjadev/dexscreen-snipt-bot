import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
// import { purchaseToken } from './purchaseService'; // Commented out purchasing functionality
import { notifyUserById, deleteMessageById } from '../bots/telegramBot';
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService';

// DexScreener API Endpoints
const DEXSCREENER_BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEXSCREENER_PAIR_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana/';

interface DexScreenerBoostedToken {
  tokenAddress: string;
  chainId: string;
  url: string;
  totalAmount: number;
  description: string;
}

interface DexScreenerPairInfo {
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    symbol: string;
  };
  priceUsd: string;
  priceChange: {
    h1: number;
    h24: number;
  };
  liquidity?: {
    usd: number;
  };
  volume?: {
    h24: number;
  };
  pairAddress: string;
}

// Track active smart listeners by user ID
const activeSmartListeners: Map<number, {
  tokenAddress: string | null;
  intervalId: NodeJS.Timeout | null;
  lastPrice: number | null;
  initialPrice: number | null;
  highestPrice: number | null;
  recommendedSellPrice: number | null; // Added for tracking sell points
  lastMessageId: number | null; // Track the last message ID for deletion
  logoUrl: string | null; // Store token logo URL
  // User customization options
  updateFrequency: number; // Frequency in ms to check prices (default 1000)
  notificationThreshold: number; // Minimum % change to trigger notification (default 0.05%)
  profitTarget: number; // Target profit percentage (default 30%)
  stopLoss: number; // Stop loss percentage from initial price (default 10%)
  trailingStopLoss: number; // Trailing stop loss % from highest price (default 5%)
  autoSellEnabled: boolean; // Whether to automatically sell when conditions are met
  monitorMultipleTokens: boolean; // Whether to monitor multiple tokens at once
  // Additional UX enhancements
  notificationMode: 'important_only' | 'trade_signals'; // How to send notifications
  notificationInterval: number; // How often to send batched notifications (in ms)
  notificationBatchIntervalId: NodeJS.Timeout | null; // Interval for batched notifications
  batchedNotifications: Array<{
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    message: string;
    importance: 'low' | 'medium' | 'high' | 'critical';
    timestamp: number;
  }>; // Store messages for batched notifications
  notificationMessageLifetime: number; // How long messages remain visible in ms
  muteNonCritical: boolean; // Mute non-critical notifications
  lastNotificationTime: number; // When the last notification was sent
  compactMode: boolean; // Use compact notification format
}> = new Map();

// Add market analysis capabilities
interface TokenMarketAnalysis {
  priceHistory: number[]; // Store recent price history for analysis
  volumeHistory: number[]; // Store recent volume data
  movingAverages: {
    short: number | null; // Short-term moving average (5 data points)
    medium: number | null; // Medium-term moving average (20 data points)
    long: number | null; // Long-term moving average (50 data points)
  };
  trends: {
    shortTerm: 'bullish' | 'bearish' | 'neutral';
    mediumTerm: 'bullish' | 'bearish' | 'neutral';
    overallSentiment: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  };
  volatility: number; // Measure of price volatility
  lastUpdated: number; // Timestamp of last update
}

// Map to store market analysis data for each token
const tokenMarketAnalysis: Map<string, TokenMarketAnalysis> = new Map();

// Cache for API responses to reduce external calls
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

const apiCache: Map<string, CacheEntry<any>> = new Map();

// Cache TTL in milliseconds
const CACHE_TTL = {
  PAIR_INFO: 10000,       // 10 seconds for price info
  TOKEN_METADATA: 3600000, // 1 hour for token metadata 
  TOKEN_LIST: 300000,     // 5 minutes for token lists
  PAIR_ADDRESS: 60000     // 1 minute for pair addresses
};

/**
 * Fetch data with caching to reduce API calls
 * @param cacheKey Unique key for the cache entry
 * @param ttl Time to live in milliseconds
 * @param fetchFn Function to fetch data if cache miss
 * @returns The cached or freshly fetched data
 */
async function fetchWithCache<T>(cacheKey: string, ttl: number, fetchFn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = apiCache.get(cacheKey);
  
  // Return cached data if valid
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }
  
  // If cache miss or expired, fetch fresh data
  try {
    const freshData = await fetchFn();
    
    // Cache the result
    apiCache.set(cacheKey, {
      data: freshData,
      timestamp: now,
      expiresAt: now + ttl
    });
    
    return freshData;
  } catch (error: any) {
    // If fetch fails but we have stale data, use it as fallback
    if (cached) {
      logger.warn(`Failed to fetch fresh data for ${cacheKey}, using stale cache: ${error.message}`);
      return cached.data;
    }
    throw error;
  }
}

// Validate Mint Address
const isValidMint = (address: string): boolean => {
  try {
    const publicKey = new PublicKey(address);
    return PublicKey.isOnCurve(publicKey);
  } catch (error: any) {
    logger.debug(`Invalid mint address: ${address}. Error: ${error.message}`);
    return false;
  }
};

const fetchLatestBoostedTokens = async (): Promise<DexScreenerBoostedToken[]> => {
  return fetchWithCache<DexScreenerBoostedToken[]>(
    'boosted_tokens',
    CACHE_TTL.TOKEN_LIST,
    async () => {
      try {
        const response = await axios.get(DEXSCREENER_BOOSTS_URL);
        if (response.status === 200 && response.data) {
          const data: DexScreenerBoostedToken[] = Array.isArray(response.data) ? response.data : [response.data];
          return data;
        } else {
          logger.error(`Failed to fetch boosted tokens. Status: ${response.status}`);
          return [];
        }
      } catch (error: any) {
        logger.error(`Error fetching latest boosted tokens: ${error.message}`, error);
        return [];
      }
    }
  );
};

const fetchTokenPriceInfo = async (pairAddress: string): Promise<DexScreenerPairInfo | null> => {
  return fetchWithCache<DexScreenerPairInfo | null>(
    `price_info_${pairAddress}`,
    CACHE_TTL.PAIR_INFO,
    async () => {
      try {
        const response = await axios.get(`${DEXSCREENER_PAIR_URL}${pairAddress}`);
        if (response.status === 200 && response.data?.pairs?.length > 0) {
          return response.data.pairs[0];
        }
        return null;
      } catch (error: any) {
        logger.error(`Error fetching token price info: ${error.message}`, error);
        return null;
      }
    }
  );
};

const findPairAddress = async (tokenAddress: string): Promise<string | null> => {
  return fetchWithCache<string | null>(
    `pair_address_${tokenAddress}`,
    CACHE_TTL.PAIR_ADDRESS,
    async () => {
      try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (response.status === 200 && response.data?.pairs?.length > 0) {
          return response.data.pairs[0].pairAddress;
        }
        return null;
      } catch (error: any) {
        logger.error(`Error finding pair address for token ${tokenAddress}: ${error.message}`, error);
        return null;
      }
    }
  );
};

// Calculate recommended sell price based on price movement
const calculateRecommendedSellPrice = (initialPrice: number, currentPrice: number, highestPrice: number, profitTarget: number, trailingStopLoss: number): number => {
  // If we've seen a significant gain from the initial price (at least 10%)
  if (highestPrice >= initialPrice * 1.1) {
    // Never let the sell point drop below a certain percentage of the highest price
    // The higher the price went above initial, the higher we set the minimum sell point
    const priceGainFactor = (highestPrice - initialPrice) / initialPrice;
    
    // The more the price went up, the higher we set our floor
    // This ensures we lock in more profits on bigger runs
    let floorPercentage = 0.85; // Default to 85% of highest
    
    if (priceGainFactor > 1.0) { // 100% gain
      floorPercentage = 0.9; // 90% of highest (lock in more profit on big runs)
    } else if (priceGainFactor > 0.5) { // 50% gain
      floorPercentage = 0.87; // 87% of highest
    }
    
    // Calculate the minimum acceptable sell price based on the highest reached
    return Math.max(
      initialPrice * 1.05, // At minimum 5% above initial
      highestPrice * floorPercentage // Lock in a percentage of the peak price
    );
  }
  
  // If price never went up significantly, just target the profit target percentage
  return initialPrice * (1 + profitTarget/100);
};

// Try to get token logo from various sources
const fetchTokenLogo = async (tokenAddress: string): Promise<string | null> => {
  try {
    // Try to get logo from Jupiter Aggregator API
    const jupiterResponse = await axios.get(`https://token.jup.ag/all`);
    if (jupiterResponse.status === 200 && jupiterResponse.data) {
      const tokens = jupiterResponse.data;
      const tokenInfo = tokens.find((t: any) => t.address === tokenAddress);
      if (tokenInfo?.logoURI) {
        return tokenInfo.logoURI;
      }
    }
    
    // If Jupiter doesn't have it, try an alternative source like Solscan
    const solscanResponse = await axios.get(`https://api.solscan.io/token/meta?address=${tokenAddress}`);
    if (solscanResponse.status === 200 && solscanResponse.data?.data?.icon) {
      return solscanResponse.data.data.icon;
    }
    
    return null;
  } catch (error) {
    logger.warn(`Failed to fetch logo for token ${tokenAddress}`);
    return null;
  }
};

// Enhance fetchTokenMetadata to use multiple sources
const enhancedFetchTokenMetadata = async (tokenAddress: string): Promise<{name: string, symbol: string}> => {
  return fetchWithCache<{name: string, symbol: string}>(
    `token_metadata_${tokenAddress}`,
    CACHE_TTL.TOKEN_METADATA,
    async () => {
      try {
        // First try getting metadata from existing function
        const metadata = await fetchTokenMetadata(tokenAddress);
        if (metadata?.name && metadata?.symbol) {
          return { name: metadata.name, symbol: metadata.symbol };
        }
        
        // If that fails, try getting data directly from DexScreener token profiles
        try {
          // Try to get from Token Profiles API
          const profilesResponse = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
          if (profilesResponse.status === 200 && profilesResponse.data) {
            const profiles = Array.isArray(profilesResponse.data) ? profilesResponse.data : [profilesResponse.data];
            const tokenProfile = profiles.find((p: any) => p.tokenAddress === tokenAddress);
            if (tokenProfile?.name) {
              return { 
                name: tokenProfile.name || "Unknown", 
                symbol: tokenProfile.symbol || "Unknown" 
              };
            }
          }
        } catch (profileError) {
          logger.warn(`Failed to fetch token profile for ${tokenAddress}: ${profileError}`);
        }
        
        // Try to get from DEX Pairs API
        try {
          const pairsResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
          if (pairsResponse.status === 200 && pairsResponse.data?.pairs?.length > 0) {
            const baseToken = pairsResponse.data.pairs[0].baseToken;
            if (baseToken?.name && baseToken?.symbol) {
              return {
                name: baseToken.name,
                symbol: baseToken.symbol
              };
            }
          }
        } catch (pairsError) {
          logger.warn(`Failed to fetch pair info for ${tokenAddress}: ${pairsError}`);
        }
        
        // If all else fails, return Unknown
        return { name: "Unknown", symbol: "Unknown" };
      } catch (error) {
        logger.error(`Error in enhanced token metadata fetch for ${tokenAddress}: ${error}`);
        return { name: "Unknown", symbol: "Unknown" };
      }
    }
  );
};

// Enhance fetchTokenLogo to also look at token profiles
const enhancedFetchTokenLogo = async (tokenAddress: string): Promise<string | null> => {
  return fetchWithCache<string | null>(
    `token_logo_${tokenAddress}`,
    CACHE_TTL.TOKEN_METADATA,
    async () => {
      try {
        // First try existing logo fetching logic
        const logoUrl = await fetchTokenLogo(tokenAddress);
        if (logoUrl) {
          return logoUrl;
        }
        
        // Try to get from Token Profiles API
        try {
          const profilesResponse = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
          if (profilesResponse.status === 200 && profilesResponse.data) {
            const profiles = Array.isArray(profilesResponse.data) ? profilesResponse.data : [profilesResponse.data];
            const tokenProfile = profiles.find((p: any) => p.tokenAddress === tokenAddress);
            if (tokenProfile?.icon) {
              return tokenProfile.icon;
            }
          }
        } catch (profileError) {
          logger.warn(`Failed to fetch token profile icon for ${tokenAddress}`);
        }
        
        // Try Boosts API as another potential source
        try {
          const boostsResponse = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1');
          if (boostsResponse.status === 200 && boostsResponse.data) {
            const boosts = Array.isArray(boostsResponse.data) ? boostsResponse.data : [boostsResponse.data];
            const tokenBoost = boosts.find((b: any) => b.tokenAddress === tokenAddress);
            if (tokenBoost?.icon) {
              return tokenBoost.icon;
            }
          }
        } catch (boostError) {
          logger.warn(`Failed to fetch token boost icon for ${tokenAddress}`);
        }
        
        return null;
      } catch (error) {
        logger.warn(`Failed to fetch logo for token ${tokenAddress}`);
        return null;
      }
    }
  );
};

/**
 * Analyze price data and derive market indicators
 * @param tokenAddress The token address to analyze
 * @param currentPrice The current price of the token
 * @param priceInfo Additional price information
 */
const analyzeMarketData = (tokenAddress: string, currentPrice: number, priceInfo: DexScreenerPairInfo): TokenMarketAnalysis => {
  // Get existing analysis or create a new one
  let analysis = tokenMarketAnalysis.get(tokenAddress);
  
  if (!analysis) {
    analysis = {
      priceHistory: [],
      volumeHistory: [],
      movingAverages: {
        short: null,
        medium: null,
        long: null
      },
      trends: {
        shortTerm: 'neutral',
        mediumTerm: 'neutral',
        overallSentiment: 'hold'
      },
      volatility: 0,
      lastUpdated: Date.now()
    };
    tokenMarketAnalysis.set(tokenAddress, analysis);
  }
  
  // Update price history (keep last 50 data points)
  analysis.priceHistory.push(currentPrice);
  if (analysis.priceHistory.length > 50) {
    analysis.priceHistory.shift();
  }
  
  // Update volume history if available
  if (priceInfo.volume?.h24) {
    analysis.volumeHistory.push(priceInfo.volume.h24);
    if (analysis.volumeHistory.length > 50) {
      analysis.volumeHistory.shift();
    }
  }
  
  // Calculate moving averages if we have enough data
  if (analysis.priceHistory.length >= 5) {
    // Short-term MA (5 data points)
    analysis.movingAverages.short = analysis.priceHistory.slice(-5).reduce((sum, price) => sum + price, 0) / 5;
  }
  
  if (analysis.priceHistory.length >= 20) {
    // Medium-term MA (20 data points)
    analysis.movingAverages.medium = analysis.priceHistory.slice(-20).reduce((sum, price) => sum + price, 0) / 20;
  }
  
  if (analysis.priceHistory.length >= 50) {
    // Long-term MA (50 data points)
    analysis.movingAverages.long = analysis.priceHistory.slice(-50).reduce((sum, price) => sum + price, 0) / 50;
  }
  
  // Calculate volatility (standard deviation of price changes)
  if (analysis.priceHistory.length >= 10) {
    const priceChanges = [];
    for (let i = 1; i < analysis.priceHistory.length; i++) {
      const percentChange = ((analysis.priceHistory[i] - analysis.priceHistory[i-1]) / analysis.priceHistory[i-1]) * 100;
      priceChanges.push(percentChange);
    }
    
    // Calculate standard deviation
    const mean = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    const squaredDiffs = priceChanges.map(change => Math.pow(change - mean, 2));
    analysis.volatility = Math.sqrt(squaredDiffs.reduce((sum, diff) => sum + diff, 0) / squaredDiffs.length);
  }
  
  // Determine trends based on moving averages
  if (analysis.movingAverages.short && analysis.movingAverages.medium) {
    // Short-term trend (compare current price to short MA)
    if (currentPrice > analysis.movingAverages.short * 1.02) { // 2% above
      analysis.trends.shortTerm = 'bullish';
    } else if (currentPrice < analysis.movingAverages.short * 0.98) { // 2% below
      analysis.trends.shortTerm = 'bearish';
    } else {
      analysis.trends.shortTerm = 'neutral';
    }
    
    // Medium-term trend (compare short MA to medium MA)
    if (analysis.movingAverages.short > analysis.movingAverages.medium * 1.03) { // 3% above
      analysis.trends.mediumTerm = 'bullish';
    } else if (analysis.movingAverages.short < analysis.movingAverages.medium * 0.97) { // 3% below
      analysis.trends.mediumTerm = 'bearish';
    } else {
      analysis.trends.mediumTerm = 'neutral';
    }
  }
  
  // Determine overall sentiment based on trends and volatility
  if (analysis.trends.shortTerm === 'bullish' && analysis.trends.mediumTerm === 'bullish') {
    analysis.trends.overallSentiment = 'strong_buy';
  } else if (analysis.trends.shortTerm === 'bullish' && analysis.trends.mediumTerm === 'neutral') {
    analysis.trends.overallSentiment = 'buy';
  } else if (analysis.trends.shortTerm === 'bearish' && analysis.trends.mediumTerm === 'bearish') {
    analysis.trends.overallSentiment = 'strong_sell';
  } else if (analysis.trends.shortTerm === 'bearish' && analysis.trends.mediumTerm === 'neutral') {
    analysis.trends.overallSentiment = 'sell';
  } else {
    analysis.trends.overallSentiment = 'hold';
  }
  
  // Adjust for very high volatility - more caution
  if (analysis.volatility > 10) { // Very volatile (>10% standard deviation)
    if (analysis.trends.overallSentiment === 'buy') {
      analysis.trends.overallSentiment = 'hold'; // Downgrade buy to hold when volatile
    } else if (analysis.trends.overallSentiment === 'strong_buy') {
      analysis.trends.overallSentiment = 'buy'; // Downgrade strong buy to buy when volatile
    }
  }
  
  analysis.lastUpdated = Date.now();
  return analysis;
};

/**
 * Get a summarized market recommendation based on analysis
 * @param analysis The market analysis data
 */
const getMarketRecommendation = (analysis: TokenMarketAnalysis): string => {
  let recommendation = '';
  
  // Provide a recommendation based on sentiment
  switch (analysis.trends.overallSentiment) {
    case 'strong_buy':
      recommendation = '🟢 <b>STRONG BUY</b>: Bullish trends in both short and medium term. Consider increasing position.';
      break;
    case 'buy':
      recommendation = '🟢 <b>BUY</b>: Short-term bullish trend detected. May be a good entry point.';
      break;
    case 'hold':
      recommendation = '🟡 <b>HOLD</b>: Mixed signals or consolidation phase. Monitor for clearer direction.';
      break;
    case 'sell':
      recommendation = '🔴 <b>SELL</b>: Short-term bearish trend detected. Consider taking profits.';
      break;
    case 'strong_sell':
      recommendation = '🔴 <b>STRONG SELL</b>: Bearish trends in both short and medium term. Consider exiting position.';
      break;
  }
  
  // Add volatility information
  if (analysis.volatility > 0) {
    let volatilityLevel = '';
    if (analysis.volatility > 15) {
      volatilityLevel = 'extremely high';
    } else if (analysis.volatility > 10) {
      volatilityLevel = 'very high';
    } else if (analysis.volatility > 5) {
      volatilityLevel = 'high';
    } else if (analysis.volatility > 2) {
      volatilityLevel = 'moderate';
    } else {
      volatilityLevel = 'low';
    }
    
    recommendation += `\n\n<i>Volatility: ${volatilityLevel} (${analysis.volatility.toFixed(2)}%)</i>`;
    
    // Add a caution for very volatile tokens
    if (analysis.volatility > 10) {
      recommendation += `\n⚠️ <i>High volatility detected - trade with caution!</i>`;
    }
  }
  
  // Add technical indicators if we have enough data
  if (analysis.movingAverages.short && analysis.movingAverages.medium) {
    recommendation += `\n\n<b>Technical Indicators:</b>`;
    recommendation += `\n• Short MA (5): $${analysis.movingAverages.short.toFixed(8)}`;
    
    if (analysis.movingAverages.medium) {
      recommendation += `\n• Medium MA (20): $${analysis.movingAverages.medium.toFixed(8)}`;
    }
    
    if (analysis.movingAverages.long) {
      recommendation += `\n• Long MA (50): $${analysis.movingAverages.long.toFixed(8)}`;
    }
  }
  
  return recommendation;
};

const monitorTokenPrice = async (userId: number, tokenAddress: string): Promise<void> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) return;

  try {
    // Find the pair address for the token
    const pairAddress = await findPairAddress(tokenAddress);
    if (!pairAddress) {
      const errorMsgId = await notifyUserById(userId, `❌ Could not find trading pair for token ${tokenAddress}. Stopping smart listener.`);
      stopSmartListener(userId);
      return;
    }

    // Get token metadata and logo using enhanced functions
    let tokenName = 'Unknown';
    let tokenSymbol = 'Unknown';
    try {
      // Use enhanced metadata function
      const enhancedMetadata = await enhancedFetchTokenMetadata(tokenAddress);
      tokenName = enhancedMetadata.name;
      tokenSymbol = enhancedMetadata.symbol;
      
      // Get token logo with enhanced function
      const logoUrl = await enhancedFetchTokenLogo(tokenAddress);
      userListener.logoUrl = logoUrl;
      
      logger.info(`Successfully fetched metadata for ${tokenAddress}: ${tokenName} (${tokenSymbol})`);
    } catch (error) {
      logger.warn(`Failed to fetch metadata for token ${tokenAddress}: ${error}`);
    }

    // Setup batched notification interval if needed and not already setup
    if (userListener.notificationInterval > 0 && !userListener.notificationBatchIntervalId) {
      userListener.notificationBatchIntervalId = setInterval(() => {
        sendBatchedNotifications(userId);
      }, userListener.notificationInterval);
    }

    // Start monitoring the token price
    userListener.intervalId = setInterval(async () => {
      try {
        const priceInfo = await fetchTokenPriceInfo(pairAddress);
        if (!priceInfo) {
          logger.warn(`No price info found for pair ${pairAddress}`);
          return;
        }

        const currentPrice = parseFloat(priceInfo.priceUsd || '0');
        
        // Analyze market data
        const marketAnalysis = analyzeMarketData(tokenAddress, currentPrice, priceInfo);
        
        // Initialize prices if this is the first check
        if (userListener.initialPrice === null) {
          userListener.initialPrice = currentPrice;
          userListener.highestPrice = currentPrice;
          userListener.lastPrice = currentPrice;
          userListener.recommendedSellPrice = currentPrice * (1 + userListener.profitTarget/100); // Use custom profit target
          
          // Replace img tag with token symbol emoji
          const tokenEmoji = tokenSymbol ? `🪙 ` : '';
          
          // Create initialization message
          const initMessage = `
🔍 <b>Smart Listener Started</b>

${tokenEmoji}<b>${tokenName} (${tokenSymbol})</b>

<b>Address:</b> <code>${tokenAddress}</code>
<b>Initial Price:</b> $${currentPrice.toFixed(8)}
<b>Initial Sell Target:</b> $${userListener.recommendedSellPrice.toFixed(8)} (+${userListener.profitTarget}%)
<b>Stop Loss:</b> $${(currentPrice * (1 - userListener.stopLoss/100)).toFixed(8)} (-${userListener.stopLoss}%)

<i>Now monitoring price changes...</i>
          `;
          
          // Send message based on notification mode
          if (userListener.notificationMode === 'important_only') {
            // For important_only mode, send this message directly (initialization is important)
            const initialMessageId = await notifyUserById(userId, initMessage);
            userListener.lastMessageId = initialMessageId || null;
            userListener.lastNotificationTime = Date.now(); // Update last notification time
          } else if (userListener.notificationMode === 'trade_signals') {
            // For trade_signals mode, only send a minimal initialization message
            const tradeSignalInit = `
🔍 <b>Token Tracking Started</b>

${tokenEmoji}<b>${tokenName} (${tokenSymbol})</b>
<b>Initial Price:</b> $${currentPrice.toFixed(8)}

<i>You will only be notified of important buy/sell signals.</i>
            `;
            const initialMessageId = await notifyUserById(userId, tradeSignalInit);
            userListener.lastMessageId = initialMessageId || null;
            userListener.lastNotificationTime = Date.now(); // Update last notification time
          } else {
            // Add to batch for any other mode
            addNotificationToBatch(userId, tokenAddress, tokenName, tokenSymbol, initMessage, 'high');
          }
          
          return;
        }

        // Update highest price if current price is higher
        const previousHighestPrice = userListener.highestPrice;
        if (currentPrice > (userListener.highestPrice || 0)) {
          userListener.highestPrice = currentPrice;
          // Recalculate sell price when we hit a new high
          userListener.recommendedSellPrice = calculateRecommendedSellPrice(
            userListener.initialPrice || 0, 
            currentPrice, 
            currentPrice, // This is the new high
            userListener.profitTarget, // Pass custom profit target
            userListener.trailingStopLoss // Pass custom trailing stop loss
          );
        }

        // Calculate price changes
        const priceChangeFromInitial = userListener.initialPrice ? 
          ((currentPrice - userListener.initialPrice) / userListener.initialPrice) * 100 : 0;
        
        const priceChangeFromHighest = userListener.highestPrice ? 
          ((currentPrice - userListener.highestPrice) / userListener.highestPrice) * 100 : 0;
        
        const priceChangeSinceLastUpdate = userListener.lastPrice ? 
          ((currentPrice - userListener.lastPrice) / userListener.lastPrice) * 100 : 0;

        // Check if there's a meaningful price change or other important conditions to report
        const minChangeThreshold = userListener.notificationThreshold; // Use custom notification threshold
        
        // Calculate the percentage change since the last notification (not just the last price check)
        const timeSinceLastNotification = userListener.lastNotificationTime ? 
          Date.now() - userListener.lastNotificationTime : 0;
        
        // Only check for notifications if:
        // 1. This is the first update (no last price)
        // 2. A critical event occurred (sell signal, stop loss)
        // 3. A significant price change happened AND enough time passed since last notification
        
        // Check for critical events first
        const isSignificantPriceChange = Math.abs(priceChangeSinceLastUpdate) >= minChangeThreshold;
        const isNewHighPrice = userListener.highestPrice !== previousHighestPrice;
        const isSellSignal = currentPrice >= (userListener.recommendedSellPrice || 0);
        const isDropFromPeak = priceChangeFromHighest <= -userListener.trailingStopLoss; // Use custom trailing stop
        const isStopLoss = userListener.initialPrice && currentPrice <= userListener.initialPrice * (1 - userListener.stopLoss/100); // Use custom stop loss
        
        // Determine the importance of this notification
        let importance: 'low' | 'medium' | 'high' | 'critical' = 'low';
        
        // Critical events (always notify)
        if (isSellSignal || isStopLoss) {
          importance = 'critical';
        } 
        // High importance events (nearly always notify)
        else if (isDropFromPeak) {
          importance = 'high';
        }
        // Medium importance (notify occasionally)
        else if (isNewHighPrice && priceChangeFromInitial > 5) { // Only notify of new highs if they're meaningful
          importance = 'medium';
        }
        // Low importance (rarely notify)
        else if (isSignificantPriceChange && Math.abs(priceChangeSinceLastUpdate) >= minChangeThreshold * 2) {
          importance = 'low';
        } else {
          // Not important enough to notify
          userListener.lastPrice = currentPrice;
          return;
        }
        
        // For non-critical events, enforce a minimum time between notifications
        if (importance !== 'critical' && importance !== 'high') {
          const minNotificationInterval = 10 * 60 * 1000; // 10 minutes for non-critical updates
          if (timeSinceLastNotification < minNotificationInterval) {
            userListener.lastPrice = currentPrice;
            return;
          }
        }
        
        // For medium events, enforce a 2-minute interval
        if (importance === 'medium') {
          const mediumNotificationInterval = 2 * 60 * 1000; // 2 minutes
          if (timeSinceLastNotification < mediumNotificationInterval) {
            userListener.lastPrice = currentPrice;
            return;
          }
        }
        
        // Only send an update if there's a meaningful change or important condition
        if (isSignificantPriceChange || isNewHighPrice || isSellSignal || isDropFromPeak || isStopLoss) {
          // Replace img tag with token symbol emoji
          const tokenEmoji = tokenSymbol ? `🪙 ` : '';

          let message = '';

          // If it's a critical notification (sell signal or stop loss), make it very prominent
          if (importance === 'critical') {
            message = `
🚨 <b>ATTENTION REQUIRED</b> 🚨

${tokenEmoji}<b>${tokenName} (${tokenSymbol})</b>

`;
            
            if (isSellSignal) {
              message += `
🔔 <b>SELL SIGNAL TRIGGERED</b> 🔔
Current price ($${currentPrice.toFixed(8)}) has reached your target!

<b>Initial Buy:</b> $${userListener.initialPrice?.toFixed(8)}
<b>Current Price:</b> $${currentPrice.toFixed(8)} (${priceChangeFromInitial.toFixed(2)}%)
<b>Highest Price:</b> $${userListener.highestPrice?.toFixed(8)}

💰 <b>RECOMMENDATION:</b> Consider selling now to secure profits.
`;
            }
            
            if (isStopLoss) {
              message += `
⛔ <b>STOP LOSS TRIGGERED</b> ⛔
Price has fallen below your stop loss point!

<b>Initial Buy:</b> $${userListener.initialPrice?.toFixed(8)}
<b>Stop Loss Point:</b> $${(userListener.initialPrice! * (1 - userListener.stopLoss/100)).toFixed(8)}
<b>Current Price:</b> $${currentPrice.toFixed(8)} (${priceChangeFromInitial.toFixed(2)}%)

💰 <b>RECOMMENDATION:</b> Sell now to prevent further losses.
`;
            }
            
            if (isDropFromPeak) {
              message += `
📉 <b>TRAILING STOP TRIGGERED</b> 📉
Price has dropped ${Math.abs(priceChangeFromHighest).toFixed(2)}% from peak!

<b>Highest Price:</b> $${userListener.highestPrice?.toFixed(8)}
<b>Current Price:</b> $${currentPrice.toFixed(8)}
<b>Drop Percentage:</b> ${Math.abs(priceChangeFromHighest).toFixed(2)}%

💰 <b>RECOMMENDATION:</b> Consider selling to protect profits.
`;
            }
          }
          // For regular updates (high/medium/low importance)
          else {
            message = `
📊 <b>Price Update for ${tokenEmoji}${tokenName} (${tokenSymbol})</b>

<b>Current Price:</b> $${currentPrice.toFixed(8)}
<b>Initial Price:</b> $${userListener.initialPrice?.toFixed(8)}
<b>Profit/Loss:</b> ${priceChangeFromInitial > 0 ? '🟢' : '🔴'} ${priceChangeFromInitial.toFixed(2)}%
`;

            // Only add the sell target for positive performing tokens
            if (priceChangeFromInitial > 0) {
              message += `<b>Target Sell Price:</b> $${userListener.recommendedSellPrice?.toFixed(8)}\n`;
            }
            
            // Add new high price notification
            if (isNewHighPrice) {
              message += `
🚀 <b>New highest price reached!</b> Updated sell target.
`;
            }
          }

          // Add market analysis if we have enough data AND this is a critical notification
          if (marketAnalysis.priceHistory.length >= 5 && importance === 'critical') {
            // For critical notifications, provide a more concise market recommendation
            const sentiment = marketAnalysis.trends.overallSentiment;
            const volatility = marketAnalysis.volatility;
            
            message += `\n<b>Market Analysis:</b> `;
            
            switch (sentiment) {
              case 'strong_buy':
                message += `🟢 Strong market signals. Optimal to hold.`;
                break;
              case 'buy':
                message += `🟢 Positive momentum. Consider partial sell.`;
                break;
              case 'hold':
                message += `🟡 Mixed signals. Watch closely.`;
                break;
              case 'sell':
                message += `🔴 Bearish signals. Consider selling.`;
                break;
              case 'strong_sell':
                message += `🔴 Strong sell signals. Exit position.`;
                break;
            }
            
            // Only add volatility warning for high volatility
            if (volatility > 8) {
              message += `\n⚠️ <b>Warning:</b> High volatility (${volatility.toFixed(1)}%). Rapid price changes likely.`;
            }
          }

          if (isSellSignal) {
            message += `
🔔 <b>SELL SIGNAL!</b> Current price has reached recommended sell point.
`;
            // Add auto-sell logic if enabled
            if (userListener.autoSellEnabled) {
              message += `
🤖 <b>AUTO-SELL TRIGGERED!</b> Attempting to sell your tokens...
`;
              // Uncomment and implement this when ready to add auto-sell functionality
              // try {
              //   await sellToken(userId, tokenAddress);
              //   message += `✅ <b>SOLD SUCCESSFULLY!</b>\n`;
              // } catch (sellError) {
              //   message += `❌ <b>SELL FAILED!</b> ${sellError.message}\n`;
              // }
            }
          }

          if (isStopLoss) {
            message += `
⛔ <b>STOP LOSS TRIGGERED!</b> Price fell below stop loss point.
💰 <i>Consider selling to minimize further losses.</i>
`;
            // Add auto-sell logic for stop loss if enabled
            if (userListener.autoSellEnabled) {
              message += `
🤖 <b>AUTO-SELL TRIGGERED!</b> Attempting to sell your tokens...
`;
              // Uncomment and implement this when ready to add auto-sell functionality
            }
          } else if (isDropFromPeak) {
            message += `
⚠️ <b>Price has dropped ${Math.abs(priceChangeFromHighest).toFixed(2)}% from peak!</b>
💰 <i>Consider selling to protect profits.</i>
`;
            // Add auto-sell logic for trailing stop if enabled
            if (userListener.autoSellEnabled && Math.abs(priceChangeFromHighest) >= userListener.trailingStopLoss) {
              message += `
🤖 <b>TRAILING STOP TRIGGERED!</b> Attempting to sell your tokens...
`;
              // Uncomment and implement this when ready to add auto-sell functionality
            }
          }

          if (isNewHighPrice) {
            message += `
🚀 <b>New highest price reached!</b> Updated sell target.
`;
          }

          // Always include these useful links
          message += `
🔗 <a href="https://dexscreener.com/solana/${pairAddress}">View on DexScreener</a>

<i>Use /smart_settings to customize notifications</i>
`;

          // Based on notification mode, either send directly or add to batch
          if (userListener.notificationMode === 'important_only') {
            // For important_only mode, send all high/critical notifications directly
            if (importance === 'high' || importance === 'critical') {
              // Delete previous message if exists
              if (userListener.lastMessageId) {
                await deleteMessageById(userId, userListener.lastMessageId);
              }
              
              // Send new message and store its ID
              const messageId = await notifyUserById(userId, message);
              userListener.lastMessageId = messageId || null;
              userListener.lastNotificationTime = Date.now(); // Update last notification time
              
              // If message lifetime is set, schedule deletion
              if (userListener.notificationMessageLifetime > 0 && messageId) {
                setTimeout(async () => {
                  if (userListener && userListener.lastMessageId === messageId) {
                    await deleteMessageById(userId, messageId);
                    userListener.lastMessageId = null;
                  }
                }, userListener.notificationMessageLifetime);
              }
            }
          } else if (userListener.notificationMode === 'trade_signals') {
            // For trade_signals mode, only send messages about sell signals and major profit/loss
            if (isSellSignal || isStopLoss || isDropFromPeak || 
               (isNewHighPrice && priceChangeFromInitial > 20)) { // Only major highs
               
              // Delete previous message if exists
              if (userListener.lastMessageId) {
                await deleteMessageById(userId, userListener.lastMessageId);
              }
              
              // Send new message and store its ID
              const messageId = await notifyUserById(userId, message);
              userListener.lastMessageId = messageId || null;
              userListener.lastNotificationTime = Date.now(); // Update last notification time
              
              // If message lifetime is set, schedule deletion
              if (userListener.notificationMessageLifetime > 0 && messageId) {
                setTimeout(async () => {
                  if (userListener && userListener.lastMessageId === messageId) {
                    await deleteMessageById(userId, messageId);
                    userListener.lastMessageId = null;
                  }
                }, userListener.notificationMessageLifetime);
              }
            }
          } else {
            // For any other mode, add to batch for periodic sending
            addNotificationToBatch(userId, tokenAddress, tokenName, tokenSymbol, message, importance);
          }
        }
        
        // Always update the last price, even if we didn't send a message
        userListener.lastPrice = currentPrice;
      } catch (error: any) {
        logger.error(`Error monitoring token price for user ${userId}: ${error.message}`, error);
      }
    }, userListener.updateFrequency); // Use custom update frequency
  } catch (error: any) {
    logger.error(`Error setting up price monitoring for user ${userId}: ${error.message}`, error);
    await notifyUserById(userId, `❌ Error setting up price monitoring: ${error.message}`);
    stopSmartListener(userId);
  }
};

export const startSmartListener = async (userId: number): Promise<void> => {
  // Stop any existing smart listener for this user
  stopSmartListener(userId);
  
  // Initialize the smart listener state
  activeSmartListeners.set(userId, {
    tokenAddress: null,
    intervalId: null,
    lastPrice: null,
    initialPrice: null,
    highestPrice: null,
    recommendedSellPrice: null,
    lastMessageId: null,
    logoUrl: null,
    // User customization options with defaults
    updateFrequency: 1000,
    notificationThreshold: 0.05, 
    profitTarget: 30,
    stopLoss: 10,
    trailingStopLoss: 5,
    autoSellEnabled: false,
    monitorMultipleTokens: false,
    // Notification settings with defaults
    notificationMode: 'important_only',
    notificationInterval: 60000, // Default: batch every 1 minute if batched mode is used
    notificationBatchIntervalId: null,
    batchedNotifications: [],
    notificationMessageLifetime: 30000, // Default: messages stay for 30 seconds
    muteNonCritical: false,
    lastNotificationTime: 0,
    compactMode: false
  });
  
  const startMsg = await notifyUserById(userId, `🔍 Smart listener activated. Searching for tokens to track...`);
  
  try {
    // Find the first valid token directly - no interval needed
    const boostedTokens = await fetchLatestBoostedTokens();
    
    // Filter for Solana tokens with valid mint addresses
    const solanaTokens = boostedTokens.filter(t => 
      t.chainId.toLowerCase() === 'solana' && 
      isValidMint(t.tokenAddress)
    );
    
    if (solanaTokens.length === 0) {
      await notifyUserById(userId, `❌ No Solana tokens found. Please try again later.`);
      stopSmartListener(userId);
      return;
    }
    
    const userListener = activeSmartListeners.get(userId);
    if (!userListener) return;
    
    // Start batched notification interval if user is using batched mode
    if (userListener.notificationInterval > 0) {
      userListener.notificationBatchIntervalId = setInterval(() => {
        sendBatchedNotifications(userId);
      }, userListener.notificationInterval);
    }
    
    // Check if we should monitor multiple tokens
    if (userListener.monitorMultipleTokens) {
      // Take the top 3 tokens for monitoring (can adjust this number)
      const tokensToMonitor = solanaTokens.slice(0, 3);
      
      // Delete the initial "searching" message
      if (startMsg) {
        await deleteMessageById(userId, startMsg);
      }
      
      // Create a message listing all tokens that will be monitored
      let tokenListMessage = `🎯 <b>Selected Tokens for Tracking</b>\n\n`;
      
      for (let i = 0; i < tokensToMonitor.length; i++) {
        const token = tokensToMonitor[i];
        try {
          // Get token metadata
          const enhancedMetadata = await enhancedFetchTokenMetadata(token.tokenAddress);
          const tokenName = enhancedMetadata.name;
          const tokenSymbol = enhancedMetadata.symbol;
          
          // Add token to the list
          tokenListMessage += `${i+1}. <b>${tokenName} (${tokenSymbol})</b>\n`;
          tokenListMessage += `   <b>Address:</b> <code>${token.tokenAddress}</code>\n`;
          tokenListMessage += `   <b>Boost Amount:</b> ${token.totalAmount}\n\n`;
        } catch (error) {
          logger.warn(`Failed to fetch metadata for token ${token.tokenAddress}`);
          tokenListMessage += `${i+1}. <b>Unknown Token</b>\n`;
          tokenListMessage += `   <b>Address:</b> <code>${token.tokenAddress}</code>\n\n`;
        }
      }
      
      tokenListMessage += `<i>Starting price monitoring for all tokens...</i>`;
      
      // Send the combined message
      await notifyUserById(userId, tokenListMessage);
      
      // Start monitoring each token in parallel
      for (const token of tokensToMonitor) {
        userListener.tokenAddress = token.tokenAddress; // Set temporarily for monitoring
        await monitorTokenPrice(userId, token.tokenAddress);
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // For multiple tokens, reset the tokenAddress in the main record
      userListener.tokenAddress = null;
    } else {
      // Original single token monitoring logic
      // Take the first token from the list - no filtering
      const firstToken = solanaTokens[0];
      const tokenInfo: TokenInfo = { mintAddress: firstToken.tokenAddress };
      
      userListener.tokenAddress = firstToken.tokenAddress;
      
      // Notify user about the selected token - update with enhanced metadata fetching
      let tokenName = 'Unknown';
      let tokenSymbol = 'Unknown';
      
      try {
        // Use enhanced metadata function
        const enhancedMetadata = await enhancedFetchTokenMetadata(firstToken.tokenAddress);
        tokenName = enhancedMetadata.name;
        tokenSymbol = enhancedMetadata.symbol;
        
        // Get token logo with enhanced function
        const logoUrl = await enhancedFetchTokenLogo(firstToken.tokenAddress);
        userListener.logoUrl = logoUrl;
        
        logger.info(`Successfully fetched metadata for ${firstToken.tokenAddress}: ${tokenName} (${tokenSymbol})`);
      } catch (error) {
        logger.warn(`Failed to fetch metadata for token ${firstToken.tokenAddress}: ${error}`);
      }
      
      // Replace the following part
      // Logo HTML element if available
      const tokenEmoji = tokenSymbol ? `🪙 ` : '';
      
      // Delete the initial "searching" message
      if (startMsg) {
        await deleteMessageById(userId, startMsg);
      }
      
      const selectionMsgId = await notifyUserById(userId, `
🎯 <b>Selected Token for Tracking</b>

${tokenEmoji}<b>${tokenName} (${tokenSymbol})</b>
<b>Address:</b> <code>${firstToken.tokenAddress}</code>
<b>Boost Amount:</b> ${firstToken.totalAmount}

<i>Starting price monitoring at current market price...</i>
      `);
      
      userListener.lastMessageId = selectionMsgId || null;
      
      // Start monitoring the token price
      await monitorTokenPrice(userId, firstToken.tokenAddress);
    }
  } catch (error: any) {
    logger.error(`Error starting smart listener for user ${userId}: ${error.message}`, error);
    await notifyUserById(userId, `❌ Error starting smart listener: ${error.message}`);
    stopSmartListener(userId);
  }
};

export const stopSmartListener = (userId: number): void => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) {
    logger.debug(`No active smart listener for user ${userId}`);
    return;
  }
  
  // Clear price check interval
  if (userListener.intervalId) {
    clearInterval(userListener.intervalId);
  }
  
  // Clear batched notification interval if it exists
  if (userListener.notificationBatchIntervalId) {
    clearInterval(userListener.notificationBatchIntervalId);
  }
  
  // Send any pending batched notifications before stopping
  if (userListener.batchedNotifications && userListener.batchedNotifications.length > 0) {
    sendBatchedNotifications(userId);
  }
  
  // Delete the last message if it exists
  if (userListener.lastMessageId) {
    deleteMessageById(userId, userListener.lastMessageId);
  }
  
  activeSmartListeners.delete(userId);
  logger.info(`Smart listener stopped for user ${userId}`);
};

export const isSmartListenerActive = (userId: number): boolean => {
  return activeSmartListeners.has(userId);
};

/**
 * Get the current settings for a user's smart listener
 * @param userId The ID of the user
 * @returns The user's smart listener settings or default settings if not active
 */
export const getSmartListenerSettings = (userId: number): {
  updateFrequency: number;
  notificationThreshold: number;
  profitTarget: number;
  stopLoss: number;
  trailingStopLoss: number;
  autoSellEnabled: boolean;
  monitorMultipleTokens: boolean;
  notificationMode: 'important_only' | 'trade_signals';
  notificationInterval: number;
  notificationMessageLifetime: number;
  muteNonCritical: boolean;
  compactMode: boolean;
} => {
  const userListener = activeSmartListeners.get(userId);
  
  // Return actual settings if listener exists, otherwise return defaults
  return userListener ? {
    updateFrequency: userListener.updateFrequency,
    notificationThreshold: userListener.notificationThreshold,
    profitTarget: userListener.profitTarget,
    stopLoss: userListener.stopLoss,
    trailingStopLoss: userListener.trailingStopLoss,
    autoSellEnabled: userListener.autoSellEnabled,
    monitorMultipleTokens: userListener.monitorMultipleTokens,
    notificationMode: userListener.notificationMode,
    notificationInterval: userListener.notificationInterval,
    notificationMessageLifetime: userListener.notificationMessageLifetime,
    muteNonCritical: userListener.muteNonCritical,
    compactMode: userListener.compactMode
  } : {
    // Default settings
    updateFrequency: 1000,
    notificationThreshold: 0.05,
    profitTarget: 30,
    stopLoss: 10,
    trailingStopLoss: 5,
    autoSellEnabled: false,
    monitorMultipleTokens: false,
    notificationMode: 'important_only',
    notificationInterval: 60000,
    notificationMessageLifetime: 30000,
    muteNonCritical: false,
    compactMode: false
  };
};

/**
 * Update settings for a user's smart listener
 * @param userId The ID of the user
 * @param settings Settings to update
 */
export const updateSmartListenerSettings = (userId: number, settings: Partial<{
  updateFrequency: number;
  notificationThreshold: number;
  profitTarget: number;
  stopLoss: number;
  trailingStopLoss: number;
  autoSellEnabled: boolean;
  monitorMultipleTokens: boolean;
  notificationMode: 'important_only' | 'trade_signals';
  notificationInterval: number;
  notificationMessageLifetime: number;
  muteNonCritical: boolean;
  compactMode: boolean;
}>): void => {
  // Get the current listener or initialize with default settings
  let userListener = activeSmartListeners.get(userId);
  
  if (!userListener) {
    // Create a new settings object with defaults if the listener isn't active
    userListener = {
      tokenAddress: null,
      intervalId: null,
      lastPrice: null,
      initialPrice: null,
      highestPrice: null,
      recommendedSellPrice: null,
      lastMessageId: null,
      logoUrl: null,
      updateFrequency: 1000,
      notificationThreshold: 0.05,
      profitTarget: 30,
      stopLoss: 10,
      trailingStopLoss: 5,
      autoSellEnabled: false,
      monitorMultipleTokens: false,
      notificationMode: 'important_only',
      notificationInterval: 60000,
      notificationBatchIntervalId: null,
      batchedNotifications: [],
      notificationMessageLifetime: 30000,
      muteNonCritical: false,
      lastNotificationTime: 0,
      compactMode: false
    };
    activeSmartListeners.set(userId, userListener);
  }
  
  // Update settings
  Object.assign(userListener, settings);
  
  // If the listener is active and the frequency changed, restart the interval
  if (userListener.intervalId && settings.updateFrequency && settings.updateFrequency !== userListener.updateFrequency) {
    clearInterval(userListener.intervalId);
    
    // If there's a token address, restart monitoring with new frequency
    if (userListener.tokenAddress) {
      monitorTokenPrice(userId, userListener.tokenAddress);
    }
  }
  
  // If notificationInterval changed, update the interval if needed
  if (settings.notificationInterval !== undefined && 
      userListener.notificationBatchIntervalId) {
    clearInterval(userListener.notificationBatchIntervalId);
    
    // Setup a new interval for sending batched notifications if needed
    userListener.notificationBatchIntervalId = setInterval(() => {
      sendBatchedNotifications(userId);
    }, userListener.notificationInterval);
  }
  
  // Send any pending notifications
  if (userListener.batchedNotifications.length > 0) {
    sendBatchedNotifications(userId);
  }
  
  logger.info(`Updated smart listener settings for user ${userId}:`, settings);
};

/**
 * Get detailed analytics for tokens being monitored by a user
 * @param userId The ID of the user
 * @returns Array of analytics reports for the monitored tokens
 */
export const getDetailedTokenAnalytics = async (userId: number): Promise<string[]> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) {
    return [];
  }
  
  const reports: string[] = [];
  
  // If monitoring multiple tokens, we need to find all tokens monitored by this user
  if (userListener.monitorMultipleTokens) {
    // Get all token addresses that have been analyzed
    const allTokenAddresses = Array.from(tokenMarketAnalysis.keys());
    
    // For each token, check if it has enough data to generate a report
    for (const tokenAddress of allTokenAddresses) {
      const analysis = tokenMarketAnalysis.get(tokenAddress);
      if (analysis && analysis.priceHistory.length >= 5) {
        // Get token info
        let tokenName = 'Unknown';
        let tokenSymbol = 'Unknown';
        
        try {
          const enhancedMetadata = await enhancedFetchTokenMetadata(tokenAddress);
          tokenName = enhancedMetadata.name;
          tokenSymbol = enhancedMetadata.symbol;
        } catch (error) {
          logger.warn(`Failed to fetch metadata for token ${tokenAddress}`);
        }
        
        // Generate detailed report
        const report = generateDetailedAnalyticsReport(tokenAddress, tokenName, tokenSymbol, analysis);
        reports.push(report);
      }
    }
  } else if (userListener.tokenAddress) {
    // Single token monitoring
    const tokenAddress = userListener.tokenAddress;
    const analysis = tokenMarketAnalysis.get(tokenAddress);
    
    if (analysis && analysis.priceHistory.length >= 5) {
      // Get token info
      let tokenName = 'Unknown';
      let tokenSymbol = 'Unknown';
      
      try {
        const enhancedMetadata = await enhancedFetchTokenMetadata(tokenAddress);
        tokenName = enhancedMetadata.name;
        tokenSymbol = enhancedMetadata.symbol;
      } catch (error) {
        logger.warn(`Failed to fetch metadata for token ${tokenAddress}`);
      }
      
      // Generate detailed report
      const report = generateDetailedAnalyticsReport(tokenAddress, tokenName, tokenSymbol, analysis);
      reports.push(report);
    }
  }
  
  return reports;
};

/**
 * Generate a detailed analytics report for a token
 * @param tokenAddress The token address
 * @param tokenName The token name
 * @param tokenSymbol The token symbol
 * @param analysis The market analysis data
 * @returns A formatted HTML report
 */
const generateDetailedAnalyticsReport = (
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string,
  analysis: TokenMarketAnalysis
): string => {
  const tokenEmoji = tokenSymbol ? `🪙 ` : '';
  
  // Get the most recent price from price history
  const currentPrice = analysis.priceHistory[analysis.priceHistory.length - 1];
  
  // Calculate price change over different periods
  const last24hChange = analysis.priceHistory.length >= 24 ? 
    ((currentPrice - analysis.priceHistory[analysis.priceHistory.length - 24]) / analysis.priceHistory[analysis.priceHistory.length - 24]) * 100 : null;
    
  const last1hChange = analysis.priceHistory.length >= 5 ? 
    ((currentPrice - analysis.priceHistory[analysis.priceHistory.length - 5]) / analysis.priceHistory[analysis.priceHistory.length - 5]) * 100 : null;
  
  let report = `
📈 <b>Detailed Analytics for ${tokenEmoji}${tokenName} (${tokenSymbol})</b>

<b>Token Address:</b> <code>${tokenAddress}</code>
<b>Current Price:</b> $${currentPrice.toFixed(8)}
`;

  if (last1hChange !== null) {
    const changeEmoji = last1hChange >= 0 ? '🟢' : '🔴';
    report += `<b>1h Change:</b> ${changeEmoji} ${last1hChange.toFixed(2)}%\n`;
  }
  
  if (last24hChange !== null) {
    const changeEmoji = last24hChange >= 0 ? '🟢' : '🔴';
    report += `<b>24h Change:</b> ${changeEmoji} ${last24hChange.toFixed(2)}%\n`;
  }
  
  report += `
<b>Market Sentiment:</b> ${getSentimentEmoji(analysis.trends.overallSentiment)} ${analysis.trends.overallSentiment.toUpperCase().replace('_', ' ')}
<b>Short-term Trend:</b> ${getTrendEmoji(analysis.trends.shortTerm)} ${analysis.trends.shortTerm.toUpperCase()}
<b>Medium-term Trend:</b> ${getTrendEmoji(analysis.trends.mediumTerm)} ${analysis.trends.mediumTerm.toUpperCase()}
<b>Volatility:</b> ${getVolatilityLevel(analysis.volatility)} (${analysis.volatility.toFixed(2)}%)
`;

  // Add moving averages
  report += `
<b>Technical Indicators:</b>`;

  if (analysis.movingAverages.short) {
    const position = currentPrice > analysis.movingAverages.short ? 'ABOVE' : 'BELOW';
    const emoji = currentPrice > analysis.movingAverages.short ? '🟢' : '🔴';
    report += `
• MA (5): $${analysis.movingAverages.short.toFixed(8)} (Price ${emoji} ${position})`;
  }
  
  if (analysis.movingAverages.medium) {
    const position = currentPrice > analysis.movingAverages.medium ? 'ABOVE' : 'BELOW';
    const emoji = currentPrice > analysis.movingAverages.medium ? '🟢' : '🔴';
    report += `
• MA (20): $${analysis.movingAverages.medium.toFixed(8)} (Price ${emoji} ${position})`;
  }
  
  if (analysis.movingAverages.long) {
    const position = currentPrice > analysis.movingAverages.long ? 'ABOVE' : 'BELOW';
    const emoji = currentPrice > analysis.movingAverages.long ? '🟢' : '🔴';
    report += `
• MA (50): $${analysis.movingAverages.long.toFixed(8)} (Price ${emoji} ${position})`;
  }
  
  // Add trading signals section
  report += `

<b>Trading Signals:</b>`;

  // Add Golden Cross / Death Cross detection
  if (analysis.movingAverages.short && analysis.movingAverages.medium) {
    if (analysis.movingAverages.short > analysis.movingAverages.medium) {
      report += `
• ✨ <b>GOLDEN CROSS</b>: Short-term MA above medium-term MA (bullish)`;
    } else if (analysis.movingAverages.short < analysis.movingAverages.medium) {
      report += `
• ⚠️ <b>DEATH CROSS</b>: Short-term MA below medium-term MA (bearish)`;
    }
  }
  
  // Add volume analysis if available
  if (analysis.volumeHistory.length > 0) {
    const currentVolume = analysis.volumeHistory[analysis.volumeHistory.length - 1];
    const averageVolume = analysis.volumeHistory.reduce((sum, vol) => sum + vol, 0) / analysis.volumeHistory.length;
    const volumeRatio = currentVolume / averageVolume;
    
    let volumeSignal = '';
    if (volumeRatio > 1.5) {
      volumeSignal = '🔊 <b>HIGH VOLUME</b>: Volume is significantly above average (bullish if price increasing)';
    } else if (volumeRatio < 0.5) {
      volumeSignal = '🔈 <b>LOW VOLUME</b>: Volume is significantly below average (consider waiting for volume confirmation)';
    } else {
      volumeSignal = '🔉 <b>NORMAL VOLUME</b>: Volume is around average';
    }
    
    report += `
• ${volumeSignal}`;
  }
  
  // Add price action signals
  const recentPrices = analysis.priceHistory.slice(-5);
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  
  for (let i = 1; i < recentPrices.length; i++) {
    if (recentPrices[i] > recentPrices[i-1]) {
      consecutiveUp++;
      consecutiveDown = 0;
    } else if (recentPrices[i] < recentPrices[i-1]) {
      consecutiveDown++;
      consecutiveUp = 0;
    }
  }
  
  if (consecutiveUp >= 3) {
    report += `
• 🚀 <b>STRONG MOMENTUM</b>: Price has increased for ${consecutiveUp} consecutive periods`;
  } else if (consecutiveDown >= 3) {
    report += `
• 📉 <b>DOWNWARD PRESSURE</b>: Price has decreased for ${consecutiveDown} consecutive periods`;
  }
  
  // Add price prediction based on trends
  report += `

<b>Action Recommendation:</b>
${getActionRecommendation(analysis)}

<i>Generated at ${new Date().toLocaleString()}</i>
<i>Data points: ${analysis.priceHistory.length}</i>

🔗 <a href="https://dexscreener.com/solana/${tokenAddress}">View on DexScreener</a>
🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>
`;

  return report;
};

// Helper functions for formatting analytics reports

const getSentimentEmoji = (sentiment: string): string => {
  switch (sentiment) {
    case 'strong_buy': return '🟢';
    case 'buy': return '🟢';
    case 'hold': return '🟡';
    case 'sell': return '🔴';
    case 'strong_sell': return '🔴';
    default: return '⚪';
  }
};

const getTrendEmoji = (trend: string): string => {
  switch (trend) {
    case 'bullish': return '📈';
    case 'bearish': return '📉';
    case 'neutral': return '➖';
    default: return '⚪';
  }
};

const getVolatilityLevel = (volatility: number): string => {
  if (volatility > 15) return '⚠️ Extremely High';
  if (volatility > 10) return '⚠️ Very High';
  if (volatility > 5) return '⚠️ High';
  if (volatility > 2) return '🟡 Moderate';
  return '🟢 Low';
};

const getActionRecommendation = (analysis: TokenMarketAnalysis): string => {
  switch (analysis.trends.overallSentiment) {
    case 'strong_buy':
      return '🟢 <b>ACCUMULATE</b>: Consider adding to your position as market signals are strongly positive.';
    case 'buy':
      return '🟢 <b>BUY</b>: Market signals suggest this may be a good entry point.';
    case 'hold':
      return '🟡 <b>HOLD</b>: Stay in your current position and monitor for clearer signals.';
    case 'sell':
      return '🔴 <b>TAKE PROFITS</b>: Consider taking profits on a portion of your holdings.';
    case 'strong_sell':
      return '🔴 <b>EXIT POSITION</b>: Market signals suggest exiting this position to protect capital.';
    default:
      return '⚪ <b>NEUTRAL</b>: Insufficient data to make a strong recommendation.';
  }
};

/**
 * Add a notification to the batch queue for a user
 * @param userId User ID
 * @param tokenAddress Token address
 * @param tokenName Token name
 * @param tokenSymbol Token symbol
 * @param message Notification message
 * @param importance Importance level
 */
const addNotificationToBatch = (
  userId: number,
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string,
  message: string,
  importance: 'low' | 'medium' | 'high' | 'critical'
): void => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) return;
  
  // If mute is on and this is not critical, don't add
  if (userListener.muteNonCritical && importance !== 'critical') {
    return;
  }
  
  // Add the notification to the batch
  userListener.batchedNotifications.push({
    tokenAddress,
    tokenName,
    tokenSymbol,
    message,
    importance,
    timestamp: Date.now()
  });
  
  // For important notifications, potentially send immediately
  if ((importance === 'high' || importance === 'critical') && 
      userListener.notificationMode !== 'trade_signals') {
    sendBatchedNotifications(userId);
  }
};

/**
 * Send batched notifications to a user
 * @param userId User ID
 */
const sendBatchedNotifications = async (userId: number): Promise<void> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || userListener.batchedNotifications.length === 0) return;
  
  try {
    // Sort notifications by importance and then by timestamp
    const sortedNotifications = [...userListener.batchedNotifications].sort((a, b) => {
      const importanceOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const importanceDiff = importanceOrder[a.importance] - importanceOrder[b.importance];
      if (importanceDiff !== 0) return importanceDiff;
      return a.timestamp - b.timestamp;
    });
    
    // Group notifications by token
    const notificationsByToken: Record<string, typeof userListener.batchedNotifications> = {};
    
    for (const notification of sortedNotifications) {
      const key = `${notification.tokenAddress}`;
      if (!notificationsByToken[key]) {
        notificationsByToken[key] = [];
      }
      notificationsByToken[key].push(notification);
    }
    
    // Process each token's notifications
    for (const [tokenKey, notifications] of Object.entries(notificationsByToken)) {
      let message: string;
      
      if (userListener.compactMode) {
        // Compact format: One summary message per token with main points
        const importantEvents = notifications
          .filter(n => n.importance === 'critical' || n.importance === 'high')
          .map(n => n.message.split('\n')[0]) // Take just the first line of each message
          .join('\n');
          
        const tokenInfo = notifications[0];
        const tokenEmoji = tokenInfo.tokenSymbol ? `🪙 ` : '';
        
        message = `
📊 <b>Update for ${tokenEmoji}${tokenInfo.tokenName} (${tokenInfo.tokenSymbol})</b>

${importantEvents || 'No significant events'}

<i>Use /view_analytics for detailed information</i>
        `;
      } else {
        // Regular format: Include all notification content
        // But limit to the most recent 3 notifications if there are many
        const relevantNotifications = notifications.length > 3 
          ? notifications.slice(-3) // Take the latest 3
          : notifications;
          
        const tokenInfo = notifications[0];
        const tokenEmoji = tokenInfo.tokenSymbol ? `🪙 ` : '';
        
        message = `
📊 <b>Updates for ${tokenEmoji}${tokenInfo.tokenName} (${tokenInfo.tokenSymbol})</b>

${relevantNotifications.map(n => n.message).join('\n\n---\n\n')}

<i>Total events: ${notifications.length}</i>
<i>Use /view_analytics for more details</i>
        `;
      }
      
      // Delete the previous message if it exists
      if (userListener.lastMessageId) {
        await deleteMessageById(userId, userListener.lastMessageId);
      }
      
      // Send new message and store its ID
      const messageId = await notifyUserById(userId, message);
      userListener.lastMessageId = messageId || null;
      userListener.lastNotificationTime = Date.now(); // Update last notification time
      
      // If we have a message lifetime, schedule it for deletion
      if (userListener.notificationMessageLifetime > 0) {
        if (messageId) {
          setTimeout(async () => {
            // Only delete if this is still the last message (to avoid race conditions)
            if (userListener && userListener.lastMessageId === messageId) {
              await deleteMessageById(userId, messageId);
              userListener.lastMessageId = null;
            }
          }, userListener.notificationMessageLifetime);
        }
      }
    }
    
    // Clear the batch
    userListener.batchedNotifications = [];
    
  } catch (error: any) {
    logger.error(`Error sending batched notifications to user ${userId}: ${error.message}`, error);
  }
}; 