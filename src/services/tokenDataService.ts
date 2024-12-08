// src/services/tokenDataService.ts

import { PublicKey, TokenAmount } from '@solana/web3.js'; // Import necessary types
import axios, { AxiosError } from 'axios';
import { getCache, setCache } from './cacheService';
import { logger } from '../utils/logger';
import { connection } from './solanaService'; // Import connection

// Define the structure of a Raydium pool
interface RaydiumPool {
  baseMint: string;
  quoteMint: string;
  baseReserve: string;
  quoteReserve: string;
  baseDecimal: number;
  quoteDecimal: number;
  // Add other relevant fields if necessary
}

// Define maximum retry attempts and initial backoff duration
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000; // 1 second
const FETCH_TIMEOUT_MS = 30000; // 30 seconds

// Cache configuration
const CACHE_KEY = 'raydiumPools';
const CACHE_TTL_SECONDS = 120; // 2 minutes

// Singleton promise to prevent multiple simultaneous fetches
let fetchPromise: Promise<RaydiumPool[]> | null = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Retrieves the liquidity for a given mint address.
 * @param mintAddress - The mint address of the token.
 * @returns The total liquidity in SOL.
 */
export const getLiquidity = async (mintAddress: string): Promise<number> => {
  try {
    const raydiumPools = await fetchRaydiumPoolsWithCache();
    let totalLiquidity = 0;

    for (const pool of raydiumPools) {
      const { baseMint, quoteMint, baseReserve, quoteReserve, baseDecimal, quoteDecimal } = pool;

      if (baseMint === mintAddress || quoteMint === mintAddress) {
        // Adjust reserves based on token decimals
        const adjustedBaseReserve = Number(baseReserve) / Math.pow(10, baseDecimal);
        const adjustedQuoteReserve = Number(quoteReserve) / Math.pow(10, quoteDecimal);

        if (baseMint === mintAddress) {
          totalLiquidity += adjustedBaseReserve;
        }
        if (quoteMint === mintAddress) {
          totalLiquidity += adjustedQuoteReserve;
        }
      }
    }

    logger.info(`Calculated liquidity for mint ${mintAddress}: ${totalLiquidity} SOL`);
    return totalLiquidity;
  } catch (error) {
    logger.error('Error fetching liquidity from DEX:', error);
    return 0;
  }
};

/**
 * Fetches Raydium pools data with caching and retry logic using Redis.
 * Ensures only one fetch operation occurs at a time.
 * Implements a global timeout to prevent indefinite hanging.
 * Exits the process after exceeding maximum consecutive failures.
 * @returns An array of Raydium pools.
 */
const fetchRaydiumPoolsWithCache = async (): Promise<RaydiumPool[]> => {
  // Attempt to retrieve cached data
  const cachedData = await getCache(CACHE_KEY);
  if (cachedData) {
    logger.info('Using cached Raydium pools data from Redis.');
    return JSON.parse(cachedData) as RaydiumPool[];
  }

  // If a fetch is already in progress, return the existing promise
  if (fetchPromise) {
    logger.info('Fetch already in progress. Awaiting existing fetch operation.');
    return fetchPromise;
  }

  // Initialize the fetch promise with a timeout
  fetchPromise = new Promise<RaydiumPool[]>(async (resolve, reject) => {
    const timer = setTimeout(() => {
      logger.error('Fetch operation timed out.');
      fetchPromise = null; // Reset fetchPromise
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error('Maximum consecutive fetch failures reached. Exiting process.');
        process.exit(1); // Exit the process
      }
      reject(new Error('Fetch operation timed out.'));
    }, FETCH_TIMEOUT_MS);

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.get<RaydiumPool[]>(
          'https://api.raydium.io/v2/sdk/liquidity/mainnet.json',
          {
            headers: {
              'User-Agent': 'sol-snip-bot/1.0', // Identify your application
            },
            timeout: 10000, // 10 seconds
          }
        );

        const raydiumPools: RaydiumPool[] = response.data;

        // Cache the data in Redis
        await setCache(CACHE_KEY, JSON.stringify(raydiumPools), CACHE_TTL_SECONDS);
        logger.info('Fetched and cached Raydium pools data in Redis.');

        clearTimeout(timer);
        fetchPromise = null; // Reset fetchPromise
        consecutiveFailures = 0; // Reset failure counter
        resolve(raydiumPools);
        return;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;

          if (axiosError.code === 'ECONNABORTED') {
            // Handle timeout errors
            attempt++;
            logger.warn(
              `Request timeout (${axiosError.code}). Retrying attempt ${attempt} of ${MAX_RETRIES} after ${backoff}ms...`
            );
          } else if (axiosError.response?.status === 429) {
            // Handle rate limiting
            const retryAfter = axiosError.response.headers['retry-after'];
            backoff = retryAfter
              ? parseInt(retryAfter, 10) * 1000 // Convert seconds to milliseconds
              : backoff * 2; // Exponential backoff

            attempt++;
            logger.warn(
              `Rate limited by Raydium API (status ${axiosError.response.status}). Retrying attempt ${attempt} of ${MAX_RETRIES} after ${backoff}ms...`
            );
          } else {
            // Handle other Axios errors
            logger.error(`Axios error: ${axiosError.message}`);
            clearTimeout(timer);
            fetchPromise = null; // Reset fetchPromise
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              logger.error('Maximum consecutive fetch failures reached. Exiting process.');
              process.exit(1); // Exit the process
            }
            reject(error);
            return;
          }
        } else {
          // Handle non-Axios errors
          logger.error(`Unexpected error: ${(error as Error).message}`);
          clearTimeout(timer);
          fetchPromise = null; // Reset fetchPromise
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error('Maximum consecutive fetch failures reached. Exiting process.');
            process.exit(1); // Exit the process
          }
          reject(error);
          return;
        }

        // Wait for the backoff duration before retrying
        await delay(backoff);
        // Double the backoff time for exponential backoff, with a maximum cap
        backoff = Math.min(backoff * 2, 600000); // Cap at 10 minutes
      }
    }

    // If all retries fail
    logger.error('Max retries reached. Unable to fetch Raydium pools.');
    clearTimeout(timer);
    fetchPromise = null; // Reset fetchPromise
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error('Maximum consecutive fetch failures reached. Exiting process.');
      process.exit(1); // Exit the process
    }
    reject(new Error('Max retries reached. Unable to fetch Raydium pools.'));
  });

  return fetchPromise;
};

/**
 * Delays execution for a specified duration.
 * @param ms - Duration in milliseconds.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks if the mint authority exists for a given mint address.
 * @param mintAddress - The mint address of the token.
 * @returns A boolean indicating the presence of mint authority.
 */
export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  try {
    const mintPublicKey = new PublicKey(mintAddress);
    const mintAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);
    if (mintAccountInfo.value) {
      const data = mintAccountInfo.value.data as any;
      const mintAuthority = data.parsed.info.mintAuthority;
      return mintAuthority !== null;
    }
    return false;
  } catch (error) {
    logger.error(`Error checking mint authority for ${mintAddress}:`, error);
    return false;
  }
};

/**
 * Calculates the concentration of top holders for a given mint address.
 * @param mintAddress - The mint address of the token.
 * @returns The concentration percentage among top 10 holders.
 */
export const getTopHoldersConcentration = async (mintAddress: string): Promise<number> => {
  try {
    // Fetch token accounts holding this token
    const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
    const totalSupply = await connection.getTokenSupply(new PublicKey(mintAddress));

    const top10Accounts = largestAccounts.value.slice(0, 10);
    const top10Balance = top10Accounts.reduce(
      (sum: number, account: TokenAmount) => sum + (account.uiAmount || 0),
      0
    );

    const totalSupplyAmount = totalSupply.value.uiAmount || 0;
    const concentration = totalSupplyAmount > 0 ? (top10Balance / totalSupplyAmount) * 100 : 0;
    logger.info(`Top holders concentration for mint ${mintAddress}: ${concentration}%`);
    return concentration;
  } catch (error) {
    logger.error(`Error calculating top holders concentration for ${mintAddress}:`, error);
    return 0;
  }
};
