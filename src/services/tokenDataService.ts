// src/services/tokenDataService.ts
import { PublicKey, TokenAccountBalancePair } from '@solana/web3.js';
import { connection } from './solanaListener';
import axios from 'axios';

export const getLiquidity = async (mintAddress: string): Promise<number> => {
  // Use a DEX API like Raydium to get liquidity information
  const liquidity = await fetchLiquidityFromDEX(mintAddress);
  return liquidity;
};

const fetchLiquidityFromDEX = async (mintAddress: string): Promise<number> => {
  try {
    let totalLiquidity = 0;

    const raydiumResponse = await axios.get(
      'https://api.raydium.io/v2/sdk/liquidity/mainnet.json'
    );
    const raydiumPools = raydiumResponse.data;

    for (const poolId in raydiumPools) {
      const pool = raydiumPools[poolId];
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

    return totalLiquidity;
  } catch (error) {
    console.error('Error fetching liquidity from DEX:', error);
    return 0;
  }
};

export const hasMintAuthority = async (mintAddress: string): Promise<boolean> => {
  const mintPublicKey = new PublicKey(mintAddress);
  const mintAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);
  if (mintAccountInfo.value) {
    const data = mintAccountInfo.value.data as any;
    const mintAuthority = data.parsed.info.mintAuthority;
    return mintAuthority !== null;
  }
  return false;
};

export const getTopHoldersConcentration = async (mintAddress: string): Promise<number> => {
  // Fetch token accounts holding this token
  const largestAccounts = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
  const totalSupply = await connection.getTokenSupply(new PublicKey(mintAddress));

  const top10Accounts = largestAccounts.value.slice(0, 10);
  const top10Balance = top10Accounts.reduce(
    (sum: number, account: TokenAccountBalancePair): number => sum + (account.uiAmount || 0),
    0
  );

  const totalSupplyAmount = totalSupply.value.uiAmount || 0;
  const concentration = totalSupplyAmount > 0 ? (top10Balance / totalSupplyAmount) * 100 : 0;
  return concentration;
};
