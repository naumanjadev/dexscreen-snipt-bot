import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken, sellToken } from './purchaseService'; // Import both functions
import { notifyUserById, deleteMessageById } from '../bots/telegramBot';
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService';
import { getUserSettings } from '../services/userSettingsService';

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
  pendingStop: boolean; // Track if we're waiting for stop confirmation
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
  // Auto-trading settings
  autoTradeEnabled: boolean; // Whether auto-trading is enabled
  tradeState: 'waiting' | 'buying' | 'holding' | 'selling'; // Current state of trading
  tradingBudget: number; // Amount of SOL to use for each trade
  minProfitPercent: number; // Minimum profit percentage to trigger a sell
  maxLossPercent: number; // Maximum loss percentage before selling
  entryPrice: number | null; // Price at which the token was bought
  amountPurchased: number | null; // Amount of tokens purchased
  totalInvested: number | null; // Total amount of SOL invested
  totalReturned: number | null; // Total amount of SOL returned from sells
  lastTradeTime: number | null; // Timestamp of last trade
  profitHistory: Array<{
    tokenAddress: string;
    buyPrice: number;
    sellPrice: number;
    profit: number;
    profitPercent: number;
    timestamp: number;
  }>; // History of completed trades
  consecutiveLosses: number; // Track consecutive losing trades to adjust strategy
  consecutiveWins: number; // Track consecutive winning trades to adjust strategy
  rsiValues: number[]; // Store recent RSI values for momentum tracking
  emaShort: number | null; // Short exponential moving average
  emaLong: number | null; // Long exponential moving average
  volatilityThreshold: number; // Volatility threshold for trading decisions
  volumeThreshold: number; // Volume threshold for trading decisions
  marketScannerIntervalId: NodeJS.Timeout | null; // Market scanner interval ID
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

// Add this near the top with other state variables
const metadataRequestTracker = {
  lastRequestTime: 0,
  minTimeBetweenRequests: 200, // ms between requests to prevent rate limiting
  consecutiveFailures: 0,
  currentBackoff: 200, // initial backoff time (ms)
  maxBackoff: 5000 // maximum backoff time (ms)
};

// Then update the enhancedFetchTokenMetadata function
const enhancedFetchTokenMetadata = async (tokenAddress: string): Promise<{name: string, symbol: string}> => {
  return fetchWithCache<{name: string, symbol: string}>(
    `token_metadata_${tokenAddress}`,
    CACHE_TTL.TOKEN_METADATA,
    async () => {
      try {
        // Check if we need to apply rate limiting
        const now = Date.now();
        const timeSinceLastRequest = now - metadataRequestTracker.lastRequestTime;
        
        if (timeSinceLastRequest < metadataRequestTracker.minTimeBetweenRequests) {
          // Apply dynamic backoff if we're hitting the API too quickly
          const waitTime = metadataRequestTracker.minTimeBetweenRequests - timeSinceLastRequest;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        // Check if a token address has 'pump' or other memecoin indicators in it
        // and provide basic metadata without making an API call
        if (tokenAddress.toLowerCase().includes('pump')) {
          logger.debug(`Quick metadata generation for pump token: ${tokenAddress}`);
          return { name: "Pump Token", symbol: "PUMP" };
        } else if (tokenAddress.toLowerCase().includes('pepe')) {
          logger.debug(`Quick metadata generation for pepe token: ${tokenAddress}`);
          return { name: "Pepe Token", symbol: "PEPE" };
        } else if (tokenAddress.toLowerCase().includes('meme')) {
          logger.debug(`Quick metadata generation for meme token: ${tokenAddress}`);
          return { name: "Meme Token", symbol: "MEME" };
        } else if (tokenAddress.toLowerCase().includes('moon')) {
          logger.debug(`Quick metadata generation for moon token: ${tokenAddress}`);
          return { name: "Moon Token", symbol: "MOON" };
        }
        
        // Update last request time
        metadataRequestTracker.lastRequestTime = Date.now();
        
        // First try getting metadata from existing function
        let metadata = null;
        try {
          metadata = await fetchTokenMetadata(tokenAddress);
          if (metadata?.name && metadata?.symbol) {
            // Success - reset backoff
            metadataRequestTracker.consecutiveFailures = 0;
            metadataRequestTracker.currentBackoff = 200;
            return { name: metadata.name, symbol: metadata.symbol };
          }
        } catch (metadataError) {
          logger.debug(`Primary metadata fetch failed for ${tokenAddress}: ${metadataError}`);
          // Apply backoff on failure
          metadataRequestTracker.consecutiveFailures++;
          metadataRequestTracker.currentBackoff = Math.min(
            metadataRequestTracker.currentBackoff * 1.5,
            metadataRequestTracker.maxBackoff
          );
          await new Promise(resolve => setTimeout(resolve, metadataRequestTracker.currentBackoff));
        }
        
        // Try to get data directly from DexScreener token profiles
        try {
          // Try to get from Token Profiles API - less frequently to reduce rate limits
          if (Math.random() < 0.3) { // Only try 30% of the time to reduce API load
            const profilesResponse = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
            if (profilesResponse.status === 200 && profilesResponse.data) {
              const profiles = Array.isArray(profilesResponse.data) ? profilesResponse.data : [profilesResponse.data];
              const tokenProfile = profiles.find((p: any) => p.tokenAddress === tokenAddress);
              if (tokenProfile?.name) {
                logger.debug(`Found token in DexScreener profiles: ${tokenProfile.name}`);
                return { 
                  name: tokenProfile.name || "Unknown", 
                  symbol: tokenProfile.symbol || "Unknown" 
                };
              }
            }
          }
        } catch (error: any) {
          if (error.response && error.response.status === 429) {
            logger.warn(`Rate limiting encountered for DexScreener profiles API`);
            // Apply additional backoff on rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            logger.debug(`Profile fetch failed for ${tokenAddress}: ${error.message || error}`);
          }
        }
        
        // Try to get from DEX Pairs API
        try {
          // Apply backoff before making another request
          await new Promise(resolve => setTimeout(resolve, metadataRequestTracker.minTimeBetweenRequests));
          metadataRequestTracker.lastRequestTime = Date.now();
          
          const pairsResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
          if (pairsResponse.status === 200 && pairsResponse.data?.pairs?.length > 0) {
            const baseToken = pairsResponse.data.pairs[0].baseToken;
            if (baseToken?.name && baseToken?.symbol) {
              logger.debug(`Found token info in pairs API: ${baseToken.name}`);
              return {
                name: baseToken.name,
                symbol: baseToken.symbol
              };
            }
          }
        } catch (error: any) {
          if (error.response && error.response.status === 429) {
            logger.warn(`Rate limiting encountered for DexScreener pairs API`);
            // Apply additional backoff on rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            logger.debug(`Pairs fetch failed for ${tokenAddress}: ${error.message || error}`);
          }
        }
        
        // Try to get from SolScan API as last resort
        try {
          // Apply backoff before making another request
          await new Promise(resolve => setTimeout(resolve, metadataRequestTracker.minTimeBetweenRequests));
          metadataRequestTracker.lastRequestTime = Date.now();
          
          const solscanResponse = await axios.get(`https://api.solscan.io/token/meta?token=${tokenAddress}`, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0'
            }
          });
          
          if (solscanResponse.status === 200 && solscanResponse.data?.success) {
            const solscanData = solscanResponse.data.data;
            if (solscanData?.name || solscanData?.symbol) {
              logger.debug(`Found token info in Solscan: ${solscanData.name || solscanData.symbol}`);
              return {
                name: solscanData.name || "Unknown",
                symbol: solscanData.symbol || "Unknown"
              };
            }
          }
        } catch (solscanError) {
          logger.debug(`Solscan fetch failed for ${tokenAddress}: ${solscanError}`);
        }
        
        // Extract name/symbol from token address as last resort
        // Common for memecoins to have pump/pepe/meme in address
        if (tokenAddress.toLowerCase().includes('pump')) {
          return { name: "Pump Token", symbol: "PUMP" };
        } else if (tokenAddress.toLowerCase().includes('pepe')) {
          return { name: "Pepe Token", symbol: "PEPE" };
        } else if (tokenAddress.toLowerCase().includes('meme')) {
          return { name: "Meme Token", symbol: "MEME" };
        }
        
        // If all else fails, return Unknown with shortened address
        const shortAddr = `${tokenAddress.substring(0, 4)}...${tokenAddress.substring(tokenAddress.length - 4)}`;
        return { name: `Token ${shortAddr}`, symbol: shortAddr };
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
${userListener.autoTradeEnabled ? '<b>Auto-Trading:</b> ENABLED ✅' : ''}
${userListener.autoTradeEnabled ? `<b>Trading Budget:</b> ${userListener.tradingBudget} SOL` : ''}

<i>Now monitoring price changes...</i>
          `;
          
          // Send the initialization message
            const initialMessageId = await notifyUserById(userId, initMessage);
            userListener.lastMessageId = initialMessageId || null;
          userListener.lastNotificationTime = Date.now();
            
          // Always delete message after 5 seconds
            if (initialMessageId) {
              setTimeout(async () => {
                await deleteMessageById(userId, initialMessageId);
                // Only clear lastMessageId if it's still the same message
                if (userListener?.lastMessageId === initialMessageId) {
                  userListener.lastMessageId = null;
                }
            }, 5000);
          }
          
          return;
        }

        // Update highest price if current price is higher
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

        // Execute automated trading if enabled
        if (userListener.autoTradeEnabled) {
          // Check if we should buy based on trading algorithm
          if (userListener.tradeState === 'waiting' && 
              shouldBuy(userId, tokenAddress, currentPrice, marketAnalysis)) {
            // Execute buy operation
            await executeBuy(userId, tokenAddress, tokenName, tokenSymbol);
          }
          
          // Check if we should sell based on trading algorithm (only if we're holding this token)
          if (userListener.tradeState === 'holding' && 
              userListener.tokenAddress === tokenAddress &&
              shouldSell(userId, currentPrice, marketAnalysis)) {
            // Execute sell operation
            await executeSell(userId);
          }
        }

        // Only send price update notifications for significant changes if not in auto-trading mode
        // or if explicitly requested through settings
        const minChangeThreshold = userListener.notificationThreshold;
        const isSignificantPriceChange = Math.abs(priceChangeSinceLastUpdate) >= minChangeThreshold;
        
        // For auto-trading, we only want critical notifications
        if (!userListener.autoTradeEnabled || (userListener.autoTradeEnabled && userListener.notificationMode !== 'trade_signals')) {
          // Check for critical events
          const isNewHighPrice = userListener.highestPrice !== null && Math.abs(priceChangeFromHighest) < 0.1;
          const isSellSignal = currentPrice >= (userListener.recommendedSellPrice || 0);
          const isDropFromPeak = priceChangeFromHighest <= -userListener.trailingStopLoss;
          const isStopLoss = userListener.initialPrice && currentPrice <= userListener.initialPrice * (1 - userListener.stopLoss/100);
          
          // Only notify user if there's a significant price change and not in auto-trading mode
          // or if there's a critical event (sell signal, stop loss)
          if ((isSignificantPriceChange && !userListener.autoTradeEnabled) || 
              isSellSignal || isStopLoss || isDropFromPeak) {
            
          // Replace img tag with token symbol emoji
          const tokenEmoji = tokenSymbol ? `🪙 ` : '';

            // Create notification message
            let message = `
📊 <b>Price Update for ${tokenEmoji}${tokenName} (${tokenSymbol})</b>

<b>Current Price:</b> $${currentPrice.toFixed(8)}
<b>Initial Price:</b> $${userListener.initialPrice?.toFixed(8)}
<b>Profit/Loss:</b> ${priceChangeFromInitial > 0 ? '🟢' : '🔴'} ${priceChangeFromInitial.toFixed(2)}%
`;

            // Add critical alerts
          if (isSellSignal) {
            message += `
🔔 <b>SELL SIGNAL!</b> Price has reached target sell point.
`;
          }

          if (isStopLoss) {
            message += `
⛔ <b>STOP LOSS TRIGGERED!</b> Price fell below stop loss point.
`;
            }
            
            if (isDropFromPeak) {
            message += `
⚠️ <b>Price has dropped ${Math.abs(priceChangeFromHighest).toFixed(2)}% from peak!</b>
`;
            }
            
            // Send notification (minimal for auto-trading)
            if (!userListener.autoTradeEnabled) {
              const messageId = await notifyUserById(userId, message);
              
              // Delete previous message
              if (userListener.lastMessageId) {
                await deleteMessageById(userId, userListener.lastMessageId);
              }
              
              userListener.lastMessageId = messageId || null;
              userListener.lastNotificationTime = Date.now();
              
              // Auto-delete after 5 seconds
              if (messageId) {
                setTimeout(async () => {
                  await deleteMessageById(userId, messageId);
                  if (userListener?.lastMessageId === messageId) {
                    userListener.lastMessageId = null;
                  }
                }, 5000);
              }
            }
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
  
  // Get user settings to use buyamount instead of hardcoded value
  const userSettings = await getUserSettings(userId);
  const buyAmount = userSettings.buyamount !== null ? userSettings.buyamount : 0.05; // Default to 0.05 only if buyamount not set
  
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
    pendingStop: false, // Track if we're waiting for stop confirmation
    // User customization options with defaults
    updateFrequency: 1000,
    notificationThreshold: 0.05, 
    profitTarget: 30,
    stopLoss: 10,
    trailingStopLoss: 5,
    autoSellEnabled: false,
    monitorMultipleTokens: false,
    // Notification settings with defaults
    notificationMode: 'important_only', // Default to important_only
    notificationInterval: 60000, // Default: batch every 1 minute if batched mode is used
    notificationBatchIntervalId: null,
    batchedNotifications: [],
    notificationMessageLifetime: 2000, // 2 seconds message lifetime
    muteNonCritical: false,
    lastNotificationTime: 0,
    compactMode: false,
    // Auto-trading settings with defaults
    autoTradeEnabled: true, // Enable auto-trading by default
    tradeState: 'waiting',
    tradingBudget: buyAmount, // Use buyAmount from user settings
    minProfitPercent: 3.5, // Target 3.5% minimum profit (increased from 2%)
    maxLossPercent: 1.5, // Max 1.5% loss before selling (slightly increased but still conservative)
    entryPrice: null,
    amountPurchased: null,
    totalInvested: null,
    totalReturned: null,
    lastTradeTime: null,
    profitHistory: [],
    consecutiveLosses: 0,
    consecutiveWins: 0,
    rsiValues: [],
    emaShort: null,
    emaLong: null,
    volatilityThreshold: 15, // Increased to handle higher volatility
    volumeThreshold: 15000, // Increased minimum volume threshold for more liquid tokens
    marketScannerIntervalId: null // Initialize as null
  });
  
  const startMsg = await notifyUserById(userId, `🔍 Smart listener with enhanced auto-trading activated. Using ${buyAmount} SOL per trade. Analyzing market for best opportunities...`);
  
  try {
    const userListener = activeSmartListeners.get(userId);
    if (!userListener) return;
    
    // Start batched notification interval if user is using batched mode
    if (userListener.notificationInterval > 0) {
      userListener.notificationBatchIntervalId = setInterval(() => {
        sendBatchedNotifications(userId);
      }, userListener.notificationInterval);
    }
    
    // High-frequency scanner variables
    let isHighFrequencyScanning = true;
    let scanCount = 0;
    const MAX_RAPID_SCANS = 60; // Maximum number of rapid scans before cooling down
    
    // Add this near the top of the file, with other state variables
    const processingOpportunities: Map<number, boolean> = new Map();
    
    // Then update the startMarketScanner function
    const startMarketScanner = () => {
      const scanInterval = isHighFrequencyScanning ? 1000 : 5 * 60 * 1000;
      
      return setInterval(async () => {
        try {
          const currentListener = activeSmartListeners.get(userId);
          // Only scan for new opportunities if we're not currently in a trade
          // and not already processing an opportunity
          if (currentListener && 
              currentListener.autoTradeEnabled && 
              currentListener.tradeState === 'waiting' &&
              !processingOpportunities.get(userId)) {
            
            if (isHighFrequencyScanning) {
              scanCount++;
              logger.info(`High-frequency market scan #${scanCount} for user ${userId}`);
            } else {
              logger.info(`Scheduled market scan for user ${userId}`);
            }
            
            // Find the best trading opportunity
            const bestOpportunity = await findBestTradingOpportunity(userId);
            
            if (bestOpportunity && bestOpportunity.score > 65) { // Higher threshold for auto-switching
              // Check if this is different from current token
              if (currentListener.tokenAddress !== bestOpportunity.tokenAddress) {
                // Mark this user as processing an opportunity to prevent concurrent attempts
                processingOpportunities.set(userId, true);
                
                try {
                  logger.info(`Found better trading opportunity: ${bestOpportunity.tokenName} (${bestOpportunity.tokenSymbol}) with score ${bestOpportunity.score}`);
                  
                  // Stop current monitoring
                  if (currentListener.intervalId) {
                    clearInterval(currentListener.intervalId);
                    currentListener.intervalId = null;
                  }
                  
                  // Update token address
                  currentListener.tokenAddress = bestOpportunity.tokenAddress;
                  
                  // Notify user of found opportunity
                  await notifyUserById(userId, `
📊 <b>Auto-Trader: Opportunity Found</b>

🪙 <b>${bestOpportunity.tokenName} (${bestOpportunity.tokenSymbol})</b>
<b>Address:</b> <code>${bestOpportunity.tokenAddress}</code>
<b>Smart Score:</b> ${bestOpportunity.score.toFixed(1)} (Very High)

<i>Attempting to buy this token now...</i>
                  `);
                  
                  // Stop the market scanner since we found a good opportunity
                  if (currentListener.marketScannerIntervalId) {
                    clearInterval(currentListener.marketScannerIntervalId);
                    currentListener.marketScannerIntervalId = null;
                    logger.info(`Stopped market scanner for user ${userId} after finding a good opportunity`);
                  }
                  
                  // Attempt to buy the token immediately
                  try {
                    await executeBuy(
                      userId, 
                      bestOpportunity.tokenAddress, 
                      bestOpportunity.tokenName, 
                      bestOpportunity.tokenSymbol
                    );
                    
                    // If buy is successful, start monitoring the token
                    await monitorTokenPrice(userId, bestOpportunity.tokenAddress);
                  } catch (buyError: any) {
                    logger.error(`Failed to buy token ${bestOpportunity.tokenAddress} for user ${userId}: ${buyError.message}`);
                    
                    // Only notify and stop if the user's listener is still active
                    if (activeSmartListeners.has(userId)) {
                      // Notify user of the failure
                      await notifyUserById(userId, `
❌ <b>Auto-Trader: Purchase Failed</b>

Token: <b>${bestOpportunity.tokenName} (${bestOpportunity.tokenSymbol})</b>
Error: ${buyError.message || 'Transaction failed'}

<i>Smart listener has been stopped due to purchase failure. Restart with /start_listener when ready.</i>
                  `);
                      
                      // Stop the smart listener completely if buy fails
                      stopSmartListener(userId);
                    }
                  }
                } finally {
                  // Always reset the processing flag when done to prevent deadlocks
                  processingOpportunities.set(userId, false);
                }
              }
            }
            
            // If we've been scanning rapidly for a while without finding a good match, 
            // switch to normal frequency to save resources
            if (isHighFrequencyScanning && scanCount >= MAX_RAPID_SCANS) {
              isHighFrequencyScanning = false;
              logger.info(`Reached maximum rapid scans (${MAX_RAPID_SCANS}), switching to normal frequency for user ${userId}`);
              
              // Notify user
              await notifyUserById(userId, `
📊 <b>Market Scanner Update</b>
Initial high-speed market scan complete. Switching to regular monitoring.
<i>Will continue to check for opportunities every 5 minutes.</i>
              `);
              
              // Clear the current interval and start a new one with normal frequency
              if (currentListener.marketScannerIntervalId) {
                clearInterval(currentListener.marketScannerIntervalId);
              }
              currentListener.marketScannerIntervalId = startMarketScanner();
            }
          }
        } catch (error: any) {
          logger.error(`Error in market scanner interval for user ${userId}: ${error.message}`, error);
          // Reset processing flag on error
          processingOpportunities.set(userId, false);
        }
      }, scanInterval);
    };
    
    // Start the market scanner with initial high frequency
    userListener.marketScannerIntervalId = startMarketScanner();
    
    // Then continue with the initial market scan...
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
  
  // Check if user is holding tokens and show profit/loss before stopping
  if (userListener.tradeState === 'holding' && userListener.tokenAddress) {
    // Get token details
    const tokenAddress = userListener.tokenAddress;
    const entryPrice = userListener.entryPrice || 0;
    const currentPrice = userListener.lastPrice || 0;
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const amountPurchased = userListener.amountPurchased || 0;
    const totalInvested = userListener.totalInvested || 0;
    
    // Calculate current values
    const currentValue = amountPurchased * currentPrice;
    const profitLoss = currentValue - totalInvested;
    
    // Ask user for confirmation before stopping and selling
    notifyUserById(
      userId,
      `⚠️ <b>Smart Listener Stopping</b>

You currently hold ${amountPurchased.toLocaleString()} tokens worth approximately ${currentValue.toFixed(4)} SOL
 
<b>Position Status:</b> ${profitPercent >= 0 ? '📈 In Profit' : '📉 In Loss'}
<b>Profit/Loss:</b> ${profitLoss.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)

<i>Do you want to sell your tokens before stopping?</i>
Use /confirm_sell to sell and stop, or /just_stop to stop without selling.
`
    );
    
    // Don't actually stop now - wait for user confirmation
    // Set a flag to indicate we're waiting for confirmation
    userListener.pendingStop = true;
    return;
  }
  
  // If not holding tokens or user already confirmed, proceed with stopping
  doStopSmartListener(userId);
};

// New helper function to actually stop the listener
const doStopSmartListener = (userId: number): void => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) {
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
  
  // Clear market scanner interval if it exists
  if (userListener.marketScannerIntervalId) {
    clearInterval(userListener.marketScannerIntervalId);
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

// New function to confirm sell and stop
export const confirmSellAndStop = async (userId: number): Promise<void> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || !userListener.pendingStop) {
    await notifyUserById(userId, `❌ No pending stop request. Use /stop_listener first.`);
    return;
  }
  
  if (userListener.tradeState === 'holding' && userListener.tokenAddress) {
    // Sell tokens first
    await notifyUserById(userId, `🔄 Selling tokens before stopping...`);
    
    try {
      await executeSell(userId);
      await notifyUserById(userId, `✅ Successfully sold tokens. Smart listener stopped.`);
    } catch (error: any) {
      logger.error(`Error selling tokens before stopping: ${error.message}`);
      await notifyUserById(userId, `⚠️ Failed to sell tokens: ${error.message}. Smart listener stopped anyway.`);
    }
  }
  
  // Then stop the listener
  doStopSmartListener(userId);
};

// New function to just stop without selling
export const justStop = (userId: number): void => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || !userListener.pendingStop) {
    notifyUserById(userId, `❌ No pending stop request. Use /stop_listener first.`);
    return;
  }
  
  notifyUserById(userId, `✅ Smart listener stopped without selling.`);
  doStopSmartListener(userId);
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
    notificationMessageLifetime: 2000, // 2 seconds message lifetime
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
  // Auto-trading settings
  autoTradeEnabled: boolean;
  tradingBudget: number;
  minProfitPercent: number;
  maxLossPercent: number;
  volatilityThreshold: number;
  volumeThreshold: number;
}>): void => {
  // Get the current listener or initialize with default settings
  let userListener = activeSmartListeners.get(userId);
  
  if (!userListener) {
    // Get user settings to use buyamount instead of hardcoded value
    getUserSettings(userId).then(userSettings => {
      const buyAmount = userSettings.buyamount !== null ? userSettings.buyamount : 0.05; // Default to 0.05 only if buyamount not set
      
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
        pendingStop: false, // Add this missing property
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
        notificationMessageLifetime: 2000,
        muteNonCritical: false,
        lastNotificationTime: 0,
        compactMode: false,
        // Auto-trading defaults
        autoTradeEnabled: true,
        tradeState: 'waiting',
        tradingBudget: buyAmount, // Use user's buyAmount from settings
        minProfitPercent: 2,
        maxLossPercent: 1,
        entryPrice: null,
        amountPurchased: null,
        totalInvested: null,
        totalReturned: null,
        lastTradeTime: null,
        profitHistory: [],
        consecutiveLosses: 0,
        consecutiveWins: 0,
        rsiValues: [],
        emaShort: null,
        emaLong: null,
        volatilityThreshold: 10,
        volumeThreshold: 10000,
        marketScannerIntervalId: null
      };
      activeSmartListeners.set(userId, userListener);
      
      // Apply the settings
      Object.assign(userListener, settings);
    }).catch(error => {
      logger.error(`Error getting user settings: ${error.message}`, error);
    });
    return;
  }
  
  // Handle special case for enabling/disabling auto-trading
  if (settings.autoTradeEnabled !== undefined && 
      settings.autoTradeEnabled !== userListener.autoTradeEnabled) {
    
    // If enabling auto-trading
    if (settings.autoTradeEnabled) {
      // Reset trading state
      userListener.tradeState = 'waiting';
      userListener.entryPrice = null;
      userListener.amountPurchased = null;
      userListener.totalInvested = null;
      userListener.totalReturned = null;
      userListener.lastTradeTime = null;
      
      // Send a notification
      notifyUserById(userId, `✅ Auto-trading has been enabled. The bot will now automatically buy and sell tokens.`);
    } else {
      // If currently holding and auto-trading is being disabled, sell holdings
      if (userListener.tradeState === 'holding' && userListener.tokenAddress) {
        // Notify user about selling current holdings
        notifyUserById(userId, `⚠️ Auto-trading has been disabled. Selling current holdings...`);
        
        // Execute a sell if we're holding something
        executeSell(userId).then(() => {
          notifyUserById(userId, `✅ Auto-trading disabled. Current holdings have been sold.`);
        }).catch((error) => {
          logger.error(`Error selling holdings while disabling auto-trading: ${error.message}`);
          notifyUserById(userId, `⚠️ Could not sell current holdings. Please manually sell if desired.`);
        });
      } else {
        // Just notify if no current holdings
        notifyUserById(userId, `✅ Auto-trading has been disabled.`);
      }
    }
  }
  
  // Update settings (userListener is guaranteed to be defined here)
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
      
      // Always delete message after 2 seconds
      if (messageId) {
        setTimeout(async () => {
          await deleteMessageById(userId, messageId);
          // Only clear lastMessageId if it's still the same message
          if (userListener && userListener.lastMessageId === messageId) {
            userListener.lastMessageId = null;
          }
        }, 2000);
      }
    }
    
    // Clear the batch
    userListener.batchedNotifications = [];
    
  } catch (error: any) {
    logger.error(`Error sending batched notifications to user ${userId}: ${error.message}`, error);
  }
}; 

// After the getMarketRecommendation function, add:

/**
 * Calculate Relative Strength Index (RSI) for momentum-based trading
 * @param prices Array of recent price data points
 * @param period Period for RSI calculation (default 14)
 * @returns RSI value (0-100)
 */
const calculateRSI = (prices: number[], period: number = 14): number => {
  if (prices.length < period + 1) {
    // Not enough data points
    return 50; // Return neutral value
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // Get only the changes for the requested period
  const recentChanges = changes.slice(-period);

  // Calculate average gains and losses
  let gains = 0;
  let losses = 0;

  for (const change of recentChanges) {
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  // Calculate average gain and loss
  const avgGain = gains / period;
  const avgLoss = losses / period;

  // Calculate RS and RSI
  if (avgLoss === 0) {
    return 100; // If no losses, RSI is 100
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
};

/**
 * Calculate Exponential Moving Average (EMA)
 * @param prices Array of price data points
 * @param period Period for EMA calculation
 * @param previousEMA Previous EMA value (if available)
 * @returns EMA value
 */
const calculateEMA = (prices: number[], period: number, previousEMA: number | null = null): number => {
  if (prices.length < period) {
    // Not enough data, use simple average
    return prices.reduce((sum, price) => sum + price, 0) / prices.length;
  }

  const k = 2 / (period + 1); // Smoothing factor

  if (previousEMA === null) {
    // First EMA calculation uses SMA as base
    const sma = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
    previousEMA = sma;
  }

  // Calculate EMA using the most recent price
  const currentPrice = prices[prices.length - 1];
  return (currentPrice * k) + (previousEMA * (1 - k));
};

/**
 * Check if current price conditions are good for buying
 * @param userId User ID
 * @param tokenAddress Token address
 * @param currentPrice Current token price
 * @param analysis Market analysis data
 * @returns Boolean indicating if it's a good time to buy
 */
const shouldBuy = (
  userId: number,
  tokenAddress: string,
  currentPrice: number,
  analysis: TokenMarketAnalysis
): boolean => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) return false;

  // If we've already bought this token and are holding, don't buy more
  if (userListener.tradeState === 'holding' && userListener.tokenAddress === tokenAddress) {
    return false;
  }

  // If we're currently in a selling process, don't buy
  if (userListener.tradeState === 'selling') {
    return false;
  }

  // Calculate momentum and trend indicators
  const rsi = calculateRSI(analysis.priceHistory);
  userListener.rsiValues.push(rsi);
  
  // If array is too long, trim it
  if (userListener.rsiValues.length > 20) {
    userListener.rsiValues = userListener.rsiValues.slice(-20);
  }

  // Calculate short and long EMAs
  userListener.emaShort = calculateEMA(analysis.priceHistory, 5, userListener.emaShort);
  userListener.emaLong = calculateEMA(analysis.priceHistory, 20, userListener.emaLong);
  
  // Calculate additional indicators for better decision making
  const ema50 = calculateEMA(analysis.priceHistory, 50, null);
  const macd = calculateMACD(analysis.priceHistory);
  const priceVelocity = calculatePriceVelocity(analysis.priceHistory);
  const volumeIncreasing = isVolumeIncreasing(analysis.volumeHistory);
  
  // Check for bullish divergence between price and RSI (powerful buy signal)
  const hasBullishDivergence = checkBullishDivergence(analysis.priceHistory, userListener.rsiValues);

  // Advanced buy conditions:
  
  // 1. RSI is coming up from oversold territory (below 30)
  const rsiOversoldRecovery = userListener.rsiValues.length >= 3 && 
                     userListener.rsiValues[userListener.rsiValues.length - 3] < 30 && 
                     userListener.rsiValues[userListener.rsiValues.length - 2] < 30 &&
                     userListener.rsiValues[userListener.rsiValues.length - 1] > 30 &&
                     userListener.rsiValues[userListener.rsiValues.length - 1] > userListener.rsiValues[userListener.rsiValues.length - 2];
  
  // 2. Golden Cross (short EMA crosses above long EMA)
  const goldenCross = userListener.emaShort !== null && 
                      userListener.emaLong !== null && 
                      userListener.emaShort > userListener.emaLong &&
                      // Ensure the crossover just happened
                      analysis.priceHistory.length >= 2 &&
                      calculateEMA(analysis.priceHistory.slice(0, -1), 5, null) < 
                      calculateEMA(analysis.priceHistory.slice(0, -1), 20, null);
  
  // 3. Price is above 50 EMA (overall uptrend)
  const priceAboveLongTermMA = currentPrice > ema50;
  
  // 4. MACD is positive or just crossed positive
  const macdPositive = macd.histogram > 0 || 
                      (macd.histogram > macd.previousHistogram && macd.previousHistogram < 0);
  
  // 5. Positive price velocity (momentum)
  const positiveVelocity = priceVelocity > 0;
  
  // 6. Market sentiment is positive or neutral
  const marketSentiment = analysis.trends.overallSentiment !== 'strong_sell' && 
                         analysis.trends.overallSentiment !== 'sell';
  
  // 7. Volume is increasing (more buyers entering)
  // 8. We have enough price history to make a good decision
  const enoughHistory = analysis.priceHistory.length >= 20;
  
  // More conservative or aggressive based on past performance
  if (userListener.consecutiveLosses >= 3) {
    // After multiple losses, be more conservative - require stronger signals
    return (
      (rsiOversoldRecovery && marketSentiment && priceAboveLongTermMA) || 
      (goldenCross && macdPositive && volumeIncreasing) ||
      (hasBullishDivergence && marketSentiment) || // Bullish divergence is a strong signal
      (analysis.trends.overallSentiment === 'strong_buy' && volumeIncreasing && positiveVelocity)
    ) && enoughHistory;
  } else if (userListener.consecutiveWins >= 2) {
    // After wins, we can be slightly more aggressive
    return (
      (rsiOversoldRecovery || goldenCross || hasBullishDivergence) &&
      (marketSentiment || positiveVelocity) &&
      enoughHistory
    );
  }
  
  // Standard decision logic with multiple confirmation factors
  return (
    ((rsiOversoldRecovery || goldenCross || hasBullishDivergence) && marketSentiment) ||
    (macdPositive && volumeIncreasing && marketSentiment) ||
    (analysis.trends.overallSentiment === 'strong_buy' && positiveVelocity)
  ) && enoughHistory;
};

/**
 * Check if current price conditions indicate we should sell
 * @param userId User ID
 * @param currentPrice Current token price
 * @param analysis Market analysis data
 * @returns Boolean indicating if it's time to sell
 */
const shouldSell = (
  userId: number, 
  currentPrice: number,
  analysis: TokenMarketAnalysis
): boolean => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || userListener.tradeState !== 'holding' || !userListener.entryPrice) {
    return false;
  }

  // Calculate profit/loss percentage
  const profitPercent = ((currentPrice - userListener.entryPrice) / userListener.entryPrice) * 100;
  
  // Calculate RSI for overbought condition
  const rsi = calculateRSI(analysis.priceHistory);
  userListener.rsiValues.push(rsi);
  
  // If array is too long, trim it
  if (userListener.rsiValues.length > 20) {
    userListener.rsiValues = userListener.rsiValues.slice(-20);
  }
  
  // Calculate additional technical indicators
  const macd = calculateMACD(analysis.priceHistory);
  const priceVelocity = calculatePriceVelocity(analysis.priceHistory);
  const volumeDecreasing = !isVolumeIncreasing(analysis.volumeHistory);
  
  // Check for bearish divergence (price makes higher highs but RSI makes lower highs - sell signal)
  const hasBearishDivergence = checkBearishDivergence(analysis.priceHistory, userListener.rsiValues);

  // Advanced sell conditions:
  
  // 1. Stop-loss hit (price dropped below our max loss threshold)
  const stopLossHit = profitPercent <= -userListener.maxLossPercent;
  
  // 2. Trailing stop loss hit (price dropped significantly from its peak)
  const highestPrice = userListener.highestPrice || userListener.entryPrice;
  const dropFromPeak = ((currentPrice - highestPrice) / highestPrice) * 100;
  
  // Use a dynamic trailing stop based on volatility and profit level
  let dynamicTrailingStop = userListener.trailingStopLoss;
  
  // If we're in significant profit, protect more of it with tighter stop
  if (profitPercent > 15) {
    dynamicTrailingStop = Math.max(1, userListener.trailingStopLoss / 2); // Tighter stop when in high profit
  } else if (profitPercent > 5) {
    dynamicTrailingStop = Math.max(1.5, userListener.trailingStopLoss * 0.7); // Moderately tight stop
  }
  
  // Adjust based on volatility - use a wider stop for highly volatile tokens
  if (analysis.volatility > 15) {
    dynamicTrailingStop = dynamicTrailingStop * 1.5; // 50% wider stop for high volatility
  }
  
  const trailingStopHit = userListener.highestPrice !== null && 
                          dropFromPeak <= -dynamicTrailingStop &&
                          profitPercent > 0; // Only use trailing stop when in profit
  
  // 3. Profit target reached with acceleration (increasing profit targets as profits grow)
  let dynamicProfitTarget = userListener.minProfitPercent;
  
  // Increase profit target with time if we're still in uptrend
  const timeHeld = userListener.lastTradeTime ? (Date.now() - userListener.lastTradeTime) / (1000 * 60 * 60) : 0; // Hours held
  if (timeHeld > 6 && priceVelocity > 0 && analysis.trends.overallSentiment !== 'sell' && analysis.trends.overallSentiment !== 'strong_sell') {
    // If we've held for over 6 hours and still in uptrend, increase target
    dynamicProfitTarget = userListener.minProfitPercent * (1 + (timeHeld / 24)); // Increase by time held
  }
  
  const profitTargetHit = profitPercent >= dynamicProfitTarget;
  
  // 4. RSI indicates overbought condition (above 70)
  const rsiOverbought = rsi > 70 && profitPercent > 0;
  
  // 5. MACD bearish cross (histogram turns negative after being positive)
  const macdBearishCross = macd.previousHistogram > 0 && macd.histogram < 0;
  
  // 6. EMA crossover (short crosses below long) - bearish signal
  const emaCrossover = userListener.emaShort !== null && 
                      userListener.emaLong !== null && 
                      userListener.emaShort < userListener.emaLong &&
                      // Ensure the crossover just happened
                      analysis.priceHistory.length >= 2 &&
                      calculateEMA(analysis.priceHistory.slice(0, -1), 5, null) > 
                      calculateEMA(analysis.priceHistory.slice(0, -1), 20, null);
  
  // 7. Check if market sentiment has turned negative while in profit
  const bearishMarket = (analysis.trends.overallSentiment === 'sell' || 
                         analysis.trends.overallSentiment === 'strong_sell') && 
                         profitPercent > 0;
  
  // 8. Volume pattern indicating distribution (price up, volume decreasing - sign of weakening uptrend)
  const isDistributionPattern = priceVelocity > 0 && volumeDecreasing;

  // More aggressive selling if we've had consecutive wins to lock in profits
  if (userListener.consecutiveWins >= 2) {
    // Lock in profits faster after multiple wins
    return (
      stopLossHit || 
      trailingStopHit || 
      profitTargetHit || 
      (rsiOverbought && profitPercent > userListener.minProfitPercent / 2) || 
      (macdBearishCross && profitPercent > 0) ||
      (emaCrossover && profitPercent > 0) || 
      hasBearishDivergence ||
      bearishMarket
    );
  } else if (userListener.consecutiveLosses >= 2) {
    // After consecutive losses, be more cautious and take profits earlier
    return (
      stopLossHit || 
      trailingStopHit || 
      (profitPercent >= userListener.minProfitPercent * 0.7) || // Take profits earlier
      (rsiOverbought && profitPercent > 0) ||
      (macdBearishCross && profitPercent > 0) ||
      bearishMarket
    );
  }
  
  // Standard decision with multiple confirmation factors
  return (
    stopLossHit || 
    trailingStopHit || 
    profitTargetHit || 
    (rsiOverbought && profitTargetHit) || 
    (macdBearishCross && profitPercent > userListener.minProfitPercent * 0.8) || 
    (emaCrossover && profitPercent > userListener.minProfitPercent * 0.8) || 
    (hasBearishDivergence && profitPercent > userListener.minProfitPercent * 0.5) ||
    (isDistributionPattern && profitPercent > userListener.minProfitPercent) ||
    bearishMarket
  );
};

/**
 * Execute buy transaction and update trading state
 * @param userId User ID
 * @param tokenAddress Token address to buy
 * @param tokenName Token name for notifications
 * @param tokenSymbol Token symbol for notifications
 */
const executeBuy = async (
  userId: number,
  tokenAddress: string,
  tokenName: string,
  tokenSymbol: string
): Promise<void> => {
  // Get the user listener outside the try/catch to ensure it exists
  const userListener = activeSmartListeners.get(userId);
  if (!userListener) {
    throw new Error('No active smart listener found');
  }

  // Check if we're already in a buying state to prevent duplicate attempts
  if (userListener.tradeState !== 'waiting') {
    logger.warn(`Skipping buy attempt for ${tokenAddress} - user ${userId} is already in ${userListener.tradeState} state`);
    throw new Error(`Cannot execute buy while in ${userListener.tradeState} state`);
  }

  // Set the trade state to buying immediately to prevent concurrent buy attempts
  userListener.tradeState = 'buying';

  try {
    // Notify user of purchase attempt
    await notifyUserById(userId, `
🔄 <b>Auto-Trader: Purchasing Token</b>

<b>${tokenName} (${tokenSymbol})</b>
<b>Budget:</b> ${userListener.tradingBudget} SOL

<i>Transaction in progress...</i>
    `);

    // Validate token before attempting to purchase
    if (!isValidMint(tokenAddress)) {
      throw new Error('Invalid token mint address');
    }

    // Verify trading budget is valid 
    if (!userListener.tradingBudget || userListener.tradingBudget <= 0) {
      throw new Error('Invalid trading budget. Please set a buy amount using /set_buy_amount');
    }

    // Get token pair address to ensure it's tradable
    const pairAddress = await findPairAddress(tokenAddress);
    if (!pairAddress) {
      throw new Error('Unable to find trading pair for this token');
    }

    // Check if token has sufficient liquidity
    const priceInfo = await fetchTokenPriceInfo(pairAddress);
    if (!priceInfo) {
      throw new Error('Unable to fetch price info for this token');
    }

    // Ensure minimum liquidity for safer trading
    if (!priceInfo.liquidity?.usd || priceInfo.liquidity.usd < 5000) {
      throw new Error(`Insufficient liquidity ($${priceInfo.liquidity?.usd || 0}). Minimum $5000 required.`);
    }

    // Prepare token info for purchase
    const tokenInfo: TokenInfo = {
      mintAddress: tokenAddress,
      name: tokenName,
      symbol: tokenSymbol
    };

    // Purchase token with configured budget
    const purchaseResult = await purchaseToken(userId, tokenInfo, userListener.tradingBudget);

    if (!purchaseResult.success) {
      throw new Error('Failed to execute purchase transaction');
    }

    // Ensure the listener is still active after the purchase
    const listenerAfterPurchase = activeSmartListeners.get(userId);
    if (!listenerAfterPurchase) {
      logger.warn(`User listener was removed during purchase for user ${userId}`);
      return; // Exit gracefully without updating state
    }

    // Update listener with purchase details
    listenerAfterPurchase.tradeState = 'holding';
    listenerAfterPurchase.entryPrice = purchaseResult.entryPrice || 0;
    listenerAfterPurchase.amountPurchased = purchaseResult.tokensPurchased || 0;
    listenerAfterPurchase.totalInvested = purchaseResult.amountSpent || 0;
    listenerAfterPurchase.lastTradeTime = Date.now();

    // Get logo for richer notifications
    const logoUrl = await enhancedFetchTokenLogo(tokenAddress);
    listenerAfterPurchase.logoUrl = logoUrl;

    // Notify user of successful purchase
    let purchaseMessage = `
✅ <b>Auto-Trader: Purchase Successful</b>

${logoUrl ? `<a href="https://solscan.io/token/${tokenAddress}">&#8205;</a>` : ''}🪙 <b>${tokenName} (${tokenSymbol})</b>
<b>Amount:</b> ${(purchaseResult.tokensPurchased || 0).toLocaleString()} tokens
<b>Spent:</b> ${(purchaseResult.amountSpent || 0).toFixed(4)} SOL
<b>Entry Price:</b> ${(purchaseResult.entryPrice || 0).toFixed(8)} SOL/token
<b>Transaction:</b> <a href="https://solscan.io/tx/${purchaseResult.txId}">View on SolScan</a>

<i>Now monitoring for optimal sell conditions...</i>
`;

    await notifyUserById(userId, purchaseMessage);

    // Reset monitoring logic to watch the newly purchased token
    listenerAfterPurchase.initialPrice = null;
    listenerAfterPurchase.lastPrice = null;
    listenerAfterPurchase.highestPrice = null;
    listenerAfterPurchase.recommendedSellPrice = null;

    logger.info(`Successfully purchased ${tokenName} for user ${userId}`);
  } catch (error: any) {
    // Only reset state if the listener still exists
    const listenerAfterError = activeSmartListeners.get(userId);
    if (listenerAfterError && listenerAfterError.tradeState === 'buying') {
      listenerAfterError.tradeState = 'waiting';
      logger.info(`Reset trade state to waiting for user ${userId} after purchase error`);
    }
    
    logger.error(`Error executing buy for user ${userId}: ${error.message}`, error);
    
    // Throw the error to be handled by the caller
    throw new Error(`Purchase failed: ${error.message}`);
  }
};

/**
 * Execute sell transaction and update trading state
 * @param userId User ID
 */
const executeSell = async (userId: number): Promise<void> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || !userListener.autoTradeEnabled || userListener.tradeState !== 'holding' || !userListener.tokenAddress) {
    return;
  }
  
  try {
    // Update state to indicate we're selling
    userListener.tradeState = 'selling';
    
    // Get token details
    const tokenAddress = userListener.tokenAddress;
    let tokenName = 'Unknown';
    let tokenSymbol = 'Unknown';
    
    try {
      const metadata = await enhancedFetchTokenMetadata(tokenAddress);
      tokenName = metadata.name;
      tokenSymbol = metadata.symbol;
    } catch (error) {
      logger.warn(`Failed to fetch metadata for token ${tokenAddress}`);
    }
    
    // Prepare TokenInfo object
    const tokenInfo: TokenInfo = { mintAddress: tokenAddress };
    
    // Calculate profit/loss so far
    const currentPrice = userListener.lastPrice || 0;
    const entryPrice = userListener.entryPrice || 0;
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Notify user we're selling
    await notifyUserById(
      userId,
      `🔄 <b>AUTO-TRADE:</b> Selling ${tokenName} (${tokenSymbol}) at ${profitPercent.toFixed(2)}% ${profitPercent >= 0 ? 'profit' : 'loss'}...`
    );
    
    // Execute sale (sell 100% of holdings)
    const sellResult = await sellToken(userId, tokenInfo, 100);
    
    if (sellResult.success) {
      // Update trading state with sale info
      userListener.totalReturned = sellResult.amountReceived || 0;
      
      // Calculate profit/loss
      const invested = userListener.totalInvested || 0;
      const returned = userListener.totalReturned || 0; // Use 0 if null
      const profit = returned - invested;
      const profitPercent = invested > 0 ? (profit / invested) * 100 : 0;
      
      // Add to profit history
      userListener.profitHistory.push({
        tokenAddress,
        buyPrice: entryPrice,
        sellPrice: sellResult.exitPrice || 0,
        profit,
        profitPercent,
        timestamp: Date.now()
      });
      
      // Update consecutive wins/losses
      if (profit > 0) {
        userListener.consecutiveWins++;
        userListener.consecutiveLosses = 0;
      } else {
        userListener.consecutiveLosses++;
        userListener.consecutiveWins = 0;
      }
      
      // Reset trading state
      userListener.tradeState = 'waiting';
      userListener.tokenAddress = null;
      userListener.entryPrice = null;
      userListener.amountPurchased = null;
      userListener.totalInvested = null;
      userListener.highestPrice = null;
      userListener.initialPrice = null;
      
      // Notify user of successful sale
      await notifyUserById(
        userId,
        `${profit >= 0 ? '✅' : '⚠️'} <b>AUTO-TRADE: SELL COMPLETE</b> 
        
<b>${tokenName} (${tokenSymbol})</b>
<b>Amount Received:</b> ${sellResult.amountReceived?.toFixed(4)} SOL
<b>Tokens Sold:</b> ${sellResult.tokensSold?.toLocaleString()}
<b>Exit Price:</b> $${sellResult.exitPrice?.toFixed(8)}
<b>Profit/Loss:</b> ${profit.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)

<i>Looking for next trading opportunity...</i>
        `
      );
      
      logger.info(`Auto-trade: Successfully sold ${tokenName} (${tokenSymbol}) for user ${userId} with ${profitPercent.toFixed(2)}% ${profit >= 0 ? 'profit' : 'loss'}`);
    } else {
      // If sale failed, reset state back to holding
      userListener.tradeState = 'holding';
      
      // Notify user of failure
      await notifyUserById(
        userId,
        `❌ <b>AUTO-TRADE: SELL FAILED</b> 
        
Could not sell ${tokenName} (${tokenSymbol}). Will try again soon.
        `
      );
      
      logger.error(`Auto-trade: Failed to sell ${tokenName} (${tokenSymbol}) for user ${userId}`);
    }
  } catch (error: any) {
    // Reset state if error occurs
    if (userListener) {
      userListener.tradeState = 'holding'; // Go back to holding state
    }
    
    logger.error(`Error in executeSell for user ${userId}: ${error.message}`, error);
    await notifyUserById(userId, `❌ Error in auto-trade sell: ${error.message}`);
  }
};

/**
 * Get auto-trading statistics for a user
 * @param userId User ID
 * @returns Trading statistics
 */
export const getAutoTradingStats = (userId: number): {
  enabled: boolean;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  averageProfit: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  currentlyHolding: boolean;
  currentHoldingInfo: {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    entryPrice: number;
    currentPrice: number;
    currentProfit: number;
    currentProfitPercent: number;
  } | null;
} => {
  const userListener = activeSmartListeners.get(userId);
  
  // Default stats
  const defaultStats = {
    enabled: false,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalProfit: 0,
    totalLoss: 0,
    netProfit: 0,
    averageProfit: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    currentlyHolding: false,
    currentHoldingInfo: null
  };
  
  if (!userListener || !userListener.autoTradeEnabled) {
    return defaultStats;
  }
  
  const stats = {
    enabled: userListener.autoTradeEnabled,
    totalTrades: userListener.profitHistory.length,
    winningTrades: 0,
    losingTrades: 0,
    totalProfit: 0,
    totalLoss: 0,
    netProfit: 0,
    averageProfit: 0,
    averageLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    winRate: 0, // Initialize winRate property
    currentlyHolding: userListener.tradeState === 'holding',
    currentHoldingInfo: null as any
  };
  
  // Calculate stats from profit history
  for (const trade of userListener.profitHistory) {
    if (trade.profit > 0) {
      stats.winningTrades++;
      stats.totalProfit += trade.profit;
      stats.largestWin = Math.max(stats.largestWin, trade.profit);
    } else {
      stats.losingTrades++;
      stats.totalLoss += Math.abs(trade.profit);
      stats.largestLoss = Math.max(stats.largestLoss, Math.abs(trade.profit));
    }
  }
  
  // Calculate derived stats
  stats.netProfit = stats.totalProfit - stats.totalLoss;
  stats.winRate = stats.totalTrades > 0 ? (stats.winningTrades / stats.totalTrades) * 100 : 0;
  stats.averageProfit = stats.winningTrades > 0 ? stats.totalProfit / stats.winningTrades : 0;
  stats.averageLoss = stats.losingTrades > 0 ? stats.totalLoss / stats.losingTrades : 0;
  
  // Get current holding info if applicable
  if (stats.currentlyHolding && userListener.tokenAddress && userListener.entryPrice && userListener.lastPrice) {
    const currentProfit = userListener.lastPrice - userListener.entryPrice;
    const currentProfitPercent = (currentProfit / userListener.entryPrice) * 100;
    
    stats.currentHoldingInfo = {
      tokenAddress: userListener.tokenAddress,
      tokenName: 'Token', // Placeholder, would need async call
      tokenSymbol: 'TKN', // Placeholder, would need async call
      entryPrice: userListener.entryPrice,
      currentPrice: userListener.lastPrice,
      currentProfit,
      currentProfitPercent
    };
  }
  
  return stats;
};

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * @param prices Array of price data
 * @returns MACD values
 */
const calculateMACD = (prices: number[]): { line: number; signal: number; histogram: number; previousHistogram: number } => {
  if (prices.length < 26) {
    return { line: 0, signal: 0, histogram: 0, previousHistogram: 0 };
  }

  // Calculate the 12-day EMA
  const ema12 = calculateEMA(prices, 12, null);
  
  // Calculate the 26-day EMA
  const ema26 = calculateEMA(prices, 26, null);
  
  // Calculate the MACD line
  const macdLine = ema12 - ema26;
  
  // Calculate the previous MACD values for comparison
  const previousPrices = prices.slice(0, -1);
  const previousEma12 = calculateEMA(previousPrices, 12, null);
  const previousEma26 = calculateEMA(previousPrices, 26, null);
  const previousMacdLine = previousEma12 - previousEma26;
  
  // Generate 9 historical MACD values to calculate signal line
  const macdHistory: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (i >= prices.length - 26) {
      const histPrices = prices.slice(0, prices.length - i);
      if (histPrices.length >= 26) {
        const histEma12 = calculateEMA(histPrices, 12, null);
        const histEma26 = calculateEMA(histPrices, 26, null);
        macdHistory.unshift(histEma12 - histEma26);
      } else {
        macdHistory.unshift(0);
      }
    } else {
      macdHistory.unshift(0);
    }
  }
  
  // Add current MACD to history
  macdHistory.push(macdLine);
  
  // Calculate the 9-day EMA of the MACD line (signal line)
  const signalLine = calculateEMA(macdHistory, 9, null);
  
  // Calculate MACD histogram (MACD line - signal line)
  const histogram = macdLine - signalLine;
  
  // Calculate previous histogram
  const previousSignalLine = calculateEMA(macdHistory.slice(0, -1), 9, null);
  const previousHistogram = previousMacdLine - previousSignalLine;
  
  return {
    line: macdLine,
    signal: signalLine,
    histogram: histogram,
    previousHistogram: previousHistogram
  };
};

/**
 * Calculate price velocity (rate of price change)
 * @param prices Array of price data
 * @returns Price velocity value
 */
const calculatePriceVelocity = (prices: number[]): number => {
  if (prices.length < 5) return 0;
  
  // Get the last 5 prices
  const recentPrices = prices.slice(-5);
  
  // Calculate percentage changes between consecutive prices
  const changes: number[] = [];
  for (let i = 1; i < recentPrices.length; i++) {
    const change = (recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1];
    changes.push(change);
  }
  
  // Calculate average rate of change (velocity)
  const velocity = changes.reduce((sum, change) => sum + change, 0) / changes.length;
  
  return velocity;
};

/**
 * Check if volume is increasing (indicates building momentum)
 * @param volumes Array of volume data
 * @returns Boolean indicating if volume is increasing
 */
const isVolumeIncreasing = (volumes: number[]): boolean => {
  if (volumes.length < 3) return false;
  
  // Get the last 3 volume points
  const recentVolumes = volumes.slice(-3);
  
  // Check if the trend is increasing
  return recentVolumes[2] > recentVolumes[1] && recentVolumes[1] >= recentVolumes[0];
};

/**
 * Check for bullish divergence between price and RSI
 * (When price makes lower lows but RSI makes higher lows - strong buy signal)
 * @param prices Price history array
 * @param rsiValues RSI history array
 * @returns Boolean indicating if bullish divergence is detected
 */
const checkBullishDivergence = (prices: number[], rsiValues: number[]): boolean => {
  if (prices.length < 10 || rsiValues.length < 10) return false;
  
  // Get recent prices and RSI values
  const recentPrices = prices.slice(-10);
  const recentRSI = rsiValues.slice(-10);
  
  // Find local minima in both price and RSI
  const priceMinima: number[] = [];
  const rsiMinima: number[] = [];
  
  for (let i = 1; i < recentPrices.length - 1; i++) {
    // Check if this point is a local minimum in price
    if (recentPrices[i] < recentPrices[i-1] && recentPrices[i] < recentPrices[i+1]) {
      priceMinima.push(i);
    }
    
    // Check if this point is a local minimum in RSI
    if (recentRSI[i] < recentRSI[i-1] && recentRSI[i] < recentRSI[i+1]) {
      rsiMinima.push(i);
    }
  }
  
  // We need at least 2 minima points to check for divergence
  if (priceMinima.length < 2 || rsiMinima.length < 2) return false;
  
  // Get the last two price minima and corresponding RSI values
  const lastPriceMin = priceMinima[priceMinima.length - 1];
  const prevPriceMin = priceMinima[priceMinima.length - 2];
  
  // Get the last two RSI minima
  const lastRsiMin = rsiMinima[rsiMinima.length - 1];
  const prevRsiMin = rsiMinima[rsiMinima.length - 2];
  
  // Check for bullish divergence:
  // Price: lower lows (second minimum is lower than first)
  // RSI: higher lows (second minimum is higher than first)
  const priceMakingLowerLows = recentPrices[lastPriceMin] < recentPrices[prevPriceMin];
  const rsiMakingHigherLows = recentRSI[lastRsiMin] > recentRSI[prevRsiMin];
  
  return priceMakingLowerLows && rsiMakingHigherLows;
};

/**
 * Check for bearish divergence between price and RSI
 * (When price makes higher highs but RSI makes lower highs - strong sell signal)
 * @param prices Price history array
 * @param rsiValues RSI history array
 * @returns Boolean indicating if bearish divergence is detected
 */
const checkBearishDivergence = (prices: number[], rsiValues: number[]): boolean => {
  if (prices.length < 10 || rsiValues.length < 10) return false;
  
  // Get recent prices and RSI values
  const recentPrices = prices.slice(-10);
  const recentRSI = rsiValues.slice(-10);
  
  // Find local maxima in both price and RSI
  const priceMaxima: number[] = [];
  const rsiMaxima: number[] = [];
  
  for (let i = 1; i < recentPrices.length - 1; i++) {
    // Check if this point is a local maximum in price
    if (recentPrices[i] > recentPrices[i-1] && recentPrices[i] > recentPrices[i+1]) {
      priceMaxima.push(i);
    }
    
    // Check if this point is a local maximum in RSI
    if (recentRSI[i] > recentRSI[i-1] && recentRSI[i] > recentRSI[i+1]) {
      rsiMaxima.push(i);
    }
  }
  
  // We need at least 2 maxima points to check for divergence
  if (priceMaxima.length < 2 || rsiMaxima.length < 2) return false;
  
  // Get the last two price maxima and corresponding RSI values
  const lastPriceMax = priceMaxima[priceMaxima.length - 1];
  const prevPriceMax = priceMaxima[priceMaxima.length - 2];
  
  // Get the last two RSI maxima
  const lastRsiMax = rsiMaxima[rsiMaxima.length - 1];
  const prevRsiMax = rsiMaxima[rsiMaxima.length - 2];
  
  // Check for bearish divergence:
  // Price: higher highs (second maximum is higher than first)
  // RSI: lower highs (second maximum is lower than first)
  const priceMakingHigherHighs = recentPrices[lastPriceMax] > recentPrices[prevPriceMax];
  const rsiMakingLowerHighs = recentRSI[lastRsiMax] < recentRSI[prevRsiMax];
  
  return priceMakingHigherHighs && rsiMakingLowerHighs;
};

/**
 * Scan available tokens to find the best trading opportunity
 * @param userId User ID
 * @returns The best token to trade or null if none found
 */
const findBestTradingOpportunity = async (userId: number): Promise<{
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  score: number; // Higher score means better opportunity
} | null> => {
  const userListener = activeSmartListeners.get(userId);
  if (!userListener || !userListener.autoTradeEnabled || userListener.tradeState !== 'waiting') {
    return null;
  }
  
  try {
    // Fetch all boosted tokens
    const boostedTokens = await fetchLatestBoostedTokens();
    
    // Filter for Solana tokens with valid mint addresses
    const solanaTokens = boostedTokens.filter(t => 
      t.chainId.toLowerCase() === 'solana' && 
      isValidMint(t.tokenAddress)
    );
    
    if (solanaTokens.length === 0) {
      logger.warn('No Solana tokens found for trading opportunity scan');
      return null;
    }
    
    // Store token scores
    const tokenScores: Array<{
      tokenAddress: string;
      tokenName: string;
      tokenSymbol: string;
      score: number;
    }> = [];
    
    // Process up to 10 tokens for high-frequency scan
    const tokensToCheck = solanaTokens.slice(0, 10);
    
    // Use Promise.all to fetch token data in parallel for faster execution
    const tokenAnalysisPromises = tokensToCheck.map(async (token) => {
      try {
        // Get token pair address
        const pairAddress = await findPairAddress(token.tokenAddress);
        if (!pairAddress) return null;
        
        // Get token metadata and price info in parallel
        const [metadata, priceInfo] = await Promise.all([
          enhancedFetchTokenMetadata(token.tokenAddress),
          fetchTokenPriceInfo(pairAddress)
        ]);
        
        if (!priceInfo) return null;
        
        const tokenName = metadata.name;
        const tokenSymbol = metadata.symbol;
        
        const currentPrice = parseFloat(priceInfo.priceUsd || '0');
        if (currentPrice <= 0) return null;
        
        // Get or create market analysis
        let analysis = tokenMarketAnalysis.get(token.tokenAddress);
        if (!analysis) {
          analysis = {
            priceHistory: [currentPrice],
            volumeHistory: priceInfo.volume?.h24 ? [priceInfo.volume.h24] : [],
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
          tokenMarketAnalysis.set(token.tokenAddress, analysis);
          
          // For new tokens, we'll return them with a modest score to start tracking
          return {
            tokenAddress: token.tokenAddress,
            tokenName,
            tokenSymbol,
            score: 45 // Basic starting score for new tokens
          };
        }
        
        // Update price history
        analysis.priceHistory.push(currentPrice);
        if (analysis.priceHistory.length > 50) {
          analysis.priceHistory.shift();
        }
        
        // Update volume history
        if (priceInfo.volume?.h24) {
          analysis.volumeHistory.push(priceInfo.volume.h24);
          if (analysis.volumeHistory.length > 50) {
            analysis.volumeHistory.shift();
          }
        }
        
        // Ensure minimum price history for proper analysis
        // For tokens with less history, do basic analysis
        if (analysis.priceHistory.length < 10) {
          // Basic analysis for tokens with limited history
          const priceChange = priceInfo.priceChange?.h1 || 0;
          let score = 50; // Base score
          
          // Recent price movement as primary factor
          if (priceChange > 5) score += 15; // Strong upward momentum
          else if (priceChange > 2) score += 10; // Good upward momentum
          else if (priceChange < -5) score -= 15; // Strong downward momentum
          
          // Volume as secondary factor
          if (priceInfo.volume?.h24 && priceInfo.volume.h24 > 10000) score += 5;
          
          // Liquidity as safety factor
          if (priceInfo.liquidity?.usd && priceInfo.liquidity.usd > 25000) score += 5;
          
          return {
            tokenAddress: token.tokenAddress,
            tokenName,
            tokenSymbol,
            score
          };
        }
        
        // Full analysis for tokens with sufficient history
        try {
          // Calculate technical indicators
          const rsi = calculateRSI(analysis.priceHistory);
          const macd = calculateMACD(analysis.priceHistory);
          const priceVelocity = calculatePriceVelocity(analysis.priceHistory);
          const emaShort = calculateEMA(analysis.priceHistory, 5, null);
          const emaLong = calculateEMA(analysis.priceHistory, 20, null);
          const volumeIncreasing = isVolumeIncreasing(analysis.volumeHistory);
          
          // Calculate opportunity score (higher is better)
          let score = 0;
          
          // RSI factors - prefer tokens coming out of oversold territory
          if (rsi < 30) score += 20; // Oversold, good buying opportunity
          else if (rsi < 40) score += 15; // Near oversold
          else if (rsi > 70) score -= 15; // Overbought, avoid
          
          // MACD factors - prefer positive crossing signals
          if (macd.histogram > 0 && macd.previousHistogram < 0) score += 25; // Bullish crossover
          else if (macd.histogram > 0) score += 10; // Positive histogram
          else if (macd.histogram < 0) score -= 5; // Negative histogram
          
          // EMA factors - prefer golden crosses
          if (emaShort > emaLong && 
              calculateEMA(analysis.priceHistory.slice(0, -1), 5, null) < 
              calculateEMA(analysis.priceHistory.slice(0, -1), 20, null)) {
            score += 25; // Fresh golden cross
          } else if (emaShort > emaLong) {
            score += 10; // Already above
          } else {
            score -= 5; // Below
          }
          
          // Volume factors
          if (volumeIncreasing) score += 15;
          
          // Momentum factors
          if (priceVelocity > 0) score += priceVelocity * 1000; // Positive momentum
          
          // Bullish divergence is a powerful signal
          if (checkBullishDivergence(analysis.priceHistory, [rsi])) score += 30;
          
          // Market sentiment from analysis
          if (analysis.trends.overallSentiment === 'strong_buy') score += 20;
          else if (analysis.trends.overallSentiment === 'buy') score += 10;
          else if (analysis.trends.overallSentiment === 'sell') score -= 10;
          else if (analysis.trends.overallSentiment === 'strong_sell') score -= 20;
          
          // Liquidity factors - ensure enough liquidity
          if (priceInfo.liquidity?.usd && priceInfo.liquidity.usd > 50000) score += 10;
          
          // Recent price change as a factor
          const h1Change = priceInfo.priceChange?.h1 || 0;
          if (h1Change > 5 && h1Change < 20) score += 10; // Healthy growth
          else if (h1Change > 20) score += 5; // Growing but might be too rapid
          else if (h1Change < -10) score -= 15; // Falling knife
          
          return {
            tokenAddress: token.tokenAddress,
            tokenName,
            tokenSymbol,
            score
          };
        } catch (analysisError) {
          logger.warn(`Error during technical analysis for ${token.tokenAddress}: ${analysisError}`);
          return null;
        }
      } catch (error: any) {
        logger.warn(`Error analyzing token ${token.tokenAddress}: ${error.message}`);
        return null;
      }
    });
    
    // Wait for all parallel token analyses to complete
    const results = await Promise.all(tokenAnalysisPromises);
    
    // Filter out null results and add to scores list
    for (const result of results) {
      if (result) {
        tokenScores.push(result);
      }
    }
    
    // Sort by score and return the best opportunity
    tokenScores.sort((a, b) => b.score - a.score);
    
    if (tokenScores.length > 0 && tokenScores[0].score > 40) {
      return tokenScores[0]; // Return the highest scoring token if score is good enough
    }
    
    return null; // No good opportunities found
  } catch (error: any) {
    logger.error(`Error in findBestTradingOpportunity: ${error.message}`, error);
    return null;
  }
};


