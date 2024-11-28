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
  
  export const getUserWallet = async (userId: number): Promise<IUserWallet | null> => {
    return await UserWallet.findOne({ userId });
  };
  
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
  
  export const deleteUserWallet = async (userId: number): Promise<void> => {
    await UserWallet.deleteOne({ userId });
    logger.info(`Deleted wallet for user ${userId}`);
  };
  
  export const getWalletBalance = async (publicKey: string): Promise<number> => {
    const balanceLamports = await connection.getBalance(new PublicKey(publicKey));
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    return balanceSol;
  };
  
  export const loadUserKeypair = (encryptedPrivateKey: string): Keypair => {
    const decryptedKey = decrypt(encryptedPrivateKey);
    const secretKey = Buffer.from(decryptedKey, 'base64');
    return Keypair.fromSecretKey(secretKey);
  };
  
  export const sendSol = async (
    fromKeypair: Keypair,
    toPublicKey: string,
    amount: number
  ): Promise<void> => {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: new PublicKey(toPublicKey),
        lamports: amount * LAMPORTS_PER_SOL,
      })
    );
  
    const signature = await connection.sendTransaction(transaction, [fromKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');
  };
  