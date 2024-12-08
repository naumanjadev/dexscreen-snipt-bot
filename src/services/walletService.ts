// src/services/walletService.ts

import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import { encrypt, decrypt } from '../utils/encryption';
import { UserWallet, IUserWallet } from '../models/userWallet';
import { logger } from '../utils/logger';
import { createWallet as createSolanaWallet, connection } from './solanaService';

/**
 * Retrieves the user's wallet from the database.
 * @param userId - The unique identifier of the user.
 * @returns The user's wallet or null if not found.
 */
export const getUserWallet = async (userId: number): Promise<IUserWallet | null> => {
  return await UserWallet.findOne({ userId });
};

/**
 * Creates a new user wallet and saves it to the database.
 * @param userId - The unique identifier of the user.
 * @returns The created user wallet.
 */
export const createUserWallet = async (userId: number): Promise<IUserWallet> => {
  const wallet: Keypair = createSolanaWallet();
  const encryptedPrivateKey: string = encrypt(Buffer.from(wallet.secretKey).toString('base64'));
  const userWallet = new UserWallet({
    userId,
    publicKey: wallet.publicKey.toBase58(),
    encryptedPrivateKey,
  });
  await userWallet.save();
  logger.info(`Created wallet for user ${userId}`);
  return userWallet;
};

/**
 * Deletes the user's wallet from the database.
 * @param userId - The unique identifier of the user.
 */
export const deleteUserWallet = async (userId: number): Promise<void> => {
  await UserWallet.deleteOne({ userId });
  logger.info(`Deleted wallet for user ${userId}`);
};

/**
 * Retrieves the balance of the user's wallet.
 * @param publicKey - The public key of the wallet.
 * @returns The balance in SOL.
 */
export const getWalletBalance = async (publicKey: string): Promise<number> => {
  const balanceLamports = await connection.getBalance(new PublicKey(publicKey));
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
  return balanceSol;
};

/**
 * Loads the user's Keypair from the encrypted private key.
 * @param encryptedPrivateKey - The encrypted private key.
 * @returns The Keypair.
 */
export const loadUserKeypair = (encryptedPrivateKey: string): Keypair => {
  const decryptedKey = decrypt(encryptedPrivateKey);
  const secretKey = Buffer.from(decryptedKey, 'base64');
  return Keypair.fromSecretKey(secretKey);
};

/**
 * Sends SOL from the user's wallet to a specified public key.
 * @param fromKeypair - The Keypair of the sender.
 * @param toPublicKey - The public key of the recipient.
 * @param amount - The amount of SOL to send.
 */
export const sendTransaction = async (
  fromKeypair: Keypair,
  toPublicKey: string,
  amount: number
): Promise<void> => {
  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: new PublicKey(toPublicKey),
        lamports: amount * LAMPORTS_PER_SOL,
      })
    );

    const signature = await connection.sendTransaction(transaction, [fromKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');
    logger.info(`Sent ${amount} SOL from ${fromKeypair.publicKey.toBase58()} to ${toPublicKey}`);
  } catch (error) {
    logger.error(`Transaction failed: ${(error as Error).message}`);
    throw error;
  }
};
