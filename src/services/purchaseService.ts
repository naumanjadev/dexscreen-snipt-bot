import { PublicKey } from '@solana/web3.js';
import { loadUserKeypair, getUserWallet, getUserBalance } from './walletService';
import { logger } from '../utils/logger';
import { connection } from './solanaService';
import { TokenInfo } from '../types';
import { swapTokens } from './dexService'; 
import { notifyUserById } from '../bots/telegramBot'; 
import { getUserSettings } from './userSettingsService';

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Purchases a token for the user using the user-defined amount of SOL.
 * @param userId - The unique identifier of the user.
 * @param tokenInfo - Information about the token to purchase.
 * @returns A boolean indicating whether the purchase was successful.
 */
export const purchaseToken = async (userId: number, tokenInfo: TokenInfo): Promise<boolean> => {
  try {
    // Retrieve user settings
    const settings = await getUserSettings(userId);
    const requiredSol = settings.buyamount;

    if (requiredSol === null || requiredSol === undefined) {
      logger.error(`User ${userId} has not set a purchase amount.`);
      await notifyUserById(
        userId,
        `❌ Purchase amount not set. Please set your purchase amount using the bot settings.`
      );
      return false;
    }

    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with purchase.`);
      await notifyUserById(
        userId,
        `❌ Wallet not found. Please set up your wallet before purchasing tokens.`
      );
      return false;
    }

    // Validate the token's mint address
    if (!isValidMintAddress(tokenInfo.mintAddress)) {
      logger.error(`Invalid token mint address provided: ${tokenInfo.mintAddress}`);
      await notifyUserById(
        userId,
        `❌ Invalid token mint address detected. Cannot proceed with the purchase.`
      );
      return false;
    }

    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    const userBalance = await getUserBalance(fromKeypair.publicKey);

    // Check if the user has enough SOL
    if (userBalance < requiredSol) {
      logger.warn(
        `User ${userId} has insufficient balance (only ${userBalance.toFixed(4)} SOL) to purchase token ${tokenInfo.mintAddress}.`
      );
      await notifyUserById(
        userId,
        `❌ You need at least ${requiredSol} SOL to purchase this token. Current balance: ${userBalance.toFixed(4)} SOL`
      );
      return false;
    }

    // Notify user that a matching token was found
    await notifyUserById(
      userId,
      `🎉 Token Matched: ${tokenInfo.mintAddress}\nPreparing to buy token with ${requiredSol} SOL...`
    );

    // Wait 1 second before executing the purchase
    await delay(1000);

    const amountInLamports = Math.floor(requiredSol * 1e9); // Convert SOL to lamports
    const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');
    const tokenMint = new PublicKey(tokenInfo.mintAddress);

    const success = await swapTokens({
      connection,
      walletKeypair: fromKeypair,
      sourceTokenMint: wsolMint,
      destinationTokenMint: tokenMint,
      amountInLamports,
    });

    if (success) {
      logger.info(`Successfully purchased token ${tokenInfo.mintAddress} for user ${userId}.`);
      await notifyUserById(
        userId,
        `✅ Successfully purchased token ${tokenInfo.mintAddress} using ${requiredSol.toFixed(4)} SOL!`
      );
      await notifyUserById(userId, `📡 Token detection has been stopped after your purchase.`);
      return true;
    } else {
      logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}.`);
      await notifyUserById(
        userId,
        `❌ Failed to purchase token ${tokenInfo.mintAddress}. Please try again later.`
      );
      return false;
    }
  } catch (error: any) {
    logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    await notifyUserById(
      userId,
      `❌ An error occurred while purchasing token ${tokenInfo.mintAddress}.`
    );
    return false;
  }
};
