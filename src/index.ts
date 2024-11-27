// src/index.ts
import { config } from './config/index';
import { logger } from "./utils/logger";
import { connectDB } from './utils/connection';
import { initializeConnection } from './services/solanaService';
import { createBot } from './bots/telegramBot';

async function initiateTradingBot() {

  // Initialize Solana connection
  initializeConnection();

  // Initialize Database connection
  await connectDB();

  // Create and launch the bot
  const bot = createBot();

  await bot.api.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'wallet', description: 'Manage your Solana wallet' },
    { command: 'delete_wallet', description: 'Delete your Solana wallet' },
    { command: 'detect_tokens', description: 'Start detecting new token issuances' },
    { command: 'help', description: 'Show available commands' },
  ]).then(() => console.log('✅🔔 Commands are set successfully ✅🔔'));

  await bot.start();
  logger.info('🤖 Bot is up and running');
}

void initiateTradingBot();
