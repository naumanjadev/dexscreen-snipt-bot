// src/services/tokenDataService.ts

import { PublicKey, Connection, clusterApiUrl } from '@solana/web3.js';
import { getCache, setCache } from './cacheService';
import axios from 'axios';
import { logger } from '../utils/logger';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot';
import { fetchTokenMetadata } from './tokenMetadataService';
import {
  getMintWithRateLimit,
  getTokenSupplyWithRateLimit,
  getTokenLargestAccountsWithRateLimit,
} from './rpcRateLimiter';
import { Mint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TokenAccountBalancePair, TokenAmount } from '@solana/web3.js';

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

interface TokenDataPayload {
  pubkey: string;
  account: {
    data: {
      parsed: {
        type: string; // "mint" for mint accounts
        info: {
          mintAuthority?: string;
          supply?: string;
          decimals?: number;
        };
      };
    };
    owner: string;
  };
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_KEY = 'splTokenData';
const CACHE_TTL_SECONDS = 120;

let fetchPromise: Promise<TokenDataPayload[]> | null = null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchSplTokenDataWithCache = async (): Promise<TokenDataPayload[]> => {
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

    const url = 'https://mainnet.helius-rpc.com/?api-key=34f4403f-f9da-4d03-a6df-3de140c97f06';

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.post(
          url,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getProgramAccounts',
            params: [
              TOKEN_PROGRAM_ID.toBase58(),
              {
                encoding: 'jsonParsed',
                filters: [{ dataSize: 82 }], // Mint accounts are 82 bytes
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

async function isLikelyValidMint(mintAddress: string): Promise<boolean> {
  try {
    const pubkey = new PublicKey(mintAddress);
    // Check if the address can be fetched and parsed as a mint
    const info = await connection.getParsedAccountInfo(pubkey);
    if (info.value && 'parsed' in info.value.data) {
      // Check if parsed type == "mint"
      const parsed = (info.value.data as any).parsed;
      if (parsed && parsed.type === 'mint') {
        return true;
      }
    }
    return false;
  } catch {
    // Invalid or couldn't fetch
    return false;
  }
}

const safeGetMintInfo = async (mintAddress: string): Promise<Mint | null> => {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address detected: ${mintAddress}. Skipping mint info fetch.`);
    return null;
  }

  // Additional check before calling getMintWithRateLimit
  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint account structure: ${mintAddress}. Skipping.`);
    return null;
  }

  try {
    const mintInfo: Mint = await getMintWithRateLimit(mintAddress);
    return mintInfo;
  } catch (error: any) {
    logger.error(`Error in getMint for ${mintAddress}:`);
    logger.error(error?.message || error);
    return null;
  }
};

export const getLiquidity = async (mintAddress: string): Promise<number> => {
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.error(
      `Error fetching circulating supply for mint ${mintAddress}: Mint info not available.`
    );
    return 0;
  }

  const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
  const nonCirculatingSupply = 0; 
  const circulatingSupply = totalSupply - nonCirculatingSupply;
  logger.info(`Calculated circulating supply for mint ${mintAddress}: ${circulatingSupply}`);
  return circulatingSupply;
};

export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.error(`Error checking mint authority for ${mintAddress}: Mint info not available.`);
    return false;
  }

  const hasAuthority = mintInfo.mintAuthority !== null;
  logger.info(`Mint ${mintAddress} has mint authority: ${hasAuthority}`);
  return hasAuthority;
};

export const getTopHoldersConcentration = async (
  mintAddress: string,
  topN: number = 10
): Promise<number> => {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address detected: ${mintAddress}. Skipping concentration calculation.`);
    return 0;
  }

  // Verify if it's a valid mint
  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint account structure: ${mintAddress}. Skipping concentration calculation.`);
    return 0;
  }

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

    const sortedAccounts = largestAccounts.sort(
      (a, b) => (b.uiAmount || 0) - (a.uiAmount || 0)
    );

    const topAccounts = sortedAccounts.slice(0, topN);
    const topSum = topAccounts.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
    const concentration = (topSum / totalSupply) * 100;

    logger.info(`Top ${topN} holders concentration for mint ${mintAddress}: ${concentration.toFixed(2)}%`);
    return concentration;
  } catch (error: any) {
    logger.error(`Error calculating top holders concentration for ${mintAddress}:`, error);
    return 0;
  }
};

export const processNewToken = async (mintAddress: string) => {
  try {
    new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address detected: ${mintAddress}. Skipping processing.`);
    return;
  }

  const liquidity = await getLiquidity(mintAddress);
  const hasAuthority = await hasMintAuthority(mintAddress);
  const concentration = await getTopHoldersConcentration(mintAddress);

  logger.info(`New Mint Details:
    Address: ${mintAddress}
    Liquidity: ${liquidity}
    Has Mint Authority: ${hasAuthority}
    Top Holders Concentration: ${concentration.toFixed(2)}%
  `);
};

async function fetchNonCirculatingAccounts(): Promise<PublicKey[]> {
  try {
    const supplyInfo = await connection.getSupply();
    const nonCirculatingAccounts = supplyInfo.value.nonCirculatingAccounts.map(
      (address) => new PublicKey(address)
    );
    return nonCirculatingAccounts;
  } catch (error: any) {
    logger.error(`Error fetching non-circulating accounts: ${error.message}`);
    return [];
  }
}

export const getCirculatingSupply = async (): Promise<number> => {
  try {
    const supplyInfo = await connection.getSupply();
    const circulatingSupply = supplyInfo.value.circulating;
    logger.info(`Circulating supply: ${circulatingSupply} lamports`);
    return circulatingSupply;
  } catch (error: any) {
    logger.error(`Error retrieving circulating supply:`, error);
    return 0;
  }
};

export {
  fetchSplTokenDataWithCache,
  fetchNonCirculatingAccounts
};
