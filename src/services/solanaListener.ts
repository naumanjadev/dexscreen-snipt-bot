import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { getUserSettings } from './userSettingsService';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot';
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService';

// DexScreener API Endpoints
const DEXSCREENER_BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEXSCREENER_PAIR_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

// Type Definitions for DexScreener Responses
interface DexScreenerBoostedToken {
  tokenAddress: string;
  chainId: string;
  url: string;
  totalAmount: number;
  description: string;
  // Add other relevant fields as per DexScreener API response
}

interface DexScreenerPairResponse {
  pairs: Array<{
    pairCreatedAt: number; // Unix timestamp in seconds or milliseconds
    // Add other relevant fields as per DexScreener API response
  }>;
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

export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');

const activeUserIds: Set<number> = new Set();
let isProcessing: boolean = false; 
let intervalId: NodeJS.Timeout | null = null;

/**
 * Fetch the latest boosted tokens from DexScreener.
 * @returns Array of boosted token objects or empty array on failure.
 */
const fetchLatestBoostedTokens = async (): Promise<DexScreenerBoostedToken[]> => {
  try {
    const response = await axios.get(DEXSCREENER_BOOSTS_URL);
    if (response.status === 200 && response.data) {
      const data: DexScreenerBoostedToken[] = Array.isArray(response.data) ? response.data : [response.data];
      logger.debug(
        `DexScreener Latest Boosted Tokens API Response: ${JSON.stringify(data, null, 2)}`
      );
      return data;
    } else {
      logger.error(`Failed to fetch boosted tokens. Status: ${response.status}`);
      return [];
    }
  } catch (error: any) {
    logger.error(`Error fetching latest boosted tokens: ${error.message}`, error);
    return [];
  }
};

/**
 * Fetch token pair details from DexScreener to get creation time
 * @param tokenAddress Token mint address
 * @returns Token pair creation timestamp in seconds or milliseconds
 */
const fetchTokenCreationTime = async (tokenAddress: string): Promise<{ timestamp: number, unit: 'seconds' | 'milliseconds' } | null> => {
  try {
    const response = await axios.get<DexScreenerPairResponse>(`${DEXSCREENER_PAIR_TOKEN_URL}${tokenAddress}`);
    if (response.status === 200 && response.data?.pairs?.length > 0) {
      const pair = response.data.pairs[0];
      const pairCreatedAt = pair.pairCreatedAt;
      
      if (pairCreatedAt) {
        // Log the raw pairCreatedAt value
        logger.debug(`Token ${tokenAddress} pairCreatedAt raw value: ${pairCreatedAt}`);
        
        // Determine the unit based on the length of the timestamp
        let unit: 'seconds' | 'milliseconds';
        if (pairCreatedAt.toString().length === 10) {
          unit = 'seconds';
        } else if (pairCreatedAt.toString().length === 13) {
          unit = 'milliseconds';
        } else {
          logger.warn(`Unexpected pairCreatedAt length for token ${tokenAddress}: ${pairCreatedAt}`);
          return null;
        }

        logger.debug(`Token ${tokenAddress} pairCreatedAt unit: ${unit}`);
        return { timestamp: pairCreatedAt, unit };
      } else {
        logger.warn(`pairCreatedAt not found for token ${tokenAddress}`);
      }
    } else {
      logger.warn(`No pairs found for token ${tokenAddress}`);
    }
    return null;
  } catch (error: any) {
    logger.error(`Error fetching token creation time for ${tokenAddress}: ${error.message}`, error);
    return null;
  }
};

/**
 * Check if token is created within the last 30 minutes
 * @param mintAddress Token mint address
 */
const isTokenYoungerThan30Mins = async (mintAddress: string): Promise<boolean> => {
  const creationData = await fetchTokenCreationTime(mintAddress);
  if (!creationData) return false;

  let creationTimeInSeconds: number;

  if (creationData.unit === 'milliseconds') {
    creationTimeInSeconds = Math.floor(creationData.timestamp / 1000);
  } else {
    creationTimeInSeconds = creationData.timestamp;
  }

  const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
  const diff = currentTime - creationTimeInSeconds; 
  logger.debug(`Token ${mintAddress} pairCreatedAt (seconds): ${creationTimeInSeconds}`);
  logger.debug(`Current Time (seconds): ${currentTime}`);
  logger.debug(`Token ${mintAddress} age: ${diff} seconds`);

  return diff >= 0 && diff <= 1800; // 0 <= diff <= 1800 seconds
};

/**
 * Constructs a message when token passes filters
 */
const constructTokenMessage = async (
  tokenInfo: TokenInfo,
  dexData: DexScreenerBoostedToken
): Promise<string> => {
  const tokenAddress = tokenInfo.mintAddress;

  // Attempt to get name and symbol from on-chain metadata
  const metadata = await fetchTokenMetadata(tokenAddress);
  const name = metadata?.name || 'N/A';
  const symbol = metadata?.symbol || 'N/A';

  const url = dexData.url || 'N/A';
  const chainId = dexData.chainId || 'N/A';
  const boostAmount = dexData.totalAmount || 0;
  const description = dexData.description || 'N/A';

  return `🚀 <b>🔥 New Token Alert!</b>

<b>Token Name:</b> ${name}
<b>Symbol:</b> ${symbol}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🌐 <b>Chain:</b> ${chainId}
💥 <b>Boost Amount:</b> ${boostAmount}
📝 <b>Description:</b> ${description}

🔗 <b>DexScreener URL:</b> <a href="${url}">View Token</a>
🔗 <b>SolScan URL:</b> <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💥 <i>This token has passed all your filters and is fresh (&le;30 mins old)!</i>

➡️ <b>Buying Token...</b>

🔔 To listen for more tokens, use /start_listener.
`;
};

/**
 * Polling function that runs every 1 second to fetch from DexScreener and process tokens for active users
 */
const pollDexScreener = async () => {
  if (isProcessing) {
    logger.debug('Already processing. Skipping this tick.');
    return;
  }

  if (activeUserIds.size === 0) {
    logger.debug('No active users. Stopping polling.');
    stopPolling();
    return;
  }

  isProcessing = true;

  try {
    const boostedTokens = await fetchLatestBoostedTokens();
    const users = Array.from(activeUserIds);

    for (const uid of users) {
      for (const dexToken of boostedTokens) {
        const tokenAddress = dexToken.tokenAddress;

        if (!isValidMint(tokenAddress)) {
          logger.debug(`Invalid mint address: ${tokenAddress}, skipping.`);
          continue;
        }

        if (dexToken.chainId.toLowerCase() !== 'solana') {
          logger.debug(`Token ${tokenAddress} not on Solana chain, skipping.`);
          continue;
        }

        const isYoung = await isTokenYoungerThan30Mins(tokenAddress);
        logger.debug(`Token ${tokenAddress} is ${isYoung ? 'younger' : 'older'} than 30 minutes.`);
        if (!isYoung) {
          logger.debug(`Token ${tokenAddress} older than 30 mins or unknown creation time, skipping.`);
          continue;
        }

        const tokenInfo: TokenInfo = { mintAddress: tokenAddress };
        const passesFilters = await applyFilters(tokenInfo, uid, dexToken);
        if (passesFilters) {
          logger.info(`Token ${tokenAddress} passed filters for user ${uid}. Sending message and buying.`);
          
          const message = await constructTokenMessage(tokenInfo, dexToken);
          await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });

          const purchaseSuccess = await purchaseToken(uid, tokenInfo);

          // Stop detection for this user after processing
          activeUserIds.delete(uid);
          if (purchaseSuccess) {
            logger.info(`Listener stopped for user ${uid} after successful token purchase.`);
          } else {
            logger.info(`Listener stopped for user ${uid} after failed token purchase.`);
          }
        } else {
          logger.debug(`Token ${tokenAddress} did not pass filters for user ${uid}.`);
        }
      }
    }

    // If no active users remain, stop polling
    if (activeUserIds.size === 0) {
      stopPolling();
    }

  } catch (error: any) {
    logger.error(`Error in polling DexScreener: ${error.message}`, error);
  } finally {
    isProcessing = false;
  }
};

const startPolling = () => {
  if (intervalId === null) {
    intervalId = setInterval(pollDexScreener, 1500);
    logger.info('Started DexScreener polling at 1 second interval.');
  } else {
    logger.debug('Polling already started.');
  }
};

const stopPolling = () => {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Stopped DexScreener polling.');
  }
};

/**
 * Starts the token listener for a specific user
 */
export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  startPolling();
};

/**
 * Stops the token listener for a specific user
 */
export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUserIds.has(userId)) {
    logger.warn(`Token detection is not active for user ${userId}.`);
    return;
  }

  activeUserIds.delete(userId);
  logger.info(`User ${userId} stopped token detection.`);

  if (activeUserIds.size === 0) {
    stopPolling();
  }
};
