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

/**
 * Initializes the connection to the Solana RPC.
 */
export const initializeConnection = (): void => {
  connection = new Connection(config.solanaRpcUrl, 'confirmed');
  logger.info(`Connected to Solana RPC at ${config.solanaRpcUrl}`);
};

/**
 * Creates a new Solana wallet.
 * @returns A new Keypair representing the wallet.
 */
export const createWallet = (): Keypair => {
  const wallet = Keypair.generate();
  logger.info(`New wallet created: ${wallet.publicKey.toBase58()}`);
  return wallet;
};

/**
 * Encrypts the private key of a wallet.
 * @param wallet - The Keypair of the wallet.
 * @returns The encrypted private key as a string.
 */
export const getEncryptedPrivateKey = (wallet: Keypair): string => {
  const secretKeyString = Buffer.from(wallet.secretKey).toString('base64');
  const encryptedKey = encrypt(secretKeyString);
  return encryptedKey;
};

/**
 * Saves the encrypted private key securely.
 * @param encryptedKey - The encrypted private key.
 */
export const saveEncryptedPrivateKey = (encryptedKey: string): void => {
  // In a real-world scenario, save this to a secure storage or file
  // For this example, we'll just log it (ensure you handle this securely)
  logger.info(`Encrypted Private Key: ${encryptedKey}`);
};

/**
 * Loads a wallet from an encrypted private key.
 * @param encryptedKey - The encrypted private key.
 * @returns The Keypair representing the wallet.
 */
export const loadWalletFromEncryptedKey = (encryptedKey: string): Keypair => {
  const decryptedKey = decrypt(encryptedKey);
  const secretKey = Buffer.from(decryptedKey, 'base64');
  return Keypair.fromSecretKey(secretKey);
};

/**
 * Requests an airdrop of SOL to a specified public key.
 * @param publicKey - The public key to receive the airdrop.
 * @param amount - The amount of SOL to airdrop.
 */
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

/**
 * Sends a transaction transferring SOL from one wallet to another.
 * @param from - The Keypair of the sender.
 * @param to - The public key of the recipient.
 * @param amount - The amount of SOL to send.
 */
export const sendTransaction = async (
  from: Keypair,
  to: PublicKey,
  amount: number
): Promise<void> => {
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
