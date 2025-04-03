import { PublicKey } from '@solana/web3.js';
import { loadUserKeypair, getUserWallet, getUserBalance } from './walletService';
import { logger } from '../utils/logger';
import { connection } from './solanaService';
import { TokenInfo } from '../types';
import { swapTokens } from './dexService'; 
import { notifyUserById } from '../bots/telegramBot'; 
import { getUserSettings } from './userSettingsService';
import { getTokenBalance, hasMinimumTokenBalance } from './tokenBalanceService';

// Define WSOL mint for Solana
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Cache market data to reduce redundant network requests
const marketCache: Map<string, { data: any, expiry: number }> = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds cache lifespan

/**
 * Validate a given token mint address.
 * @param mintAddress - The token mint address to validate.
 * @returns True if valid, false otherwise.
 */
const isValidMintAddress = (mintAddress: string): boolean => {
  try {
    new PublicKey(mintAddress);
    return true;
  } catch {
    return false;
  }
};

/**
 * Get optimal slippage based on token liquidity and volatility
 * @param tokenAddress Token mint address
 * @returns Appropriate slippage percentage
 */
const getOptimalSlippage = async (tokenAddress: string): Promise<number> => {
  try {
    // Check cache first
    const cacheKey = `slippage:${tokenAddress}`;
    const cached = marketCache.get(cacheKey);
    
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }
    
    // Default values for memecoins which typically need higher slippage
    let slippage = 2.5; // Default to 2.5% slippage
    
    try {
      // Try to get token liquidity info - if this becomes available in dexService
      // For now, just use defaults optimized for memecoins
      
      // Adjust slippage based on liquidity and volatility
      // For memecoins: Use higher slippage to increase success rate
      // This could be enhanced with actual liquidity data
      
      // Cache the result
      marketCache.set(cacheKey, {
        data: slippage,
        expiry: Date.now() + CACHE_TTL
      });
      
    } catch (error) {
      logger.warn(`Could not determine optimal slippage for ${tokenAddress}, using default`);
    }
    
    return slippage;
  } catch (error) {
    return 2.5; // Default fallback value
  }
};

/**
 * Purchases a token for the user using the user-defined amount of SOL.
 * @param userId - The unique identifier of the user.
 * @param tokenInfo - Information about the token to purchase.
 * @param customAmount - Optional custom amount to override user settings
 * @returns A transaction object with success status and additional data
 */
export const purchaseToken = async (
  userId: number, 
  tokenInfo: TokenInfo,
  customAmount?: number
): Promise<{
  success: boolean;
  amountSpent?: number;
  tokensPurchased?: number;
  entryPrice?: number;
  txId?: string;
}> => {
  try {
    // Retrieve user settings
    const settings = await getUserSettings(userId);
    const requiredSol = customAmount || settings.buyamount;

    if (requiredSol === null || requiredSol === undefined) {
      logger.error(`User ${userId} has not set a purchase amount.`);
      await notifyUserById(
        userId,
        `⚠️ Purchase amount not set. Please use /set_buy_amount to set your purchase amount.`
      );
      return { success: false };
    }

    return await executeTokenPurchase(userId, tokenInfo, requiredSol);
  } catch (error: any) {
    logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    await notifyUserById(
      userId,
      `❌ An error occurred while purchasing token ${tokenInfo.mintAddress}.`
    );
    return { success: false };
  }
};

/**
 * Executes the actual token purchase with error handling and validation
 */
async function executeTokenPurchase(
  userId: number,
  tokenInfo: TokenInfo,
  amountInSol: number
): Promise<{
  success: boolean;
  amountSpent?: number;
  tokensPurchased?: number;
  entryPrice?: number;
  txId?: string;
}> {
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with purchase.`);
      await notifyUserById(
        userId,
        `❌ Wallet not found. Please set up your wallet before purchasing tokens.`
      );
      return { success: false };
    }

    // Validate the token's mint address
    if (!isValidMintAddress(tokenInfo.mintAddress)) {
      logger.error(`Invalid token mint address provided: ${tokenInfo.mintAddress}`);
      await notifyUserById(
        userId,
        `❌ Invalid token mint address detected. Cannot proceed with the purchase.`
      );
      return { success: false };
    }

    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    const userBalance = await getUserBalance(fromKeypair.publicKey);

    // Check if the user has enough SOL
    if (userBalance < amountInSol) {
      logger.warn(
        `User ${userId} has insufficient balance (only ${userBalance.toFixed(4)} SOL) to purchase token ${tokenInfo.mintAddress}.`
      );
      
      // If insufficient balance, use 90% of available balance instead
      if (userBalance > 0.01) { // Ensure at least 0.01 SOL for transaction fees
        const adjustedAmount = userBalance * 0.9;
        logger.info(`Adjusting purchase amount to ${adjustedAmount.toFixed(4)} SOL due to low balance`);
        await notifyUserById(
          userId,
          `⚠️ Insufficient funds for requested amount. Using ${adjustedAmount.toFixed(4)} SOL instead.`
        );
        amountInSol = adjustedAmount;
      } else {
        await notifyUserById(
          userId,
          `❌ You need at least 0.01 SOL to purchase this token. Current balance: ${userBalance.toFixed(4)} SOL`
        );
        return { success: false };
      }
    }

    const amountInLamports = Math.floor(amountInSol * 1e9); // Convert SOL to lamports
    const tokenMint = new PublicKey(tokenInfo.mintAddress);

    // Get pre-purchase token balance if token already exists in wallet
    const prePurchaseBalance = await getTokenBalance(fromKeypair.publicKey, tokenMint);
    
    // Get appropriate slippage for this token
    const slippage = await getOptimalSlippage(tokenInfo.mintAddress);

    // Execute the swap with optimized parameters for memecoins
    const swapResult = await swapTokens({
      connection,
      walletKeypair: fromKeypair,
      sourceTokenMint: WSOL_MINT,
      destinationTokenMint: tokenMint,
      amountInLamports,
      slippage, // Use optimal slippage
      priorityFee: true, // Use priority fees to ensure transactions go through
    });

    if (swapResult.success) {
      // Get post-purchase token balance
      const postPurchaseBalance = await getTokenBalance(fromKeypair.publicKey, tokenMint);
      
      // Calculate tokens received and entry price
      const tokensReceived = postPurchaseBalance - prePurchaseBalance;
      const entryPrice = amountInSol / tokensReceived;
      
      logger.info(`Successfully purchased ${tokensReceived.toLocaleString()} tokens of ${tokenInfo.mintAddress} for user ${userId} at ${entryPrice.toFixed(8)} SOL/token.`);
      
      return {
        success: true,
        amountSpent: amountInSol,
        tokensPurchased: tokensReceived,
        entryPrice: entryPrice,
        txId: swapResult.txId
      };
    } else {
      logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}: ${swapResult.error || 'Unknown error'}`);
      return { success: false };
    }
  } catch (error: any) {
    logger.error(`Error in executeTokenPurchase: ${error.message}`, error);
    return { success: false };
  }
}

/**
 * Sells a specified token back to SOL
 * @param userId - The unique identifier of the user
 * @param tokenInfo - Information about the token to sell
 * @param sellPercentage - Percentage of holdings to sell (1-100)
 * @returns Transaction result object with success status and data
 */
export const sellToken = async (
  userId: number,
  tokenInfo: TokenInfo,
  sellPercentage: number = 100 // Default to selling 100% of holdings
): Promise<{
  success: boolean;
  amountReceived?: number;
  tokensSold?: number;
  exitPrice?: number;
  txId?: string;
}> => {
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with sell.`);
      return { success: false };
    }

    // Validate the token's mint address
    if (!isValidMintAddress(tokenInfo.mintAddress)) {
      logger.error(`Invalid token mint address provided: ${tokenInfo.mintAddress}`);
      return { success: false };
    }

    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    const tokenMint = new PublicKey(tokenInfo.mintAddress);

    // Get current token balance
    const tokenBalance = await getTokenBalance(fromKeypair.publicKey, tokenMint);
    
    if (tokenBalance <= 0) {
      logger.warn(`User ${userId} has no balance of token ${tokenInfo.mintAddress} to sell.`);
      return { success: false };
    }

    // Calculate amount to sell based on percentage
    const amountToSell = Math.floor(tokenBalance * (sellPercentage / 100));
    
    if (amountToSell <= 0) {
      logger.warn(`Calculated sell amount is zero or negative for token ${tokenInfo.mintAddress}.`);
      return { success: false };
    }

    // Get token decimals to convert normalized amount back to raw amount
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      fromKeypair.publicKey,
      { mint: tokenMint }
    );
    
    if (tokenAccounts.value.length === 0) {
      logger.error(`No token account found for ${tokenInfo.mintAddress}`);
      return { success: false };
    }
    
    const tokenDecimals = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;
    const rawAmountToSell = Math.floor(amountToSell * Math.pow(10, tokenDecimals));
    
    // Get pre-sell SOL balance
    const preSellSolBalance = await getUserBalance(fromKeypair.publicKey);
    
    // Get appropriate slippage for this token (typically higher for selling)
    const slippage = await getOptimalSlippage(tokenInfo.mintAddress) * 1.2; // Higher slippage for selling

    // Execute the swap (token to SOL)
    const swapResult = await swapTokens({
      connection,
      walletKeypair: fromKeypair,
      sourceTokenMint: tokenMint,
      destinationTokenMint: WSOL_MINT,
      amountInLamports: rawAmountToSell, // Now using raw token amount with proper decimals
      slippage, // Use optimal slippage
      priorityFee: true, // Use priority fees to ensure transactions go through
    });

    if (swapResult.success) {
      // Get post-sell SOL balance
      const postSellSolBalance = await getUserBalance(fromKeypair.publicKey);
      
      // Calculate SOL received and exit price
      const solReceived = postSellSolBalance - preSellSolBalance;
      const exitPrice = solReceived / amountToSell;
      
      logger.info(`Successfully sold ${amountToSell.toLocaleString()} tokens of ${tokenInfo.mintAddress} for user ${userId} at ${exitPrice.toFixed(8)} SOL/token.`);
      
      return {
        success: true,
        amountReceived: solReceived,
        tokensSold: amountToSell,
        exitPrice: exitPrice,
        txId: swapResult.txId
      };
    } else {
      logger.error(`Failed to sell token ${tokenInfo.mintAddress} for user ${userId}: ${swapResult.error || 'Unknown error'}`);
      return { success: false };
    }
  } catch (error: any) {
    logger.error(`Failed to sell token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    return { success: false };
  }
};
