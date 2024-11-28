import { Bot, session } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  handleWalletCommand,
  handleDeleteWalletCommand,
  handleMainMenuCommand,
  handleExportWalletCommand,
  handleWithdrawCommand,
  handleConfirmWithdraw,
  handleCancel,
  handleWithdrawAmountInput,
} from '../controllers/walletController';
import {
  handleSetLiquidityCommand,
  handleSetMintAuthorityCommand,
  handleSetTopHoldersCommand,
  handleStartListenerCommand,
  handleStopListenerCommand,
  handleShowFiltersCommand,
} from '../controllers/filterController';
import { PublicKey } from '@solana/web3.js';
import { MyContext, SessionData } from '../types';

// Initialize session data
type MySession = SessionData;

export const createBot = (): Bot<MyContext> => {
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
  }

  const bot = new Bot<MyContext>(config.telegramBotToken);

  // Initialize session middleware
  bot.use(session({ initial: (): MySession => ({}) }));

  // /start command handler
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
👋 <b>Welcome to the Solana Trading Bot!</b>

Please choose an option:
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/help - Show available commands
    `;
    await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
    logger.info(`User ${ctx.from?.id} started the bot.`);
  });

  // /help command handler
  bot.command('help', async (ctx) => {
    const helpMessage = `
❓ <b>Available Commands</b>
/start - Start the bot and see options
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/delete_wallet - Delete your Solana wallet
/main_menu - Go back to the main menu
    `;
    await ctx.reply(helpMessage, { parse_mode: 'HTML' });
  });

  // Wallet commands
  bot.command('wallet', handleWalletCommand);
  bot.command('delete_wallet', handleDeleteWalletCommand);
  bot.command('export_wallet', handleExportWalletCommand);
  bot.command('confirm_export', handleExportWalletCommand);
  bot.command('withdraw', handleWithdrawCommand);
  bot.command('confirm_withdraw', handleConfirmWithdraw);
  bot.command('cancel', handleCancel);
  bot.command('main_menu', handleMainMenuCommand);

  // Filter commands with aliases
  bot.command(['set_filters', 'setfilters'], async (ctx) => {
    const message = `
🔧 <b>Set Token Filters</b>

Please choose a filter to set:
/set_liquidity - Set liquidity threshold
/set_mint_authority - Set mint authority requirement
/set_top_holders - Set top holders concentration threshold
    `;
    await ctx.reply(message, { parse_mode: 'HTML' });
  });

  bot.command(['set_liquidity', 'setliquidity'], handleSetLiquidityCommand);
  bot.command(['set_mint_authority', 'setmintauthority'], handleSetMintAuthorityCommand);
  bot.command(['set_top_holders', 'settopholders'], handleSetTopHoldersCommand);
  bot.command(['show_filters', 'showfilters'], handleShowFiltersCommand);

  // Listener commands with aliases
  bot.command(['start_listener', 'startlistener'], handleStartListenerCommand);
  bot.command(['stop_listener', 'stoplistener'], handleStopListenerCommand);

  // Handle text input for setting filters and withdrawals
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      // It's a command, skip processing as input
      await next();
      return;
    }

    const { awaitingInputFor, awaitingConfirmation } = ctx.session;

    if (awaitingInputFor === 'set_liquidity') {
      await handleSetLiquidityCommand(ctx);
    } else if (awaitingInputFor === 'set_mint_authority') {
      await handleSetMintAuthorityCommand(ctx);
    } else if (awaitingInputFor === 'set_top_holders') {
      await handleSetTopHoldersCommand(ctx);
    } else if (awaitingInputFor === 'withdraw_address') {
      const input = ctx.message.text.trim();
      // Validate Solana address
      try {
        new PublicKey(input);
        ctx.session.withdrawAddress = input;
        ctx.session.awaitingInputFor = 'withdraw_amount';
        await ctx.reply('💰 Please enter the amount of SOL you want to withdraw:');
      } catch (error) {
        await ctx.reply('❌ Invalid Solana address. Please enter a valid Solana wallet address:');
      }
    } else if (awaitingInputFor === 'withdraw_amount') {
      await handleWithdrawAmountInput(ctx);
    } else if (awaitingConfirmation === 'withdraw') {
      // Waiting for user to confirm withdrawal
      if (ctx.message.text.trim().toLowerCase() === '/confirm_withdraw') {
        await handleConfirmWithdraw(ctx);
      } else {
        await ctx.reply('Please type /confirm_withdraw to proceed or /cancel to abort.');
      }
    } else {
      await next();
    }
  });

  // Handle unknown commands
  bot.on('message', async (ctx, next) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      // It's a command, let the command handlers process it
      await next();
    } else {
      // Handle non-command messages
      await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
    }
  });

  // Error handling
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error(`Error while handling update ${ctx.update.update_id}: ${(err.error as Error).message}`);
  });

  return bot;
};
