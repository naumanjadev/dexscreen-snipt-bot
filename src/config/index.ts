// src/config.ts
import dotenv from 'dotenv';

dotenv.config();

interface Config {
  telegramBotToken: string;
  solanaRpcUrl: string;
  encryptedPrivateKey: string;
  encryptionKey: string;
  logLevel: string;
  DATABASE: string;
  DB_NAME: string;
  redisUrl: string; // Add redisUrl to the Config interface
}

export const config: Config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  encryptedPrivateKey: process.env.ENCRYPTED_PRIVATE_KEY || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  DATABASE: process.env.DATABASE || 'mongodb',
  DB_NAME: process.env.DB_NAME || 'sol-snip-bot',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379', // Add redisUrl with a default value
};
