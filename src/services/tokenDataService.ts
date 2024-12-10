// src/services/tokenDataService.ts

import { PublicKey } from '@solana/web3.js';
import { getCache, setCache } from './cacheService';
import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot'; // Import the exported bot instance
import { fetchTokenMetadata } from './tokenMetadataService'; // Import the metadata fetcher
import {
  getMintWithRateLimit,
  getTokenSupplyWithRateLimit,
  getTokenLargestAccountsWithRateLimit,
} from './rpcRateLimiter';
import { Mint } from '@solana/spl-token';
import { TokenAccountBalancePair, TokenAmount } from '@solana/web3.js';

// ------------------------------
// Interfaces
// ------------------------------

// Removed LargestAccountInfo and TokenSupply interfaces
// Utilize existing types from @solana/web3.js

interface MintInfoExtended {
  chainId: number;
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
}

interface TokenDataPayload {
  // Define any additional fields if necessary
}

// ------------------------------
// Constants
// ------------------------------

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_KEY = 'splTokenData';
const CACHE_TTL_SECONDS = 120;

// ------------------------------
// Variables
// ------------------------------

let fetchPromise: Promise<TokenDataPayload[]> | null = null;

// ------------------------------
// Utility Functions
// ------------------------------

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches SPL token data with caching and rate limiting.
 * @returns Array of token data payloads.
 */
const fetchSplTokenDataWithCache = async (): Promise<TokenDataPayload[]> => {
  // Check if we have cached data
  const cachedData = await getCache(CACHE_KEY);
  if (cachedData) {
    logger.info('Using cached SPL token data from cache.');
    try {
      const tokens = JSON.parse(cachedData);
      if (Array.isArray(tokens)) {
        return tokens as TokenDataPayload[];
      } else {
        logger.error('Cached SPL token data is not an array. Clearing cache and refetching.');
        await setCache(CACHE_KEY, '', 1);
      }
    } catch (e) {
      logger.error('Error parsing cached SPL token data. Clearing cache and refetching.', e);
      await setCache(CACHE_KEY, '', 1);
    }
  }

  if (fetchPromise) {
    logger.debug('Fetch already in progress, awaiting existing operation.');
    return fetchPromise;
  }

  fetchPromise = new Promise<TokenDataPayload[]>(async (resolve) => {
    const timer = setTimeout(() => {
      logger.error('Fetch operation timed out.');
      fetchPromise = null;
      resolve([]);
    }, FETCH_TIMEOUT_MS);

    const url = 'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06'; // Replace with appropriate RPC endpoint if needed

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
      try {
        // Example: Fetch all mint accounts (this is a placeholder; actual implementation may vary)
        const response = await axios.post(
          url,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getProgramAccounts',
            params: [
              'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program ID
              {
                encoding: 'jsonParsed',
                filters: [{ dataSize: 82 }], // Size of SPL Token mint accounts
              },
            ],
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );

        if (response.status === 200 && response.data?.result) {
          const tokens = response.data.result;
          await setCache(CACHE_KEY, JSON.stringify(tokens), CACHE_TTL_SECONDS);
          logger.info('Fetched and cached SPL token data.');

          clearTimeout(timer);
          fetchPromise = null;
          resolve(tokens);
          return;
        } else if (response.status === 429) {
          logger.warn(`Rate limit (429) encountered. Waiting ${backoff}ms before retrying...`);
          await delay(backoff);
          backoff = Math.min(backoff * 2, 60000);
        } else {
          logger.error(
            `Unexpected response from Solana RPC. Status: ${response.status}, Data: ${JSON.stringify(
              response.data
            ).slice(0, 200)}... Retrying in ${backoff}ms.`
          );
          await delay(backoff);
          backoff = Math.min(backoff * 2, 60000);
        }
      } catch (error: any) {
        const message = axios.isAxiosError(error) ? error.message : (error as Error).message;
        logger.warn(`Attempt ${attempt + 1} failed: ${message}. Retrying in ${backoff}ms...`);
        await delay(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
      attempt++;
    }

    clearTimeout(timer);
    fetchPromise = null;
    logger.error('Max retries reached. Unable to fetch SPL token data.');
    resolve([]);
  });

  return fetchPromise;
};

/**
 * Retrieves the liquidity of a given mint address based on circulating supply.
 * Liquidity is approximated by considering the total supply minus locked or non-circulating tokens.
 *
 * @param mintAddress The mint address to check.
 * @returns The approximated liquidity amount in terms of the number of tokens.
 */
export const getLiquidity = async (mintAddress: string): Promise<number> => {
  try {
    const mintInfo: Mint = await getMintWithRateLimit(mintAddress);
    const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
    // Approximation: Total liquidity is total supply minus locked tokens
    // Implement actual logic to determine locked tokens if available
    // For now, we'll assume all tokens are liquid
    const liquidity = totalSupply;
    logger.info(`Calculated liquidity for mint ${mintAddress}: ${liquidity}`);
    return liquidity;
  } catch (error: any) {
    logger.error('Error fetching liquidity from SPL:', error);
    return 0;
  }
};

/**
 * Checks if the given mint address has an active mint authority.
 * If the RPC or fetch fails, returns false.
 *
 * @param mintAddress The mint public key as a string.
 * @returns Boolean indicating the presence of a mint authority.
 */
export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  try {
    const mintInfo: Mint = await getMintWithRateLimit(mintAddress);
    const hasAuthority = mintInfo.mintAuthority !== null;
    logger.info(`Mint ${mintAddress} has mint authority: ${hasAuthority}`);
    return hasAuthority;
  } catch (error: any) {
    logger.error(`Error checking mint authority for ${mintAddress}:`, error);
    return false;
  }
};

/**
 * Calculates the concentration of holdings among the top N holders of a given token.
 *
 * @param mintAddress The mint public key as a string.
 * @param topN The number of top holders to consider. Default is 10.
 * @returns The percentage concentration of the top N holders.
 */
export const getTopHoldersConcentration = async (
  mintAddress: string,
  topN: number = 10
): Promise<number> => {
  try {
    const largestAccounts: TokenAccountBalancePair[] = await getTokenLargestAccountsWithRateLimit(mintAddress);
    if (!largestAccounts || largestAccounts.length === 0) {
      logger.warn(`No token accounts found for mint ${mintAddress}.`);
      return 0;
    }

    const supplyResponse: TokenAmount = await getTokenSupplyWithRateLimit(mintAddress);
    const totalSupply = supplyResponse.uiAmount || 0;
    if (totalSupply === 0) {
      logger.warn(`Total supply for mint ${mintAddress} is zero, cannot calculate concentration.`);
      return 0;
    }

    // Sort the largest accounts in descending order based on uiAmount
    const sortedAccounts = largestAccounts.sort(
      (a: TokenAccountBalancePair, b: TokenAccountBalancePair) => (b.uiAmount || 0) - (a.uiAmount || 0)
    );

    const topAccounts = sortedAccounts.slice(0, topN);
    const topSum = topAccounts.reduce(
      (sum: number, acc: TokenAccountBalancePair) => sum + (acc.uiAmount || 0),
      0
    );
    const concentration = (topSum / totalSupply) * 100;

    logger.info(
      `Top ${topN} holders concentration for mint ${mintAddress}: ${concentration.toFixed(2)}%`
    );
    return concentration;
  } catch (error: any) {
    logger.error(`Error calculating top holders concentration for ${mintAddress}:`, error);
    return 0;
  }
};

/**
 * Example function to process new token data. This can be expanded based on your application's needs.
 * @param mintAddress The mint address of the token.
 */
export const processNewToken = async (mintAddress: string) => {
  try {
    const liquidity = await getLiquidity(mintAddress);
    const hasAuthority = await hasMintAuthority(mintAddress);
    const concentration = await getTopHoldersConcentration(mintAddress);

    logger.info(`New Mint Details:
      Address: ${mintAddress}
      Liquidity: ${liquidity}
      Has Mint Authority: ${hasAuthority}
      Top Holders Concentration: ${concentration.toFixed(2)}%
    `);

    // Implement additional logic as needed, such as applying filters, notifying users, etc.
  } catch (error) {
    logger.error(`Error processing new token ${mintAddress}:`, error);
  }
};

// Export other necessary functions or data as needed
