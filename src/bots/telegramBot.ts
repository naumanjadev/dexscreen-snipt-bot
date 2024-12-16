// src/bots/telegramBot.ts

import { Bot, session } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { MyContext, SessionData } from '../types';

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
  handleSetBoostAmountCommand,
  handleShowFiltersCommand,
  handleStartListenerCommand,
  handleStopListenerCommand,
} from '../controllers/filterController';

import { PublicKey } from '@solana/web3.js';

// Define the session data structure
type MySession = SessionData;

/**
 * Sends a notification to the current user.
 * @param ctx - The context from which to derive the chat ID.
 * @param message - The message to send to the user.
 */
export const notifyUser = async (ctx: MyContext, message: string): Promise<void> => {
  if (!ctx.chat || !ctx.chat.id) {
    logger.warn(`No chat id found for user ${ctx.from?.id}, cannot send notification.`);
    return;
  }
  try {
    await ctx.api.sendMessage(ctx.chat.id, message);
  } catch (error) {
    logger.error(`Error sending notification to user ${ctx.from?.id}:`, error);
  }
};

/**
 * Sends a notification to a user by their userId.
 * @param userId - The Telegram user ID.
 * @param message - The message to send.
 */
export const notifyUserById = async (userId: number, message: string): Promise<void> => {
  try {
    await botInstance.api.sendMessage(userId, message, { parse_mode: 'HTML' });
  } catch (error) {
    logger.error(`Error sending message to user ${userId}:`, error);
  }
};

/**
 * Creates and configures the Telegram bot.
 * @returns An instance of the configured bot.
 */
export const createBot = (): Bot<MyContext> => {
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
  }

  const bot = new Bot<MyContext>(config.telegramBotToken);

  // Initialize session middleware
  bot.use(session({ initial: (): MySession => ({}) }));

  // Middleware to reset session data when a new command is received
  bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
      ctx.session.awaitingInputFor = undefined;
      // Keep awaitingConfirmation if it's for delete or export wallet or withdrawal confirmation
      const currentCommand = ctx.message.text.split(' ')[0];
      const confirmationCommands = ['/cancel', '/confirm_withdraw'];
      if (!confirmationCommands.includes(currentCommand)) {
        ctx.session.awaitingConfirmation = undefined;
      }
      ctx.session.withdrawAddress = undefined;
      ctx.session.withdrawAmount = undefined;
    }
    await next();
  });

  // /start command handler
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
👋 <b>Welcome to the Solana Trading Bot!</b>

Please choose an option:
/wallet - Manage your Solana wallet
/set_boost_amount - Set your boost amount filter
/show_filters - Show current boost amount
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
/set_boost_amount - Set your boost amount filter
/show_filters - Show current boost amount
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
  bot.command('withdraw', handleWithdrawCommand);
  bot.command('cancel', handleCancel);
  bot.command('main_menu', handleMainMenuCommand);

  // Filter commands
  bot.command('set_boost_amount', handleSetBoostAmountCommand);
  bot.command('show_filters', handleShowFiltersCommand);

  // Listener commands
  bot.command('start_listener', handleStartListenerCommand);
  bot.command('stop_listener', handleStopListenerCommand);

  // Handle text input for setting boost amount and confirmations
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      // It's a command, do nothing here
      return;
    }

    const { awaitingInputFor, awaitingConfirmation } = ctx.session;

    if (awaitingInputFor || awaitingConfirmation) {
      if (awaitingInputFor === 'set_boost_amount') {
        await handleSetBoostAmountCommand(ctx);
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
        const input = ctx.message.text.trim().toLowerCase();
        if (input === 'yes') {
          await handleConfirmWithdraw(ctx);
        } else {
          await ctx.reply('Withdrawal cancelled.');
          ctx.session.awaitingConfirmation = undefined;
        }
      } else if (awaitingConfirmation === 'delete_wallet') {
        // Handle delete wallet confirmation
        await handleDeleteWalletCommand(ctx);
      } else if (awaitingConfirmation === 'export_wallet') {
        // Handle export wallet confirmation
        await handleExportWalletCommand(ctx);
      } else {
        // No specific handler, reset session data
        ctx.session.awaitingInputFor = undefined;
        ctx.session.awaitingConfirmation = undefined;
        await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
      }
    } else {
      // No awaiting input or confirmation, inform the user
      await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
    }
  });

  // Handle unknown commands and non-command messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      // Unknown command
      await ctx.reply('❌ Unknown command. Type /help to see the list of available commands.');
    } else {
      // Non-command messages
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

export const botInstance = createBot();
