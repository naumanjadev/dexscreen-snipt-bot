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
  handleSetBuyAmountCommand,
  handleSmartListenerCommand,
  handleStopSmartListenerCommand,
  handleSmartListenerSettingsCommand,
  handleViewAnalyticsCommand,
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
 * @returns The message ID if successful, undefined otherwise.
 */
export const notifyUserById = async (userId: number, message: string): Promise<number | undefined> => {
  const MAX_RETRIES = 3;
  let retryCount = 0;
  
  while (retryCount < MAX_RETRIES) {
    try {
      const sentMessage = await botInstance.api.sendMessage(userId, message, { parse_mode: 'HTML' });
      return sentMessage.message_id; // Return the message ID
    } catch (error: any) {
      retryCount++;
      
      // Check if it's a network error
      const isNetworkError = error.message && 
        (error.message.includes('Network request') || 
         error.message.includes('ETIMEDOUT') ||
         error.message.includes('ECONNRESET') ||
         error.message.includes('socket hang up'));
      
      if (isNetworkError && retryCount < MAX_RETRIES) {
        // For network errors, wait and retry
        logger.warn(`Network error sending message to user ${userId}, retry ${retryCount}/${MAX_RETRIES}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
        continue;
      }
      
      // If we've reached max retries or it's not a network error, log and return
      if (retryCount === MAX_RETRIES) {
        logger.error(`Failed to send message after ${MAX_RETRIES} attempts to user ${userId}: ${error.message}`);
      } else {
        logger.error(`Error sending message to user ${userId}: ${error.message}`);
      }
      
      return undefined;
    }
  }
  
  return undefined;
};

/**
 * Deletes a message by its ID for a specific user.
 * @param userId - The Telegram user ID.
 * @param messageId - The ID of the message to delete.
 */
export const deleteMessageById = async (userId: number, messageId: number): Promise<void> => {
  try {
    await botInstance.api.deleteMessage(userId, messageId);
  } catch (error: any) {
    // Check if the error is because the message was not found
    if (error.message && (
        error.message.includes('message to delete not found') || 
        error.message.includes('Bad Request') ||
        error.message.includes('message can\'t be deleted')
    )) {
      // Message already deleted or expired, just log at debug level
      logger.debug(`Message ${messageId} for user ${userId} already deleted or expired.`);
    } else {
      // For other types of errors, log as error
      logger.error(`Error deleting message ${messageId} for user ${userId}: ${error.message}`);
    }
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
  bot.use(
    session({
      initial: (): MySession => ({
        awaitingInputFor: undefined,
        awaitingConfirmation: undefined,
        withdrawAddress: undefined,
        withdrawAmount: undefined,
      }),
    })
  );

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
/set_buy_amount - Set your buy amount filter
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/smart_listener - Start smart token detection and price monitoring
/stop_smart_listener - Stop smart token detection and price monitoring
/smart_settings - Customize smart listener behavior
/view_analytics - View detailed token analytics
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
/set_buy_amount - Set your buy amount filter
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/smart_listener - Start smart token detection and price monitoring
/stop_smart_listener - Stop smart token detection and price monitoring
/smart_settings - Customize smart listener behavior
/view_analytics - View detailed token analytics
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
  bot.command('set_buy_amount', handleSetBuyAmountCommand);
  bot.command('show_filters', handleShowFiltersCommand);

  // Listener commands
  bot.command('start_listener', handleStartListenerCommand);
  bot.command('stop_listener', handleStopListenerCommand);
  bot.command('smart_listener', handleSmartListenerCommand);
  bot.command('stop_smart_listener', handleStopSmartListenerCommand);
  bot.command('smart_settings', handleSmartListenerSettingsCommand);
  bot.command('view_analytics', handleViewAnalyticsCommand);

  // Handle text input for setting boost amount, buy amount, and confirmations
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
      } else if (awaitingInputFor === 'set_buy_amount') {
        await handleSetBuyAmountCommand(ctx);
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
