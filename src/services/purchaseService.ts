// src/services/purchaseService.ts

import { Keypair, PublicKey } from '@solana/web3.js';
import { loadUserKeypair, getUserWallet } from './walletService';
import { logger } from '../utils/logger';
import { connection } from './solanaService';
import { TokenInfo } from '../types';
import { swapTokens } from './dexService';

/**
 * Purchases a token for the user.
 * @param userId - The unique identifier of the user.
 * @param tokenInfo - Information about the token to purchase.
 */
export const purchaseToken = async (userId: number, tokenInfo: TokenInfo): Promise<void> => {
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      logger.error(`User wallet not found for user ${userId}. Cannot proceed with purchase.`);
      return;
    }

    // Load the user's Keypair
    const fromKeypair = loadUserKeypair(userWallet.encryptedPrivateKey);

    logger.info(`Attempting to purchase token ${tokenInfo.mintAddress} for user ${userId}.`);

    // Define the amount of SOL to use for the purchase
    const amountInSol = 0.01; // Adjust the amount as needed

    // Convert SOL amount to lamports
    const amountInLamports = amountInSol * 1e9;

    // The mint address of SOL is special; we use wrapped SOL (WSOL)
    const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');

    // The mint address of the target token
    const tokenMint = new PublicKey(tokenInfo.mintAddress);

    // Perform the token swap
    const success = await swapTokens({
      connection,
      walletKeypair: fromKeypair,
      sourceTokenMint: wsolMint,
      destinationTokenMint: tokenMint,
      amountInLamports,
    });

    if (success) {
      logger.info(`Successfully purchased token ${tokenInfo.mintAddress} for user ${userId}.`);
    } else {
      logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}.`);
    }

  } catch (error) {
    logger.error(`Failed to purchase token ${tokenInfo.mintAddress} for user ${userId}:`, error);
  }
};
