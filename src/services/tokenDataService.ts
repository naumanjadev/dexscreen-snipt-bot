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

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;
const FETCH_TIMEOUT_MS = 30000;
const CACHE_KEY = 'splTokenData';
const CACHE_TTL_SECONDS = 120;

let fetchPromise: Promise<any[]> | null = null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Keeping these functions for demonstration, though we might not need them if not filtering by liquidity anymore.

async function isLikelyValidMint(mintAddress: string): Promise<boolean> {
  try {
    const pubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(pubkey);
    if (info.value && 'parsed' in info.value.data) {
      const parsed = (info.value.data as any).parsed;
      if (parsed && parsed.type === 'mint') {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

const safeGetMintInfo = async (mintAddress: string): Promise<Mint | null> => {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address detected: ${mintAddress}.`);
    return null;
  }

  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint account structure: ${mintAddress}.`);
    return null;
  }

  try {
    const mintInfo: Mint = await getMintWithRateLimit(mintAddress);
    return mintInfo;
  } catch (error: any) {
    logger.error(`Error in getMint for ${mintAddress}: ${error?.message || error}`);
    return null;
  }
};

export const getLiquidity = async (mintAddress: string): Promise<number> => {
  // Example: total supply as liquidity (not used now)
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.error(`Mint info not available for ${mintAddress}.`);
    return 0;
  }
  const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
  return totalSupply;
};

export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  const mintInfo = await safeGetMintInfo(mintAddress);
  if (!mintInfo) {
    logger.error(`Mint info not available for ${mintAddress}.`);
    return false;
  }
  const hasAuthority = mintInfo.mintAuthority !== null;
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
    logger.warn(`Invalid mint address: ${mintAddress}.`);
    return 0;
  }

  const valid = await isLikelyValidMint(mintAddress);
  if (!valid) {
    logger.warn(`Not a valid mint: ${mintAddress}.`);
    return 0;
  }

  try {
    const largestAccounts: TokenAccountBalancePair[] = await getTokenLargestAccountsWithRateLimit(mintAddress);
    if (!largestAccounts || largestAccounts.length === 0) {
      logger.warn(`No token accounts found for ${mintAddress}.`);
      return 0;
    }

    const supplyResponse: TokenAmount = await getTokenSupplyWithRateLimit(mintAddress);
    const totalSupply = supplyResponse.uiAmount || 0;
    if (totalSupply === 0) {
      logger.warn(`Total supply zero for ${mintAddress}.`);
      return 0;
    }

    const sortedAccounts = largestAccounts.sort(
      (a, b) => (b.uiAmount || 0) - (a.uiAmount || 0)
    );
    const topAccounts = sortedAccounts.slice(0, topN);
    const topSum = topAccounts.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
    const concentration = (topSum / totalSupply) * 100;
    return concentration;
  } catch (error: any) {
    logger.error(`Error calculating concentration for ${mintAddress}: ${error.message}`, error);
    return 0;
  }
};

export const processNewToken = async (mintAddress: string) => {
  try {
    new PublicKey(mintAddress);
  } catch {
    logger.warn(`Invalid mint address: ${mintAddress}.`);
    return;
  }

  const liquidity = await getLiquidity(mintAddress);
  const authority = await hasMintAuthority(mintAddress);
  const concentration = await getTopHoldersConcentration(mintAddress);

  logger.info(`New Mint Details:
    Address: ${mintAddress}
    Liquidity: ${liquidity}
    Has Authority: ${authority}
    Concentration: ${concentration.toFixed(2)}%
  `);
};

export const getCirculatingSupply = async (): Promise<number> => {
  try {
    const supplyInfo = await connection.getSupply();
    return supplyInfo.value.circulating;
  } catch (error: any) {
    logger.error(`Error retrieving circulating supply: ${error.message}`);
    return 0;
  }
};

export {
  // Keeping if needed in the future
};
