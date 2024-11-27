// src/bots/telegramBot.ts
import { Bot, Context, session, SessionFlavor } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  handleWalletCommand,
  handleDeleteWalletCommand,
  handleMainMenuCommand,
} from '../controllers/walletController';
import {
  handleSetLiquidityCommand,
  handleSetMintAuthorityCommand,
  handleSetTopHoldersCommand,
  handleStartListenerCommand,
  handleStopListenerCommand,
  handleShowFiltersCommand,
} from '../controllers/filterController';

// Define session data (if needed)
interface SessionData {
  // For conversation flows
  awaitingInputFor?: string;
}

type MyContext = Context & SessionFlavor<SessionData>;

export const createBot = (): Bot<MyContext> => {
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
  }

  const bot = new Bot<MyContext>(config.telegramBotToken);

  // Initialize session middleware
  bot.use(session({ initial: () => ({}) }));

  // /start command handler
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
Welcome to the Solana Trading Bot!

Please choose an option:
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/help - Show available commands
    `;
    await ctx.reply(welcomeMessage);
    logger.info(`User ${ctx.from?.id} started the bot.`);
  });

  // /help command handler
  bot.command('help', async (ctx) => {
    const helpMessage = `
Available Commands:
/start - Start the bot and see options
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/delete_wallet - Delete your Solana wallet
/main_menu - Go back to the main menu
    `;
    await ctx.reply(helpMessage);
  });

  // Wallet commands
  bot.command('wallet', handleWalletCommand);
  bot.command('delete_wallet', handleDeleteWalletCommand);
  bot.command('main_menu', handleMainMenuCommand);

  // Filter commands
  bot.command('set_filters', async (ctx) => {
    const message = `
Please choose a filter to set:
/set_liquidity - Set liquidity threshold
/set_mint_authority - Set mint authority requirement
/set_top_holders - Set top holders concentration threshold
    `;
    await ctx.reply(message);
  });

  bot.command('set_liquidity', handleSetLiquidityCommand);
  bot.command('set_mint_authority', handleSetMintAuthorityCommand);
  bot.command('set_top_holders', handleSetTopHoldersCommand);
  bot.command('show_filters', handleShowFiltersCommand);

  // Listener commands
  bot.command('start_listener', handleStartListenerCommand);
  bot.command('stop_listener', handleStopListenerCommand);

  // Handle text input for setting filters
  bot.on('message:text', async (ctx, next) => {
    const { awaitingInputFor } = ctx.session;

    if (awaitingInputFor === 'set_liquidity') {
      await handleSetLiquidityCommand(ctx);
    } else if (awaitingInputFor === 'set_mint_authority') {
      await handleSetMintAuthorityCommand(ctx);
    } else if (awaitingInputFor === 'set_top_holders') {
      await handleSetTopHoldersCommand(ctx);
    } else {
      await next();
    }
  });

  // Handle unknown commands
  bot.on('message', async (ctx) => {
    const text = ctx.message.text;
    if (text && !text.startsWith('/')) {
      await ctx.reply('Please use the available commands. Type /help to see the list of commands.');
    } else {
      await ctx.reply('Unknown command. Type /help to see the list of commands.');
    }
  });

  // Error handling
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error(`Error while handling update ${ctx.update.update_id}: ${(err.error as Error).message}`);
  });

  return bot;
};
