import { config } from './config/index';
import { logger } from './utils/logger';
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

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'wallet', description: 'Manage your Solana wallet' },
      { command: 'start_listener', description: 'Start detecting new token issuances' },
      { command: 'stop_listener', description: 'Stop detecting new token issuances' },
      { command: 'set_boost_amount', description: 'Set your boost amount filter' },
      { command: 'set_buy_amount', description: 'Set your buy amount filter' },
      { command: 'show_filters', description: 'Show current boost amount filter' },
      { command: 'help', description: 'Show available commands' },
    ])
    .then(() => console.log('✅🔔 Commands are set successfully ✅🔔'));

  await bot.start();
  logger.info('🤖 Bot is up and running');
}

void initiateTradingBot();
