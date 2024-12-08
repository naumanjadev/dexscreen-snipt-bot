// src/services/solanaListener.ts

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot'; // Import the exported bot instance
import axios from 'axios';
import { Metadata } from '@metaplex-foundation/mpl-token-metadata';
import { fetchTokenMetadata } from './tokenMetadataService';

export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');

let listenerId: number | null = null;
const activeUserIds: Set<number> = new Set();
let isProcessing: boolean = false; // Flag to prevent concurrent processing

// DexScreener API Endpoint
const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

/**
 * Fetch detailed token information from DexScreener with retry logic.
 * @param tokenAddress The mint address of the token.
 * @param retries Number of retry attempts.
 * @param delayMs Delay between retries in milliseconds.
 * @returns Token details or null if fetching fails.
 */
const fetchTokenDetails = async (
  tokenAddress: string,
  retries = 3,
  delayMs = 1000
): Promise<any | null> => {
  const formattedTokenAddress = tokenAddress.toLowerCase(); // Ensure lowercase

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(`${DEXSCREENER_TOKENS_URL}${formattedTokenAddress}`);
      if (response.status === 200) {
        logger.debug(`DexScreener API Response for ${formattedTokenAddress}: ${JSON.stringify(response.data, null, 2)}`);
        return response.data;
      } else {
        logger.error(`DexScreener API responded with status ${response.status} for token ${formattedTokenAddress}.`);
        return null;
      }
    } catch (error) {
      logger.error(`Attempt ${attempt}: Error fetching token details from DexScreener for ${formattedTokenAddress}: ${(error as Error).message}`);
      if (attempt < retries) {
        logger.info(`Retrying in ${delayMs}ms...`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        logger.error(`Failed to fetch token details for ${formattedTokenAddress} after ${retries} attempts.`);
        return null;
      }
    }
  }

  return null;
};

/**
 * Constructs a detailed and catchy message with token information.
 * @param tokenInfo Basic token information.
 * @param dexData Detailed token information from DexScreener.
 * @param metadata Token metadata from Solana.
 * @returns Formatted message string.
 */
const constructTokenMessage = (
  tokenInfo: TokenInfo,
  dexData: any,
  metadata: Metadata | null
): string => {
  const tokenAddress = tokenInfo.mintAddress;

  // Access the pairs array directly from dexData
  const tokenDetails = dexData?.pairs && dexData.pairs.length > 0 ? dexData.pairs[0] : null;

  // Fetch token name and symbol from metadata if available
  const tokenName = metadata?.data.data.name || 'N/A';
  const tokenSymbol = metadata?.data.data.symbol || 'N/A';

  if (!tokenDetails && !metadata) {
    return `🚨 <b>Token Match Found!</b>\n\n<b>Mint Address:</b> <code>${tokenAddress}</code>\n\n🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>\n\n💡 <i>Unable to retrieve additional details.</i>\n\n💰 <b>Buying Token...</b>`;
  }

  if (!tokenDetails) {
    return `🚨 <b>Token Match Found!</b>\n\n<b>Token Name:</b> ${tokenName}\n<b>Symbol:</b> ${tokenSymbol}\n<b>Mint Address:</b> <code>${tokenAddress}</code>\n\n🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>\n\n💡 <i>Unable to retrieve additional details. The token may not be listed on any DEX yet.</i>\n\n💰 <b>Buying Token...</b>`;
  }

  const baseToken = tokenDetails.baseToken || {};
  const quoteToken = tokenDetails.quoteToken || {};
  const priceUsd = tokenDetails.priceUsd ? parseFloat(tokenDetails.priceUsd).toFixed(6) : 'N/A';
  const liquidity = tokenDetails.liquidity?.usd ? parseFloat(tokenDetails.liquidity.usd).toLocaleString() : 'N/A';
  const fdv = tokenDetails.fdv ? parseFloat(tokenDetails.fdv).toLocaleString() : 'N/A';
  const marketCap = tokenDetails.marketCap ? parseFloat(tokenDetails.marketCap).toLocaleString() : 'N/A';
  const dexUrl = tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;
  const creationTime = tokenDetails.creationTime
    ? new Date(tokenDetails.creationTime * 1000).toUTCString()
    : 'N/A';

  return `🚀 <b>🔥 New Token Alert!</b>

<b>Token Name:</b> ${tokenName}
<b>Symbol:</b> ${tokenSymbol}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🌐 <b>Blockchain:</b> Solana

💲 <b>Price USD:</b> $${priceUsd}
💧 <b>Liquidity USD:</b> $${liquidity}
📈 <b>FDV:</b> $${fdv}
📊 <b>Market Cap:</b> $${marketCap}
🕒 <b>Creation Time:</b> ${creationTime}

🔗 <b>DexScreener URL:</b> <a href="${dexUrl}">View on DexScreener</a>
🔗 <b>SolScan URL:</b> <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💥 <i>This token has passed all your filters!</i>

➡️ <b>Buying Token...</b>

🔔 To listen for more tokens, use /start_listener.
`;
};

/**
 * Starts the token listener for a specific user.
 */
export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  if (listenerId === null) {
    listenerId = connection.onProgramAccountChange(
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      async (keyedAccountInfo) => {
        if (isProcessing) {
          logger.debug('Listener is already processing an event. Skipping this event.');
          return;
        }

        if (activeUserIds.size === 0) {
          logger.debug('No active users. Listener should be stopped.');
          return;
        }

        isProcessing = true; // Acquire the processing lock

        try {
          const accountId = keyedAccountInfo.accountId.toBase58();
          const tokenInfo: TokenInfo = { mintAddress: accountId };

          logger.debug(`Received token update for account ID: ${accountId}`);

          // Fetch detailed token information from DexScreener
          const dexData = await fetchTokenDetails(accountId);

          if (!dexData) {
            logger.warn(`No DexScreener data found for token ${accountId}.`);
          }

          // Fetch token metadata from Solana
          const metadata = await fetchTokenMetadata(accountId, connection);

          if (!metadata) {
            logger.warn(`No metadata found for token ${accountId}.`);
          }

          // Log the entire DexScreener response for debugging
          logger.debug(`DexScreener response for ${accountId}: ${JSON.stringify(dexData, null, 2)}`);

          // Log the token metadata for debugging
          if (metadata) {
            logger.debug(`Metadata for ${accountId}: ${JSON.stringify(metadata, null, 2)}`);
          }

          // Create a snapshot of activeUserIds to allow safe removal during iteration
          const users = Array.from(activeUserIds);

          for (const uid of users) {
            try {
              logger.debug(`Processing token ${accountId} for user ${uid}.`);

              const passesFilters = await applyFilters(tokenInfo, uid);
              if (passesFilters) {
                logger.info(`Token ${accountId} passed filters for user ${uid}.`);

                // Construct the detailed message with DexScreener and metadata
                const message = constructTokenMessage(tokenInfo, dexData, metadata);

                // Send the message to the user via Telegram
                await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });
                logger.info(`Sent token details to user ${uid}.`);

                // Optionally, perform additional actions such as initiating a purchase
                // await purchaseToken(tokenInfo, uid);

                // Stop the listener for this user
                activeUserIds.delete(uid);
                logger.info(`Listener stopped for user ${uid} after token match.`);
              } else {
                logger.debug(`Token ${accountId} did not pass filters for user ${uid}.`);
              }
            } catch (error) {
              logger.error(`Error processing token ${accountId} for user ${uid}: ${(error as Error).message}`);
            }
          }

          // After processing all users, check if listener should be removed
          if (activeUserIds.size === 0 && listenerId !== null) {
            try {
              connection.removeProgramAccountChangeListener(listenerId);
              logger.info('Solana token listener stopped as there are no active users.');
              listenerId = null;
            } catch (error) {
              logger.error(`Error stopping token listener: ${(error as Error).message}`);
            }
          }
        } catch (error) {
          logger.error(`Unexpected error in listener callback: ${(error as Error).message}`);
        } finally {
          isProcessing = false; // Release the processing lock
        }
      },
      'confirmed'
    );

    logger.info('Solana token listener started.');
  }
};

/**
 * Stops the token listener for a specific user.
 */
export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUserIds.has(userId)) {
    logger.warn(`Token detection is not active for user ${userId}.`);
    return;
  }

  activeUserIds.delete(userId);
  logger.info(`User ${userId} stopped token detection.`);

  if (activeUserIds.size === 0 && listenerId !== null) {
    try {
      connection.removeProgramAccountChangeListener(listenerId);
      logger.info('Solana token listener stopped.');
      listenerId = null;
    } catch (error) {
      logger.error(`Error stopping token listener: ${(error as Error).message}`);
    }
  }
};
