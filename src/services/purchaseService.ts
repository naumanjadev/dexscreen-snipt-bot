// src/services/purchaseService.ts

import { Keypair, PublicKey } from '@solana/web3.js';
import { loadUserKeypair, getUserWallet } from './walletService';
import { logger } from '../utils/logger';
import { connection } from './solanaService';
import { TokenInfo, MyContext } from '../types';
import { swapTokens } from './dexService';
import { stopTokenListener } from './solanaListener';
import { getUserBalance } from './walletService';
import { notifyUser } from '../bots/telegramBot';

/**
 * Purchases a token for the user.
 * @param ctx - The context of the Telegram message (for sending notifications).
 * @param userId - The unique identifier of the user.
 * @param tokenInfo - Information about the token to purchase.
 */
export const purchaseToken = async (ctx: MyContext, userId: number, tokenInfo: TokenInfo): Promise<void> => {
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with purchase.`);
      await notifyUser(ctx, `❌ Wallet not found. Please set up your wallet before purchasing tokens.`);
      return;
    }

    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);
    const userBalance = await getUserBalance(fromKeypair.publicKey);

    // Use 10% of the user's SOL balance for the purchase
    const amountInSol = userBalance * 0.1;
    if (amountInSol <= 0) {
      logger.warn(`User ${userId} has insufficient balance to purchase token ${tokenInfo.mintAddress}.`);
      await notifyUser(ctx, `❌ Insufficient balance to purchase token ${tokenInfo.mintAddress}.`);
      return;
    }

    // Notify user that a matching token was found
    await notifyUser(ctx, `🎉 Token Matched: ${tokenInfo.mintAddress}\nPreparing to buy token...`);

    // Wait 2 seconds before executing the purchase
    await delay(2000);

    const amountInLamports = amountInSol * 1e9;
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
      await notifyUser(
        ctx,
        `✅ Successfully purchased token ${tokenInfo.mintAddress} using ${amountInSol.toFixed(4)} SOL!`
      );
      // After buying, stop the listener for this user
      await stopTokenListener(userId);
      await notifyUser(ctx, `📡 Token detection has been stopped after your purchase.`);
    } else {
      logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}.`);
      await notifyUser(ctx, `❌ Failed to purchase token ${tokenInfo.mintAddress}. Please try again later.`);
    }
  } catch (error) {
    logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    await notifyUser(ctx, `❌ An error occurred while purchasing token ${tokenInfo.mintAddress}.`);
  }
};

/**
 * Delay execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
