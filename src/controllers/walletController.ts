// src/controllers/walletController.ts
import { Keypair } from '@solana/web3.js';
import { encrypt, decrypt } from '../utils/encryption';
import { createWallet, getEncryptedPrivateKey, saveEncryptedPrivateKey, loadWalletFromEncryptedKey } from '../services/solanaService';
import { logger } from '../utils/logger';
import { config } from '../config';

export const handleCreateWallet = (): { publicKey: string; encryptedPrivateKey: string } => {
  const wallet: Keypair = createWallet();
  const encryptedKey: string = getEncryptedPrivateKey(wallet);
  saveEncryptedPrivateKey(encryptedKey);
  return {
    publicKey: wallet.publicKey.toBase58(),
    encryptedPrivateKey: encryptedKey,
  };
};
