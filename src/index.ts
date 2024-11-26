// src/index.ts
import dotenv from 'dotenv';
dotenv.config();

import { createBot } from './bots/telegramBot';
import { initializeSolanaListener } from './controllers/tokenDetectionController';
import { logger } from './utils/logger';
import { initializeConnection } from './services/solanaService';

// Initialize Solana connection
initializeConnection();

// Initialize Telegram Bot
const bot = createBot();

// Start the bot
bot.start();
logger.info('Telegram bot started.');

// Handle unhandled promise rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  process.exit(1);
});
