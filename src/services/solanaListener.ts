// src/services/solanaService.ts

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

interface DexScreenerBoostedToken {
  tokenAddress: string;
  chainId: string;
  url: string;
  totalAmount: number;
  description: string;
}

interface DexScreenerPairResponse {
  pairs: Array<{
    pairCreatedAt: number;
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

// Keep track of processed tokens to avoid repeated attempts on the same token
const processedTokens: Set<string> = new Set();

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

const fetchTokenCreationTime = async (tokenAddress: string): Promise<{ timestamp: number, unit: 'seconds' | 'milliseconds' } | null> => {
  try {
    const response = await axios.get<DexScreenerPairResponse>(`${DEXSCREENER_PAIR_TOKEN_URL}${tokenAddress}`);
    if (response.status === 200 && response.data?.pairs?.length > 0) {
      const pair = response.data.pairs[0];
      const pairCreatedAt = pair.pairCreatedAt;
      
      if (pairCreatedAt) {
        logger.debug(`Token ${tokenAddress} pairCreatedAt raw value: ${pairCreatedAt}`);
        
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

const isTokenYoungerThan30Mins = (creationData: { timestamp: number, unit: 'seconds' | 'milliseconds' } | null): boolean => {
  if (!creationData) return false;

  let creationTimeInSeconds: number;
  if (creationData.unit === 'milliseconds') {
    creationTimeInSeconds = Math.floor(creationData.timestamp / 1000);
  } else {
    creationTimeInSeconds = creationData.timestamp;
  }

  const currentTime = Math.floor(Date.now() / 1000); 
  const diff = currentTime - creationTimeInSeconds; 
  logger.debug(`Token age: ${diff} seconds`);

  return diff >= 0 && diff <= 1800; 
};

const constructTokenMessage = async (
  tokenInfo: TokenInfo,
  dexData: DexScreenerBoostedToken
): Promise<string> => {
  const tokenAddress = tokenInfo.mintAddress;

  let name = 'N/A';
  let symbol = 'N/A';

  try {
    const metadata = await fetchTokenMetadata(tokenAddress);
    if (metadata?.name) name = metadata.name;
    if (metadata?.symbol) symbol = metadata.symbol;
  } catch (metaError: any) {
    logger.warn(`Failed to decode metadata for mint address: ${tokenAddress}`);
  }

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
    if (boostedTokens.length === 0) {
      logger.debug('No boosted tokens received.');
      return;
    }

    // Filter tokens:
    // 1. Must be on Solana
    // 2. Must not be processed before
    // 3. Must have a valid mint
    const filteredTokens = boostedTokens.filter(t => 
      t.chainId.toLowerCase() === 'solana' &&
      !processedTokens.has(t.tokenAddress) &&
      isValidMint(t.tokenAddress)
    );

    if (filteredTokens.length === 0) {
      logger.debug('No new valid Solana tokens found.');
      return;
    }

    // Get the active users
    const userIds = Array.from(activeUserIds);

    // Apply user filters (which do not rely on creation time) for each user
    // We do this in parallel for each token to minimize delay
    // We'll store results in a map of userId -> tokens that pass filters
    const userTokensMap: Record<number, DexScreenerBoostedToken[]> = {};
    for (const uid of userIds) {
      userTokensMap[uid] = [];
    }

    for (const dexToken of filteredTokens) {
      const tokenInfo: TokenInfo = { mintAddress: dexToken.tokenAddress };
      // Apply filters for all users in parallel
      const filterChecks = await Promise.all(userIds.map(uid => applyFilters(tokenInfo, uid, dexToken)));
      filterChecks.forEach((passes, index) => {
        if (passes) {
          userTokensMap[userIds[index]].push(dexToken);
        }
      });

      // If at least one user found it passing filters, we keep it for creation check
      // Otherwise mark it processed now
      if (!filterChecks.includes(true)) {
        processedTokens.add(dexToken.tokenAddress);
      }
    }

    // Flatten all tokens that passed filters for at least one user
    const tokensToCheck = Object.values(userTokensMap).flat();
    const uniqueTokensToCheck = Array.from(new Set(tokensToCheck.map(t => t.tokenAddress)));

    if (uniqueTokensToCheck.length === 0) {
      logger.debug('No tokens passed the initial filters for any user.');
      return;
    }

    // Fetch creation times in parallel
    const creationTimePromises = uniqueTokensToCheck.map(async tokenAddress => {
      const creationData = await fetchTokenCreationTime(tokenAddress);
      return { tokenAddress, creationData };
    });

    const creationTimes = await Promise.all(creationTimePromises);
    const creationTimeMap: Record<string, { timestamp: number; unit: 'seconds' | 'milliseconds' } | null> = {};
    for (const { tokenAddress, creationData } of creationTimes) {
      creationTimeMap[tokenAddress] = creationData;
    }

    // Now, for each user and token, check creation time and send messages/purchase if valid
    // We'll do these actions in parallel per user
    for (const uid of userIds) {
      const tokensForUser = userTokensMap[uid];
      // Filter tokens that are actually younger than 30 mins
      const validTokensForUser = tokensForUser.filter(dexToken => 
        isTokenYoungerThan30Mins(creationTimeMap[dexToken.tokenAddress] || null)
      );

      // Send messages and attempt purchase in parallel for speed
      await Promise.all(validTokensForUser.map(async dexToken => {
        const tokenInfo: TokenInfo = { mintAddress: dexToken.tokenAddress };
        
        // Construct and send message
        const message = await constructTokenMessage(tokenInfo, dexToken);
        try {
          await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });
          logger.debug(`Message sent to user ${uid} for token ${dexToken.tokenAddress}.`);
        } catch (msgError: any) {
          logger.error(`Failed to send message to user ${uid}: ${msgError.message}`, msgError);
        }

        // Attempt purchase
        try {
          const purchaseSuccess = await purchaseToken(uid, tokenInfo);
          if (purchaseSuccess) {
            logger.info(`Successfully purchased token ${dexToken.tokenAddress} for user ${uid}.`);
          } else {
            logger.warn(`Failed to purchase token ${dexToken.tokenAddress} for user ${uid}.`);
          }
        } catch (purchaseError: any) {
          logger.error(`Error purchasing token ${dexToken.tokenAddress} for user ${uid}: ${purchaseError.message}`, purchaseError);
        }

        // Mark token as processed to prevent immediate reprocessing
        processedTokens.add(dexToken.tokenAddress);
      }));
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
    intervalId = setInterval(pollDexScreener, 1000);
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

export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);
  startPolling();
};

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
