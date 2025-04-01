import { PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { connection } from './solanaService';
import { logger } from '../utils/logger';

/**
 * Gets the balance of a specific token for a wallet
 * @param walletAddress - The public key of the wallet
 * @param tokenMint - The mint address of the token
 * @returns The token balance as a number
 */
export const getTokenBalance = async (walletAddress: PublicKey, tokenMint: PublicKey): Promise<number> => {
  try {
    // Find the token account address for this wallet and token
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { mint: tokenMint }
    );

    // If no token account exists, the balance is 0
    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // For multiple accounts, sum all balances (rare case)
    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsedInfo = account.account.data.parsed.info;
      const balance = Number(parsedInfo.tokenAmount.amount) / Math.pow(10, parsedInfo.tokenAmount.decimals);
      totalBalance += balance;
    }

    return totalBalance;
  } catch (error: any) {
    logger.error(`Error fetching token balance for ${tokenMint.toString()}: ${error.message}`);
    return 0;
  }
};

/**
 * Gets all token balances for a wallet with fast parallel processing
 * @param walletAddress - The public key of the wallet
 * @returns An array of token balances with mint addresses and amounts
 */
export const getAllTokenBalances = async (walletAddress: PublicKey): Promise<Array<{
  mint: string,
  balance: number,
  decimals: number,
  uiBalance: number
}>> => {
  try {
    // Get all token accounts for this wallet - one API call for efficiency
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { programId: TOKEN_PROGRAM_ID }
    );

    // Process the results
    return tokenAccounts.value.map(account => {
      const parsedInfo = account.account.data.parsed.info;
      const balance = Number(parsedInfo.tokenAmount.amount);
      const decimals = parsedInfo.tokenAmount.decimals;
      const uiBalance = balance / Math.pow(10, decimals);
      
      return {
        mint: parsedInfo.mint,
        balance,
        decimals,
        uiBalance
      };
    }).filter(token => token.uiBalance > 0); // Only include tokens with non-zero balances
  } catch (error: any) {
    logger.error(`Error fetching all token balances: ${error.message}`);
    return [];
  }
};

/**
 * Optimized function to check if a wallet has a minimum balance of a specific token
 * Faster than getTokenBalance when only need to check if balance meets a threshold
 * @param walletAddress - The public key of the wallet
 * @param tokenMint - The mint address of the token
 * @param minimumBalance - The minimum balance to check for
 * @returns True if the wallet has at least the minimum balance
 */
export const hasMinimumTokenBalance = async (
  walletAddress: PublicKey, 
  tokenMint: PublicKey,
  minimumBalance: number
): Promise<boolean> => {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { mint: tokenMint }
    );

    if (tokenAccounts.value.length === 0) {
      return false;
    }

    // Check if any account has the minimum balance
    for (const account of tokenAccounts.value) {
      const parsedInfo = account.account.data.parsed.info;
      const balance = Number(parsedInfo.tokenAmount.amount) / Math.pow(10, parsedInfo.tokenAmount.decimals);
      if (balance >= minimumBalance) {
        return true;
      }
    }
    
    return false;
  } catch (error: any) {
    logger.error(`Error checking token balance for ${tokenMint.toString()}: ${error.message}`);
    return false;
  }
}; 