import axios, { AxiosError } from 'axios';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { connection } from './solanaService'; 
import { getCache, setCache } from './cacheService'; // must implement getCache(key) and setCache(key, value, ttl)
import { logger } from '../utils/logger'; // must implement a logger with info, warn, error, debug methods

interface MintInfo {
  chainId: number;
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
}

interface RaydiumPool {
  type: string;
  programId: string;
  id: string;
  mintA: MintInfo;
  mintB: MintInfo;
  mintAmountA?: number;
  mintAmountB?: number;
}

interface RaydiumDataPayload {
  count: number;
  data: RaydiumPool[];
}

interface RaydiumApiResponse {
  id: string;
  success: boolean;
  data: RaydiumDataPayload;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_KEY = 'raydiumPools';
const CACHE_TTL_SECONDS = 120;

let fetchPromise: Promise<RaydiumPool[]> | null = null;

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches Raydium pools data from the V3 endpoint, caching results and handling rate limits.
 */
const fetchRaydiumPoolsWithCache = async (): Promise<RaydiumPool[]> => {
  // Check if we have cached data
  const cachedData = await getCache(CACHE_KEY);
  if (cachedData) {
    logger.info('Using cached Raydium pools data from Redis.');
    try {
      const pools = JSON.parse(cachedData);
      if (Array.isArray(pools)) {
        return pools as RaydiumPool[];
      } else {
        logger.error('Cached data is not an array. Clearing cache and refetching.');
        await setCache(CACHE_KEY, '', 1);
      }
    } catch (e) {
      logger.error('Error parsing cached Raydium pools data. Clearing cache and refetching.', e);
      await setCache(CACHE_KEY, '', 1);
    }
  }

  if (fetchPromise) {
    logger.debug('Fetch already in progress, awaiting existing operation.');
    return fetchPromise;
  }

  fetchPromise = new Promise<RaydiumPool[]>(async (resolve) => {
    const timer = setTimeout(() => {
      logger.error('Fetch operation timed out.');
      fetchPromise = null;
      resolve([]);
    }, FETCH_TIMEOUT_MS);

    const url = 'https://api-v3.raydium.io/pools/info/list';
    const params = {
      poolType: 'all',
      poolSortField: 'default',
      sortType: 'desc',
      pageSize: 100,
      page: 1,
    };

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.get<RaydiumApiResponse>(url, {
          headers: { 'User-Agent': 'sol-snip-bot/1.0' },
          timeout: 10000,
          params,
          validateStatus: () => true,
        });

        if (
          response.status === 200 &&
          response.data?.success === true &&
          Array.isArray(response.data.data?.data)
        ) {
          const raydiumPools = response.data.data.data;
          await setCache(CACHE_KEY, JSON.stringify(raydiumPools), CACHE_TTL_SECONDS);
          logger.info('Fetched and cached Raydium pools data in Redis.');

          clearTimeout(timer);
          fetchPromise = null;
          resolve(raydiumPools);
          return;
        } else if (response.status === 429) {
          logger.warn(`Rate limit (429) encountered. Waiting ${backoff}ms before retrying...`);
          await delay(backoff);
          backoff = Math.min(backoff * 2, 60000);
        } else {
          logger.error(
            `Unexpected response from Raydium API. Status: ${response.status}, Data: ${JSON.stringify(response.data).slice(0,200)}... Retrying in ${backoff}ms.`
          );
          await delay(backoff);
          backoff = Math.min(backoff * 2, 60000);
        }
      } catch (error) {
        const message = axios.isAxiosError(error) ? (error as AxiosError).message : (error as Error).message;
        logger.warn(`Attempt ${attempt + 1} failed: ${message}. Retrying in ${backoff}ms...`);
        await delay(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
      attempt++;
    }

    clearTimeout(timer);
    fetchPromise = null;
    logger.error('Max retries reached. Unable to fetch Raydium pools.');
    resolve([]);
  });

  return fetchPromise;
};

/**
 * Retrieves the liquidity of a given mint address across all Raydium pools.
 * Liquidity is calculated by summing up the amount of the given mint found in all pools.
 * If `mintA` matches the mint, add `mintAmountA` (adjusted by decimals).
 * If `mintB` matches the mint, add `mintAmountB` (adjusted by decimals).
 *
 * @param mintAddress The mint address to check.
 * @returns The total liquidity amount in terms of the number of tokens.
 */
export const getLiquidity = async (mintAddress: string): Promise<number> => {
  try {
    const raydiumPools = await fetchRaydiumPoolsWithCache();
    if (!Array.isArray(raydiumPools)) {
      logger.error('Raydium pools data is not an array. Returning 0 liquidity.');
      return 0;
    }

    let totalLiquidity = 0;
    for (const pool of raydiumPools) {
      const { mintA, mintB, mintAmountA, mintAmountB } = pool;

      const amountA = mintAmountA || 0;
      const amountB = mintAmountB || 0;

      if (mintA && mintA.address === mintAddress) {
        const factor = Math.pow(10, mintA.decimals || 0);
        totalLiquidity += amountA / factor;
      }

      if (mintB && mintB.address === mintAddress) {
        const factor = Math.pow(10, mintB.decimals || 0);
        totalLiquidity += amountB / factor;
      }
    }

    logger.info(`Calculated liquidity for mint ${mintAddress}: ${totalLiquidity}`);
    return totalLiquidity;
  } catch (error) {
    logger.error('Error fetching liquidity from DEX:', error);
    return 0;
  }
};

/**
 * Checks if the given mint address has an active mint authority.
 * If the RPC or fetch fails, returns false.
 *
 * @param mintAddress The mint public key as a string.
 */
export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  try {
    const mintPublicKey = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mintPublicKey);
    const hasAuthority = mintInfo.mintAuthority !== null;
    logger.info(`Mint ${mintAddress} has mint authority: ${hasAuthority}`);
    return hasAuthority;
  } catch (error) {
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
    const mintPublicKey = new PublicKey(mintAddress);
    const largestAccounts = await connection.getTokenLargestAccounts(mintPublicKey);
    if (!largestAccounts.value || largestAccounts.value.length === 0) {
      logger.warn(`No token accounts found for mint ${mintAddress}.`);
      return 0;
    }

    const supplyResponse = await connection.getTokenSupply(mintPublicKey);
    const totalSupply = supplyResponse.value.uiAmount || 0;
    if (totalSupply === 0) {
      logger.warn(`Total supply for mint ${mintAddress} is zero, cannot calculate concentration.`);
      return 0;
    }

    const sortedAccounts = largestAccounts.value.sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));
    const topAccounts = sortedAccounts.slice(0, topN);
    const topSum = topAccounts.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
    const concentration = (topSum / totalSupply) * 100;

    logger.info(`Top ${topN} holders concentration for mint ${mintAddress}: ${concentration.toFixed(2)}%`);
    return concentration;
  } catch (error) {
    logger.error(`Error calculating top holders concentration for ${mintAddress}:`, error);
    return 0;
  }
};
