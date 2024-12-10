// src/services/rpcRateLimiter.ts

import Bottleneck from 'bottleneck';
import {
  Connection,
  PublicKey,
  AccountInfo,
  RpcResponseAndContext,
  TokenAccountBalancePair,
  TokenAmount,
  ParsedAccountData,
} from '@solana/web3.js';
import { getMint, Mint } from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';

// Store multiple RPC URLs for load distribution
const rpcUrls = [
  'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06', // RPC URL 1
  // Add more RPC URLs if available
];

// Create multiple connection instances
const connections = rpcUrls.map(url => new Connection(url, 'confirmed'));

// Function to get a random connection
const getRandomConnection = () => connections[Math.floor(Math.random() * connections.length)];

// Configure Bottleneck
const limiter = new Bottleneck({
  reservoir: 200, // Increased from 100
  reservoirRefreshAmount: 200, // Increased from 100
  reservoirRefreshInterval: 60 * 1000, // Refresh every 60 seconds
  maxConcurrent: 10, // Increased from 5
  minTime: 100, // Reduced from 200ms
});

// Helper function to handle retries with exponential backoff and jitter
const retryWrapper = async <T>(
  fn: () => Promise<T>,
  description: string,
  retries = 5
): Promise<T> => {
  let attempt = 0;
  const execute = async (): Promise<T> => {
    try {
      return await fn();
    } catch (error: any) {
      logger.error(`Error in ${description}:`, error);

      const is429 =
        (error.response && error.response.status === 429) ||
        (error.code === '429') ||
        error.message.includes('429') ||
        error.message.includes('Too Many Requests');

      const isRetryable =
        is429 ||
        (error.response && [500, 502, 503].includes(error.response.status)) ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';

      if (attempt < retries && isRetryable) {
        const jitter = Math.random() * 100; // Add up to 100ms randomness
        const backoff = Math.pow(2, attempt) * 500 + jitter; // Exponential backoff with jitter
        logger.warn(
          `${description} failed with ${
            error.response?.status || error.code || 'Unknown Error'
          }. Retrying in ${backoff.toFixed(0)}ms... (Attempt ${attempt + 1}/${retries})`
        );
        await delay(backoff);
        attempt++;
        return execute();
      } else {
        logger.error(`${description} failed after ${attempt} attempt(s): ${error.message}`);
        throw error;
      }
    }
  };
  return execute();
};

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initialize Jupiter API client (assuming you have a function for this).
 * Replace with actual initialization if different.
 */
// import { createJupiterApiClient } from '@jup-ag/api'; // Uncomment if needed

// Wrap Solana RPC methods with rate limiting and retry logic

/**
 * Fetches the Mint information for a given mint address with rate limiting.
 * @param mintAddress The mint address as a string.
 * @returns Mint information.
 */
export const getMintWithRateLimit = async (mintAddress: string): Promise<Mint> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      () => getMint(connection, new PublicKey(mintAddress)),
      `getMint for ${mintAddress}`
    )
  );
};

/**
 * Fetches the token supply for a given mint address with rate limiting.
 * @param mintAddress The mint address as a string.
 * @returns Token supply information.
 */
export const getTokenSupplyWithRateLimit = async (
  mintAddress: string
): Promise<TokenAmount> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<TokenAmount> = await connection.getTokenSupply(
          new PublicKey(mintAddress)
        );
        if (!response.value.uiAmountString) {
          throw new Error('uiAmountString is undefined');
        }
        return response.value;
      },
      `getTokenSupply for ${mintAddress}`
    )
  );
};

/**
 * Fetches the largest token accounts for a given mint address with rate limiting.
 * @param mintAddress The mint address as a string.
 * @returns Array of largest token accounts.
 */
export const getTokenLargestAccountsWithRateLimit = async (
  mintAddress: string
): Promise<TokenAccountBalancePair[]> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<TokenAccountBalancePair[]> = await connection.getTokenLargestAccounts(
          new PublicKey(mintAddress)
        );
        if (!response.value) {
          throw new Error('Largest accounts value is undefined');
        }
        return response.value;
      },
      `getTokenLargestAccounts for ${mintAddress}`
    )
  );
};

/**
 * Fetches parsed account info for a given public key with rate limiting.
 * @param publicKey The public key as a string.
 * @returns Parsed account information or null.
 */
export const getParsedAccountInfoWithRateLimit = async (
  publicKey: string
): Promise<AccountInfo<ParsedAccountData> | null> => {
  const connection = getRandomConnection();
  return limiter.schedule(() =>
    retryWrapper(
      async () => {
        const response: RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null> =
          await connection.getParsedAccountInfo(new PublicKey(publicKey));

        const accountInfo = response.value;
        if (
          accountInfo &&
          accountInfo.data &&
          typeof accountInfo.data === 'object' &&
          'parsed' in accountInfo.data
        ) {
          // Type assertion since we've confirmed it's ParsedAccountData
          return accountInfo as AccountInfo<ParsedAccountData>;
        }
        return null;
      },
      `getParsedAccountInfo for ${publicKey}`
    )
  );
};

// Add more wrapped RPC methods as needed
