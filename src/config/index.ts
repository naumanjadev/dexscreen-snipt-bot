// src/config/index.ts
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  encryptedPrivateKey: process.env.ENCRYPTED_PRIVATE_KEY || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  DATABASE: process.env.DATABASE || '',
  DB_NAME: process.env.DB_NAME || '',
};
