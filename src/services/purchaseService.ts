// src/services/purchaseService.ts

import { PublicKey } from '@solana/web3.js';
import { loadUserKeypair, getUserWallet, getUserBalance } from './walletService';
import { logger } from '../utils/logger';
import { connection } from './solanaService';
import { TokenInfo } from '../types';
import { swapTokens } from './dexService'; // Adjust if necessary
import { notifyUserById } from '../bots/telegramBot'; // Adjust the path as necessary

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Purchases a token for the user using exactly 0.1 SOL if available.
 * @param userId - The unique identifier of the user.
 * @param tokenInfo - Information about the token to purchase.
 * @returns A boolean indicating whether the purchase was successful.
 */
export const purchaseToken = async (userId: number, tokenInfo: TokenInfo): Promise<boolean> => {
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with purchase.`);
      await notifyUserById(userId, `❌ Wallet not found. Please set up your wallet before purchasing tokens.`);
      return false;
    }

    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    const userBalance = await getUserBalance(fromKeypair.publicKey);

    // Check if the user has at least 0.1 SOL
    const requiredSol = 0.05;
    if (userBalance < requiredSol) {
      logger.warn(`User ${userId} has insufficient balance (only ${userBalance.toFixed(4)} SOL) to purchase token ${tokenInfo.mintAddress}.`);
      await notifyUserById(
        userId, 
        `❌ You need at least ${requiredSol} SOL to purchase this token. Current balance: ${userBalance.toFixed(4)} SOL`
      );
      return false;
    }

    // Notify user that a matching token was found
    await notifyUserById(userId, `🎉 Token Matched: ${tokenInfo.mintAddress}\nPreparing to buy token with ${requiredSol} SOL...`);

    // Wait 1 second before executing the purchase (as per the latest code snippet)
    await delay(1000);

    const amountInLamports = Math.floor(requiredSol * 1e9);
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
      await notifyUserById(userId, `❌ Failed to purchase token ${tokenInfo.mintAddress}. Please try again later.`);
      return false;
    }
  } catch (error: any) {
    logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    await notifyUserById(userId, `❌ An error occurred while purchasing token ${tokenInfo.mintAddress}.`);
    return false;
  }
};
