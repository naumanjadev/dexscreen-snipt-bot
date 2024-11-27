// src/services/solanaService.ts
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Transaction,
    SystemProgram,
  } from '@solana/web3.js';
  import { logger } from '../utils/logger';
  import { config } from '../config';
  import { encrypt, decrypt } from '../utils/encryption';
  
  export let connection: Connection;

  export const initializeConnection = (): void => {
    connection = new Connection(config.solanaRpcUrl, 'confirmed');
    logger.info(`Connected to Solana RPC at ${config.solanaRpcUrl}`);
  };
  
  export const createWallet = (): Keypair => {
    const wallet = Keypair.generate();
    logger.info(`New wallet created: ${wallet.publicKey.toBase58()}`);
    return wallet;
  };
  
  export const getEncryptedPrivateKey = (wallet: Keypair): string => {
    const secretKeyString = Buffer.from(wallet.secretKey).toString('base64');
    const encryptedKey = encrypt(secretKeyString);
    return encryptedKey;
  };
  
  export const saveEncryptedPrivateKey = (encryptedKey: string): void => {
    // In a real-world scenario, you would save this to a secure storage or file
    // For this example, we'll just log it (ensure you handle this securely)
    logger.info(`Encrypted Private Key: ${encryptedKey}`);
  };
  
  export const loadWalletFromEncryptedKey = (encryptedKey: string): Keypair => {
    const decryptedKey = decrypt(encryptedKey);
    const secretKey = Buffer.from(decryptedKey, 'base64');
    return Keypair.fromSecretKey(secretKey);
  };
  
  export const airdropSol = async (publicKey: PublicKey, amount: number): Promise<void> => {
    try {
      const signature = await connection.requestAirdrop(publicKey, amount * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature);
      logger.info(`Airdropped ${amount} SOL to ${publicKey.toBase58()}`);
    } catch (error) {
      logger.error(`Airdrop failed: ${(error as Error).message}`);
      throw error;
    }
  };
  
  export const sendTransaction = async (from: Keypair, to: PublicKey, amount: number): Promise<void> => {
    try {
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: to,
          lamports: amount * LAMPORTS_PER_SOL,
        })
      );
  
      const signature = await connection.sendTransaction(transaction, [from]);
      await connection.confirmTransaction(signature);
      logger.info(`Sent ${amount} SOL from ${from.publicKey.toBase58()} to ${to.toBase58()}`);
    } catch (error) {
      logger.error(`Transaction failed: ${(error as Error).message}`);
      throw error;
    }
  };
  