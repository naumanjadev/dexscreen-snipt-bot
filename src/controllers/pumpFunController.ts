import { MyContext } from '../types';
import { logger } from '../utils/logger';
import { PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getUserWallet, loadUserKeypair } from '../services/walletService';
import {
  startPumpFunListener,
  stopPumpFunListener,
  startPumpFunTrading,
  getPumpFunSettings,
  updatePumpFunSettings,
  isPumpFunListenerActive,
  getPumpFunListenerStatus,
  getPumpFunTradingHistory,
  PumpFunSettings
} from '../services/pumpFunService';
import { config } from '../config';
import WebSocket from 'ws';
import dns from 'dns';
import fetch from 'node-fetch';
import axios from 'axios';
import https from 'https';
// @ts-ignore - Handle missing ping module
import ping from 'ping';
import { notifyUserById } from '../bots/telegramBot';
import { promisify } from 'util';

// Promisify dns.lookup for easier usage
const dnsLookup = promisify(dns.lookup);

// Add missing activeListeners map
const activeListeners = new Map<number, any>();

/**
 * Handle starting the Pump.fun listener
 */
export const handleStartPumpFunListener = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if user has a wallet
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      await ctx.reply('❌ You need to set up a wallet first. Use /wallet to create one.');
      return;
    }

    // If we're waiting for input, process it
    if (ctx.session.awaitingInputFor === 'pumpfun_name_filter' && ctx.message && ctx.message.text) {
      const nameFilter = ctx.message.text.trim();
      if (nameFilter.toLowerCase() === 'none' || nameFilter.toLowerCase() === 'clear') {
        // Clear the name filter
        await updatePumpFunSettings(userId, { onlyBuyTokensWithName: null });
        await ctx.reply('✅ Name filter cleared. The bot will consider all tokens.');
      } else {
        // Set the name filter
        await updatePumpFunSettings(userId, { onlyBuyTokensWithName: nameFilter });
        await ctx.reply(`✅ Name filter set to "${nameFilter}". The bot will only consider tokens with this string in the name or symbol.`);
      }
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    // If user already has an active listener, inform them
    if (isPumpFunListenerActive(userId)) {
      await ctx.reply(
        '❓ PumpPortal listener is already active. What would you like to do?\n\n' +
        '/pumpfun_settings - View and update settings\n' +
        '/pumpfun_status - Check current status\n' +
        '/stop_pumpfun - Stop the listener\n' +
        '/start_pumpfun_trading - Start automatic trading'
      );
      return;
    }

    // Enhanced checking of wallet validity
    try {
      const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
      if (!keypair) {
        await ctx.reply('❌ Could not load your wallet. Please try setting up your wallet again with /wallet.');
        return;
      }
    } catch (error: any) {
      logger.error(`Error loading keypair for user ${userId}: ${error.message}`);
      await ctx.reply('❌ There was an issue with your wallet. Please try setting up your wallet again with /wallet.');
      return;
    }

    // Show waiting message with diagnostic information
    await ctx.reply('⏳ Connecting to PumpPortal service. This may take a moment...\n\nPerforming network diagnostics and setting up secure connection to servers.');

    try {
      // Start the listener with default settings - show a second message with progress
      await ctx.reply('🔍 Verifying connectivity to PumpPortal...');
      await startPumpFunListener(userId);
      
      // Reply with success message and settings options
      await ctx.reply(
        '✅ PumpPortal listener started successfully! You will be notified about new tokens.\n\n' +
        'Use these commands to customize:\n' +
        '/pumpfun_settings - View and update settings\n' +
        '/pumpfun_token_filter - Set name/symbol filter\n' +
        '/start_pumpfun_trading - Start automatic trading\n' +
        '/stop_pumpfun - Stop the listener'
      );
      
      logger.info(`User ${userId} started the PumpPortal listener.`);
    } catch (error: any) {
      // Check if it's a DNS resolution error
      if (error.message && (
          error.message.includes('getaddrinfo') || 
          error.message.includes('ENOTFOUND') || 
          error.message.includes('connect') ||
          error.message.includes('Cannot connect to PumpPortal service')
      )) {
        logger.error(`DNS or connection error for PumpPortal: ${error.message}`);
        await ctx.reply(
          `⚠️ Unable to connect to PumpPortal services. Network diagnostic shows: ${error.message}\n\n` +
          'This may be due to:\n\n' +
          '1. Your server\'s network configuration - check outbound firewall rules\n' +
          '2. EC2 security group settings - ensure port 443 is allowed for outbound traffic\n' +
          '3. DNS resolution problems - update your DNS server settings\n' +
          '4. The PumpPortal service might be temporarily unavailable\n\n' +
          'Suggested fixes:\n' +
          '• Check EC2 security group to allow outbound traffic on port 443\n' +
          '• Configure a reliable DNS server like Google (8.8.8.8) or Cloudflare (1.1.1.1)\n' +
          '• Try again later when the service may be available again'
        );
      } else if (error.message && error.message.includes('wallet')) {
        // Wallet-related errors
        logger.error(`Wallet error when starting PumpPortal listener: ${error.message}`);
        await ctx.reply(`❌ ${error.message}\n\nPlease use /wallet to verify your wallet is set up correctly.`);
      } else {
        // Other errors
        logger.error(`Error starting PumpPortal listener: ${error.message}`, error);
        await ctx.reply(
          `❌ Failed to start PumpPortal listener: ${error.message}\n\n` +
          'Please try again later or contact support if the issue persists.'
        );
      }
    }
  } catch (error: any) {
    logger.error(`Unexpected error in handleStartPumpFunListener: ${error.message}`, error);
    await ctx.reply(`❌ An unexpected error occurred: ${error.message}\n\nPlease try again later or contact support if the issue persists.`);
  }
};

/**
 * Handle stopping the Pump.fun listener
 */
export const handleStopPumpFunListener = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if the listener is active
    if (!isPumpFunListenerActive(userId)) {
      await ctx.reply('❌ PumpPortal listener is not active.');
      return;
    }

    // Stop the listener
    stopPumpFunListener(userId);
    
    await ctx.reply('✅ PumpPortal listener stopped.');
    logger.info(`User ${userId} stopped the PumpPortal listener.`);
  } catch (error: any) {
    logger.error(`Error stopping PumpPortal listener: ${error.message}`, error);
    await ctx.reply(`❌ Failed to stop PumpPortal listener: ${error.message}`);
  }
};

/**
 * Handle starting automatic Pump.fun trading
 */
export const handleStartPumpFunTrading = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if user has a wallet
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      await ctx.reply('❌ You need to set up a wallet first. Use /wallet to create one.');
      return;
    }

    // Check if the listener is active
    if (!isPumpFunListenerActive(userId)) {
      await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
      return;
    }

    // Get current status
    const status = getPumpFunListenerStatus(userId);
    if (status === 'trading') {
      await ctx.reply('ℹ️ PumpPortal trading is already active.');
      return;
    }

    // Show waiting message
    await ctx.reply('⏳ Verifying your wallet balance and preparing for trading...');

    try {
      // Start trading
      await startPumpFunTrading(userId);
      
      // Get current settings
      const settings = getPumpFunSettings(userId);
      
      // Reply with success message
      await ctx.reply(
        '✅ PumpPortal trading started! The bot will automatically buy tokens based on your settings.\n\n' +
        `Current settings:\n` +
        `- Minimum boost amount: $${settings?.minBoostAmount}\n` +
        `- Buy amount: ${settings?.buyAmount} SOL\n` +
        `- Trading budget: ${settings?.tradingBudget} SOL\n` +
        `- Auto-sell: ${settings?.autoSell ? 'Enabled' : 'Disabled'}\n` +
        `- Profit target: ${settings?.profitTarget}%\n` +
        `- Stop loss: ${settings?.stopLoss}%\n` +
        `- Max hold time: ${Math.floor((settings?.maxHoldTime || 0) / 60)} minutes\n` +
        (settings?.onlyBuyTokensWithName ? `- Name filter: "${settings.onlyBuyTokensWithName}"\n` : '') +
        '\n✨ Auto-optimization is enabled and will adjust your settings after 5+ trades for maximum performance.\n\n' +
        'Use /pumpfun_settings to update these settings and /pumpfun_status to check performance metrics.'
      );
      
      logger.info(`User ${userId} started automatic PumpPortal trading.`);
    } catch (error: any) {
      // Check if it's a funds-related error
      if (error.message && error.message.includes('funds')) {
        await ctx.reply(`❌ ${error.message}\n\nPlease add more SOL to your wallet and try again.`);
      } else {
        logger.error(`Error starting PumpPortal trading: ${error.message}`, error);
        await ctx.reply(`❌ Failed to start PumpPortal trading: ${error.message}`);
      }
    }
  } catch (error: any) {
    logger.error(`Unexpected error in handleStartPumpFunTrading: ${error.message}`, error);
    await ctx.reply(`❌ An unexpected error occurred: ${error.message}\n\nPlease try again later or contact support if the issue persists.`);
  }
};

/**
 * Handle viewing and updating Pump.fun settings
 */
export const handlePumpFunSettings = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if the listener is active
    if (!isPumpFunListenerActive(userId)) {
      await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
      return;
    }

    // If we're waiting for input, process it
    if (ctx.session.awaitingInputFor && ctx.message && ctx.message.text) {
      const input = ctx.message.text.trim();
      
      switch (ctx.session.awaitingInputFor) {
        case 'pumpfun_min_boost':
          const minBoost = parseFloat(input);
          if (isNaN(minBoost) || minBoost < 0) {
            await ctx.reply('❌ Invalid input. Please enter a valid number greater than 0:');
            return;
          }
          await updatePumpFunSettings(userId, { minBoostAmount: minBoost });
          await ctx.reply(`✅ Minimum boost amount set to $${minBoost}`);
          break;
          
        case 'pumpfun_buy_amount':
          const buyAmount = parseFloat(input);
          if (isNaN(buyAmount) || buyAmount <= 0) {
            await ctx.reply('❌ Invalid input. Please enter a valid number greater than 0:');
            return;
          }
          await updatePumpFunSettings(userId, { buyAmount });
          await ctx.reply(`✅ Buy amount set to ${buyAmount} SOL`);
          break;
          
        case 'pumpfun_profit_target':
          const profitTarget = parseFloat(input);
          if (isNaN(profitTarget) || profitTarget <= 0) {
            await ctx.reply('❌ Invalid input. Please enter a valid percentage greater than 0:');
            return;
          }
          await updatePumpFunSettings(userId, { profitTarget });
          await ctx.reply(`✅ Profit target set to ${profitTarget}%`);
          break;
          
        case 'pumpfun_stop_loss':
          const stopLoss = parseFloat(input);
          if (isNaN(stopLoss) || stopLoss <= 0) {
            await ctx.reply('❌ Invalid input. Please enter a valid percentage greater than 0:');
            return;
          }
          await updatePumpFunSettings(userId, { stopLoss });
          await ctx.reply(`✅ Stop loss set to ${stopLoss}%`);
          break;
          
        case 'pumpfun_max_hold_time':
          const maxHoldMinutes = parseFloat(input);
          if (isNaN(maxHoldMinutes) || maxHoldMinutes <= 0) {
            await ctx.reply('❌ Invalid input. Please enter a valid number of minutes greater than 0:');
            return;
          }
          await updatePumpFunSettings(userId, { maxHoldTime: maxHoldMinutes * 60 }); // Convert to seconds
          await ctx.reply(`✅ Maximum hold time set to ${maxHoldMinutes} minutes`);
          break;
          
        case 'pumpfun_auto_sell':
          const autoSell = input.toLowerCase() === 'yes' || input.toLowerCase() === 'true' || input.toLowerCase() === 'enable';
          await updatePumpFunSettings(userId, { autoSell });
          await ctx.reply(`✅ Auto-sell ${autoSell ? 'enabled' : 'disabled'}`);
          break;
          
        case 'pumpfun_slippage':
          const slippage = parseFloat(input);
          if (isNaN(slippage) || slippage <= 0 || slippage > 100) {
            await ctx.reply('❌ Invalid input. Please enter a valid percentage between 0.1 and 100:');
            return;
          }
          await updatePumpFunSettings(userId, { slippage });
          await ctx.reply(`✅ Slippage tolerance set to ${slippage}%`);
          break;
          
        case 'pumpfun_priority_fee':
          const priorityFee = input.toLowerCase() === 'yes' || input.toLowerCase() === 'true' || input.toLowerCase() === 'enable';
          await updatePumpFunSettings(userId, { priorityFee });
          await ctx.reply(`✅ Priority fees ${priorityFee ? 'enabled' : 'disabled'}`);
          break;
      }
      
      ctx.session.awaitingInputFor = undefined;
      
      // Show the settings menu again
      await showSettingsMenu(ctx);
      return;
    }

    // Show the settings menu
    await showSettingsMenu(ctx);
  } catch (error: any) {
    logger.error(`Error handling PumpPortal settings: ${error.message}`, error);
    await ctx.reply(`❌ Failed to handle settings: ${error.message}`);
  }
};

/**
 * Handle setting a name/symbol filter for Pump.fun tokens
 */
export const handlePumpFunTokenFilter = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if the listener is active
    if (!isPumpFunListenerActive(userId)) {
      await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
      return;
    }

    // Get current settings
    const settings = getPumpFunSettings(userId);
    
    // Ask for the name filter
    ctx.session.awaitingInputFor = 'pumpfun_name_filter';
    await ctx.reply(
      `🔍 Enter a name or symbol substring to filter tokens (current: ${settings?.onlyBuyTokensWithName || 'none'}):\n\n` +
      'Type "none" or "clear" to remove the filter.'
    );
  } catch (error: any) {
    logger.error(`Error handling PumpPortal token filter: ${error.message}`, error);
    await ctx.reply(`❌ Failed to handle token filter: ${error.message}`);
  }
};

/**
 * Handle checking the status of the Pump.fun listener and trading
 */
export const handlePumpFunStatus = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Check if the listener is active
    if (!isPumpFunListenerActive(userId)) {
      await ctx.reply('ℹ️ PumpPortal listener is not active. Use /start_pumpfun to start it.');
      return;
    }

    // Get current status and settings
    const status = getPumpFunListenerStatus(userId);
    const settings = getPumpFunSettings(userId);
    const history = getPumpFunTradingHistory(userId);
    
    // Get wallet balance
    let walletBalanceMessage = '';
    try {
      const userWallet = await getUserWallet(userId);
      if (userWallet) {
        const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
        const connection = new Connection(config.solanaRpcUrl, 'confirmed');
        const balance = await connection.getBalance(keypair.publicKey);
        const balanceInSol = balance / LAMPORTS_PER_SOL;
        walletBalanceMessage = `\n<b>Wallet balance:</b> ${balanceInSol.toFixed(4)} SOL`;
      }
    } catch (error) {
      walletBalanceMessage = '\n<b>Wallet balance:</b> Unable to fetch';
    }
    
    // Calculate trading stats
    const buys = history?.filter(trade => trade.action === 'buy').length || 0;
    const sells = history?.filter(trade => trade.action === 'sell').length || 0;
    
    // Check connection status
    const connectionStatus = await getConnectionStatus(userId);
    
    // Calculate time since last message
    let lastMessageInfo = '';
    if (connectionStatus.lastMessageTime) {
      const minutesSinceLastMessage = (Date.now() - connectionStatus.lastMessageTime) / (1000 * 60);
      if (minutesSinceLastMessage < 60) {
        lastMessageInfo = `\n<b>Last activity:</b> ${Math.floor(minutesSinceLastMessage)} minutes ago`;
      } else {
        const hoursSinceLastMessage = minutesSinceLastMessage / 60;
        lastMessageInfo = `\n<b>Last activity:</b> ${hoursSinceLastMessage.toFixed(1)} hours ago`;
      }
    }
    
    // Create the status message
    let message = `📊 <b>PumpPortal Bot Status</b>\n\n`;
    message += `<b>Current state:</b> ${status === 'monitoring' ? '🔍 Monitoring only' : '🤖 Trading'}\n`;
    message += `<b>Connection status:</b> ${connectionStatus.status}${lastMessageInfo}${walletBalanceMessage}\n\n`;
    
    message += `<b>Settings:</b>\n`;
    message += `- Minimum boost: $${settings?.minBoostAmount}\n`;
    message += `- Buy amount: ${settings?.buyAmount} SOL\n`;
    message += `- Auto-sell: ${settings?.autoSell ? 'Enabled' : 'Disabled'}\n`;
    message += `- Profit target: ${settings?.profitTarget}%\n`;
    message += `- Stop loss: ${settings?.stopLoss}%\n`;
    message += `- Max hold time: ${Math.floor((settings?.maxHoldTime || 0) / 60)} minutes\n`;
    if (settings?.onlyBuyTokensWithName) {
      message += `- Name filter: "${settings.onlyBuyTokensWithName}"\n`;
    }
    
    message += `\n<b>Trading activity:</b>\n`;
    message += `- Total buys: ${buys}\n`;
    message += `- Total sells: ${sells}\n`;
    
    if (history && history.length > 0) {
      message += `\n<b>Recent trades:</b>\n`;
      
      // Show up to 5 most recent trades
      const recentTrades = history.slice(-5).reverse();
      for (const trade of recentTrades) {
        const date = new Date(trade.timestamp);
        message += `- ${trade.action === 'buy' ? '🟢 Bought' : '🔴 Sold'} ${trade.tokenSymbol} @ ${trade.price.toFixed(8)} SOL (${date.toLocaleString()})\n`;
      }
    }
    
    message += `\n<b>Commands:</b>\n`;
    message += `/pumpfun_settings - Update settings\n`;
    message += status === 'monitoring' ? `/start_pumpfun_trading - Start trading\n` : `/stop_pumpfun - Stop bot\n`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error: any) {
    logger.error(`Error checking PumpPortal status: ${error.message}`, error);
    await ctx.reply(`❌ Failed to check status: ${error.message}`);
  }
};

/**
 * Helper function to show the settings menu
 */
async function showSettingsMenu(ctx: MyContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  if (!settings) {
    await ctx.reply('❌ Settings not found. Please restart the PumpPortal listener.');
    return;
  }

  // Create the settings message
  const message = `⚙️ <b>PumpPortal Settings</b>\n\n` +
    `<b>Current settings:</b>\n` +
    `1️⃣ Minimum boost amount: $${settings.minBoostAmount}\n` +
    `2️⃣ Buy amount: ${settings.buyAmount} SOL\n` +
    `3️⃣ Auto-sell: ${settings.autoSell ? 'Enabled' : 'Disabled'}\n` +
    `4️⃣ Profit target: ${settings.profitTarget}%\n` +
    `5️⃣ Stop loss: ${settings.stopLoss}%\n` +
    `6️⃣ Max hold time: ${Math.floor(settings.maxHoldTime / 60)} minutes\n` +
    `7️⃣ Slippage tolerance: ${settings.slippage}%\n` +
    `8️⃣ Priority fees: ${settings.priorityFee ? 'Enabled' : 'Disabled'}\n` +
    (settings.onlyBuyTokensWithName ? `9️⃣ Name filter: "${settings.onlyBuyTokensWithName}"\n` : '') +
    `\n<b>Choose a setting to change:</b>\n` +
    `/pumpfun_min_boost - Set minimum boost amount\n` +
    `/pumpfun_buy_amount - Set buy amount\n` +
    `/pumpfun_auto_sell - Enable/disable auto-sell\n` +
    `/pumpfun_profit_target - Set profit target percentage\n` +
    `/pumpfun_stop_loss - Set stop loss percentage\n` +
    `/pumpfun_max_hold_time - Set maximum hold time\n` +
    `/pumpfun_slippage - Set slippage tolerance\n` +
    `/pumpfun_priority_fee - Enable/disable priority fees\n` +
    `/pumpfun_token_filter - Set name/symbol filter\n`;

  await ctx.reply(message, { parse_mode: 'HTML' });
}

/**
 * Handle setting minimum boost amount
 */
export const handlePumpFunMinBoost = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new minimum boost amount
  ctx.session.awaitingInputFor = 'pumpfun_min_boost';
  await ctx.reply(`💲 Enter the minimum boost amount in USD (current: $${settings?.minBoostAmount}):`);
};

/**
 * Handle setting buy amount
 */
export const handlePumpFunBuyAmount = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new buy amount
  ctx.session.awaitingInputFor = 'pumpfun_buy_amount';
  await ctx.reply(`💰 Enter the buy amount in SOL (current: ${settings?.buyAmount} SOL):`);
};

/**
 * Handle setting auto-sell
 */
export const handlePumpFunAutoSell = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new auto-sell setting
  ctx.session.awaitingInputFor = 'pumpfun_auto_sell';
  await ctx.reply(
    `🔄 Enable or disable auto-sell (current: ${settings?.autoSell ? 'Enabled' : 'Disabled'}):\n\n` +
    'Type "yes" to enable or "no" to disable'
  );
};

/**
 * Handle setting profit target
 */
export const handlePumpFunProfitTarget = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new profit target
  ctx.session.awaitingInputFor = 'pumpfun_profit_target';
  await ctx.reply(`📈 Enter the profit target percentage (current: ${settings?.profitTarget}%):`);
};

/**
 * Handle setting stop loss
 */
export const handlePumpFunStopLoss = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new stop loss
  ctx.session.awaitingInputFor = 'pumpfun_stop_loss';
  await ctx.reply(`📉 Enter the stop loss percentage (current: ${settings?.stopLoss}%):`);
};

/**
 * Handle setting maximum hold time
 */
export const handlePumpFunMaxHoldTime = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new maximum hold time
  ctx.session.awaitingInputFor = 'pumpfun_max_hold_time';
  await ctx.reply(`⏱️ Enter the maximum hold time in minutes (current: ${Math.floor((settings?.maxHoldTime || 0) / 60)} minutes):`);
};

/**
 * Handle setting slippage tolerance
 */
export const handlePumpFunSlippage = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new slippage
  ctx.session.awaitingInputFor = 'pumpfun_slippage';
  await ctx.reply(`🔄 Enter the slippage tolerance percentage (current: ${settings?.slippage}%):`);
};

/**
 * Handle setting priority fee
 */
export const handlePumpFunPriorityFee = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ User ID not found.');
    return;
  }

  // Check if the listener is active
  if (!isPumpFunListenerActive(userId)) {
    await ctx.reply('❌ You need to start the PumpPortal listener first. Use /start_pumpfun to do that.');
    return;
  }

  // Get current settings
  const settings = getPumpFunSettings(userId);
  
  // Ask for the new priority fee setting
  ctx.session.awaitingInputFor = 'pumpfun_priority_fee';
  await ctx.reply(
    `⚡ Enable or disable priority fees (current: ${settings?.priorityFee ? 'Enabled' : 'Disabled'}):\n\n` +
    'Type "yes" to enable or "no" to disable'
  );
};

/**
 * Check connection status for a specific user
 * @param userId The user ID to check
 * @returns Connection status information
 */
async function getConnectionStatus(userId: number): Promise<{
  status: string;
  readyState?: number;
  lastMessageTime?: number;
}> {
  try {
    const isActive = isPumpFunListenerActive(userId);
    if (!isActive) {
      return { status: '🔴 Not active' };
    }

    // We can't directly access activeListeners, so let's use what we can from the API
    const pumpStatus = getPumpFunListenerStatus(userId);
    
    // This is a placeholder - we'll need to enhance the pumpFunService API
    // to expose this information properly in the future
    return { 
      status: pumpStatus === 'idle' ? '🟡 Idle' : 
              pumpStatus === 'monitoring' ? '🟢 Monitoring' : 
              pumpStatus === 'trading' ? '🟢 Trading' : '❓ Unknown',
      lastMessageTime: Date.now() // This is a placeholder
    };
  } catch (error) {
    return { status: '❓ Unknown' };
  }
}

/**
 * Handle running network diagnostics for Pump.fun
 */
export const handlePumpFunDiagnostics = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Error: User ID not found.');
    return;
  }

  const loadingMsg = await ctx.reply('🔄 Running PumpPortal diagnostics...');
  
  // Initialize results
  let dnsWorking = false;
  const dnsResults: Record<string, string> = {};
  let httpWorking = false;
  let wsWorking = false;
  let wsError: string | undefined;
  
  try {
    // Test DNS resolution
    try {
      const domains = ['socket.pump.fun', 'api.pump.fun', 'pump.fun'];
      for (const domain of domains) {
        try {
          const resolved = await dnsLookup(domain);
          dnsResults[domain] = resolved.address;
        } catch (err: any) {
          dnsResults[domain] = `Failed: ${err.message}`;
        }
      }
      
      // Consider DNS working if at least one domain resolved successfully
      dnsWorking = Object.values(dnsResults).some(result => !result.includes('Failed'));
    } catch (err: any) {
      logger.error(`DNS test error: ${err.message}`);
    }
    
    // Test HTTP connectivity
    try {
      const response = await axios.get('https://pump.fun', {
        timeout: 10000,
        httpsAgent: new https.Agent({
          rejectUnauthorized: false // For diagnostic purposes only
        })
      });
      
      httpWorking = response.status === 200;
    } catch (err: any) {
      logger.error(`HTTP test error: ${err.message}`);
    }
    
    // Test WebSocket connectivity
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ws = new WebSocket('wss://socket.pump.fun/socket.io/?EIO=4&transport=websocket');
        
        const wsResult = await new Promise<{success: boolean, error?: string}>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.terminate();
            resolve({ success: false, error: 'Connection timeout' });
          }, 10000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true });
          });
          
          ws.on('error', (error) => {
            clearTimeout(timeout);
            ws.terminate();
            resolve({ success: false, error: error.message });
          });
        });
        
        if (wsResult.success) {
          wsWorking = true;
          break;
        } else {
          wsError = wsResult.error || 'Connection failed';
        }
      } catch (err: any) {
        wsError = err.message || 'Connection failed';
        // Wait before retry
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Format results message
    let diagResultsMsg = `📊 PumpPortal Diagnostic Results\n\n`;
    diagResultsMsg += `DNS Resolution: ${dnsWorking ? '✅ Working' : '❌ Failed'}\n`;
    
    for (const [domain, ip] of Object.entries(dnsResults)) {
      diagResultsMsg += `${dnsWorking ? '✅' : '❌'} ${domain} resolves to ${ip}\n`;
    }
    
    diagResultsMsg += `\nHTTP Connectivity: ${httpWorking ? '✅ Working' : '❌ Failed'}\n`;
    diagResultsMsg += `WebSocket Connectivity: ${wsWorking ? '✅ Working' : '❌ Failed'}\n`;

    if (!httpWorking || !wsWorking) {
      diagResultsMsg += `\nError Message: ${httpWorking ? wsError : 'Connection failed'}\n\n`;
      diagResultsMsg += `Recommendations:\n`;
      diagResultsMsg += `• Check if your network blocks outbound HTTPS (port 443) connections\n`;
      diagResultsMsg += `• Verify your EC2 security group allows outbound traffic\n`;
      diagResultsMsg += `• Ensure WebSocket connections on port 443 are allowed\n`;
      diagResultsMsg += `• Check if your network or proxy blocks WebSocket upgrades\n\n`;
      
      diagResultsMsg += `To fix EC2 connectivity issues:\n`;
      diagResultsMsg += `1. Edit your EC2 security group to allow all outbound traffic\n`;
      diagResultsMsg += `2. Run these commands on your server:\n`;
      diagResultsMsg += `echo "52.198.55.31 socket.pump.fun" | sudo tee -a /etc/hosts\n`;
      diagResultsMsg += `echo "52.198.55.31 socket.pumpportal.fun" | sudo tee -a /etc/hosts\n`;
      diagResultsMsg += `echo "nameserver 8.8.8.8" | sudo tee -a /etc/resolv.conf\n`;
    }
    
    // Update status message with results
    if (ctx.chat) {
      try {
        // Try to edit the message, but if it fails, just send a new one
        ctx.reply(diagResultsMsg);
      } catch (err) {
        ctx.reply(diagResultsMsg);
      }
    } else {
      // If chat is undefined, try sending a new message
      await ctx.reply(diagResultsMsg);
    }
    
  } catch (error: any) {
    logger.error(`Error running diagnostics: ${error.message}`);
    await ctx.reply('❌ Error running diagnostics. Please try again later.');
  }
};

/**
 * Check if pump.fun services are reachable
 * @returns A boolean indicating whether the service is reachable
 */
async function isPumpFunReachable(): Promise<boolean> {
  try {
    // First, try to resolve the domain
    try {
      await dnsLookup('socket.pumpportal.fun');
      logger.info('Domain socket.pumpportal.fun successfully resolved');
    } catch (error: any) {
      logger.warn('Cannot resolve socket.pumpportal.fun domain, will try alternative domains');
      
      // Try alternative domains
      try {
        await dnsLookup('api.pumpportal.fun');
        logger.info('Domain api.pumpportal.fun successfully resolved');
      } catch (error: any) {
        try {
          await dnsLookup('pumpportal.fun');
          logger.info('Domain pumpportal.fun successfully resolved');
        } catch (error: any) {
          logger.error('All pumpportal.fun domains failed to resolve');
          return false;
        }
      }
    }
    
    // Then try to connect to the API to check if service is up
    try {
      const response = await axios.get('https://pumpportal.fun/api/health', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        logger.info('PumpPortal API is reachable');
        return true;
      }
    } catch (error: any) {
      logger.warn('Could not connect to PumpPortal API health endpoint');
    }
    
    // If API health check fails, try a simple HTTP request
    try {
      const response = await axios.get('https://pumpportal.fun', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        logger.info('PumpPortal website is reachable');
        return true;
      }
    } catch (error: any) {
      logger.error('Could not connect to PumpPortal website');
    }
    
    return false;
  } catch (error: any) {
    logger.error(`Error checking PumpPortal reachability: ${error.message}`);
    return false;
  }
}

/**
 * Connect to PumpPortal WebSocket to listen for new tokens
 * @param userId The user ID
 * @returns A promise that resolves when connected
 */
async function connectToPumpFunWebSocket(userId: number): Promise<void> {
  const listener = activeListeners.get(userId);
  if (!listener) {
    throw new Error("No active listener found for user");
  }

  try {
    // Close existing connection if any
    if (listener.wsConnection) {
      listener.wsConnection.close();
    }

    // Clear any existing heartbeat interval
    if (listener.heartbeatIntervalId) {
      clearInterval(listener.heartbeatIntervalId);
      listener.heartbeatIntervalId = undefined;
    }

    // Clear any existing health check interval
    if (listener.connectionHealthCheckId) {
      clearInterval(listener.connectionHealthCheckId);
      listener.connectionHealthCheckId = undefined;
    }

    // Try multiple connection endpoints in case one fails
    const endpoints = [
      'wss://socket.pumpportal.fun/socket',
      'wss://api.pumpportal.fun/socket',
      'wss://www.pumpportal.fun/socket',
      'wss://pumpportal.fun/socket',
      'wss://socket.pumpportal.fun:443/socket' // Try explicitly setting port 443
    ];
    
    let connected = false;
    let lastError = null;
    
    // Try each endpoint until one succeeds
    for (const endpoint of endpoints) {
      if (connected) break;
      
      try {
        logger.info(`Attempting to connect to ${endpoint} for user ${userId}`);
        const ws = new WebSocket(endpoint, {
          handshakeTimeout: 10000, // 10 seconds timeout for handshake
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          // Force IPv4 if needed
          // family: 4
        });
        
        // Create a promise that resolves on connection or rejects on error
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
            ws.terminate();
          }, 15000);
          
          ws.on('open', () => {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true });
          });
          
          ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        
        // If we get here, connection succeeded
        connected = true;
        
        // Update last message timestamp
        listener.lastMessageTimestamp = Date.now();
        
        // Setup event handlers
        ws.on('open', () => {
          logger.info(`WebSocket connection opened for user ${userId} at ${endpoint}`);
          notifyUserById(userId, `🔌 Connected to PumpPortal WebSocket API`);
          
          // Subscribe to new token events
          ws.send(JSON.stringify({
            type: 'subscribe',
            channel: 'tokens:new'
          }));

          // Setup heartbeat ping to keep connection alive (every 30 seconds)
          listener.heartbeatIntervalId = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              logger.debug(`Sending heartbeat ping for user ${userId}`);
              ws.ping();
              
              // Also send subscription message periodically to keep connection active
              try {
                ws.send(JSON.stringify({ 
                  type: 'ping',
                  timestamp: Date.now()
                }));
              } catch (err: any) {
                logger.warn(`Error sending heartbeat message: ${err.message}`);
              }
            }
          }, 30000);

          // Setup health check to detect stale connections (check every minute)
          listener.connectionHealthCheckId = setInterval(() => {
            const now = Date.now();
            const minutesSinceLastMessage = (now - listener.lastMessageTimestamp) / (1000 * 60);
            
            // If no message received for 5 minutes, consider connection stale
            if (minutesSinceLastMessage > 5) {
              logger.warn(`No messages received for ${minutesSinceLastMessage.toFixed(1)} minutes for user ${userId}. Reconnecting...`);
              
              // Notify user of stale connection
              notifyUserById(userId, `⚠️ No messages received from PumpPortal for ${minutesSinceLastMessage.toFixed(0)} minutes. Reconnecting...`);
              
              // Force reconnection
              ws.terminate();
              
              // Reconnect with slight delay
              setTimeout(() => {
                if (activeListeners.has(userId)) {
                  connectToPumpFunWebSocket(userId);
                }
              }, 1000);
            }
          }, 60000);
        });

        break;
      } catch (error: any) {
        // Log the error but continue to try other endpoints
        lastError = error;
        logger.warn(`Failed to connect to ${endpoint}: ${error.message}`);
      }
    }
    
    // If we couldn't connect to any endpoint, throw the last error
    if (!connected && lastError) {
      throw lastError;
    }
    
  } catch (error: any) {
    logger.error(`Error setting up WebSocket for user ${userId}: ${error.message}`);
    notifyUserById(userId, `⚠️ Could not connect to PumpPortal. Please try again later or check if service is available.`);
    
    // Set a retry after some time
    setTimeout(() => {
      if (activeListeners.has(userId)) {
        connectToPumpFunWebSocket(userId);
      }
    }, 30000); // Retry after 30 seconds
  }
}

/**
 * Get WebSocket connection state for a user
 * @param userId User ID to check connection for
 * @returns Connection state information
 */
export function getPumpFunConnectionState(userId: number): {
  connected: boolean;
  readyState?: number;
  lastMessageTimestamp?: number;
  endpoint?: string;
} {
  const listener = activeListeners.get(userId);
  if (!listener || !listener.wsConnection) {
    return { connected: false };
  }

  return {
    connected: listener.wsConnection.readyState === WebSocket.OPEN,
    readyState: listener.wsConnection.readyState,
    lastMessageTimestamp: listener.lastMessageTimestamp,
    endpoint: listener.wsConnection.url
  };
}

/**
 * Run diagnostics on WebSocket connection
 * @param userId User ID to run diagnostics for
 * @returns Diagnostic results
 */
export async function runPumpFunDiagnostics(userId: number): Promise<{
  dns: boolean;
  dnsResults: string[];
  http: boolean;
  websocket: boolean;
  connectionState?: {
    connected: boolean;
    readyState?: number;
    lastMessageTimestamp?: number;
  } | undefined;
  errorMessage?: string | undefined;
}> {
  const results: {
    dns: boolean;
    dnsResults: string[];
    http: boolean;
    websocket: boolean;
    connectionState?: {
      connected: boolean;
      readyState?: number;
      lastMessageTimestamp?: number;
    };
    errorMessage?: string;
  } = {
    dns: false,
    dnsResults: [],
    http: false,
    websocket: false
  };

  try {
    // Test DNS resolution
    try {
      const domains = ['socket.pumpportal.fun', 'api.pumpportal.fun', 'pumpportal.fun'];
      for (const domain of domains) {
        try {
          const resolved = await dnsLookup(domain);
          results.dnsResults.push(`✅ ${domain} resolves to ${resolved.address}`);
          results.dns = true;
        } catch (error: any) {
          results.dnsResults.push(`❌ ${domain} resolution failed: ${error.message}`);
        }
      }
    } catch (error: any) {
      results.dnsResults.push(`❌ DNS resolution test failed: ${error.message}`);
    }

    // Test HTTP connectivity
    try {
      const response = await axios.get('https://pumpportal.fun', {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 200) {
        results.http = true;
      }
    } catch (error: any) {
      results.errorMessage = `HTTP test failed: ${error.message}`;
    }

    // Check WebSocket state for this user
    const listener = activeListeners.get(userId);
    if (listener && listener.wsConnection) {
      results.connectionState = {
        connected: listener.wsConnection.readyState === WebSocket.OPEN,
        readyState: listener.wsConnection.readyState,
        lastMessageTimestamp: listener.lastMessageTimestamp
      };
      
      if (listener.wsConnection.readyState === WebSocket.OPEN) {
        results.websocket = true;
      }
    }
    
    // If no active connection, test creating a temporary one
    if (!results.websocket) {
      try {
        // Try to open a temporary WebSocket connection
        const tempResult = await testWebSocketConnection();
        results.websocket = tempResult.success;
        if (!tempResult.success && tempResult.error) {
          results.errorMessage = tempResult.error;
        }
      } catch (error: any) {
        results.errorMessage = `WebSocket test failed: ${error.message}`;
      }
    }

    return results;
  } catch (error: any) {
    logger.error(`Error running diagnostics: ${error.message}`);
    return {
      ...results,
      errorMessage: `Diagnostic error: ${error.message}`
    };
  }
}

/**
 * Test WebSocket connection to PumpPortal
 * @returns Test result
 */
async function testWebSocketConnection(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      // Close after 5 seconds regardless of outcome
      const timeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
          resolve({ success: false, error: 'Connection timeout' });
        }
      }, 5000);
      
      const ws = new WebSocket('wss://socket.pumpportal.fun/socket', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      ws.on('open', () => {
        clearTimeout(timeout);
        // Close the test connection
        ws.close();
        resolve({ success: true });
      });
      
      ws.on('error', (error) => {
        clearTimeout(timeout);
        ws.terminate();
        resolve({ success: false, error: error.message });
      });
    } catch (error: any) {
      resolve({ success: false, error: error.message });
    }
  });
}

export const testPumpFunConnection = async (userId: number): Promise<{
  success: boolean;
  details: {
    http: boolean;
    websocket: boolean;
    dns: {
      success: boolean;
      results: Record<string, string>;
    };
    ping: {
      success: boolean;
      latency?: number;
      packetLoss?: number;
    };
    errorDetails?: string;
  }
}> => {
  const result = {
    success: false,
    details: {
      http: false,
      websocket: false,
      dns: {
        success: false,
        results: {} as Record<string, string>
      },
      ping: {
        success: false,
        latency: undefined as number | undefined,
        packetLoss: undefined as number | undefined
      },
      errorDetails: undefined as string | undefined
    }
  };

  try {
    // Test DNS resolution
    try {
      const domains = ['socket.pumpportal.fun', 'api.pumpportal.fun', 'pumpportal.fun'];
      let dnsSuccessCount = 0;
      
      for (const domain of domains) {
        try {
          const resolveResult = await dnsLookup(domain);
          result.details.dns.results[domain] = resolveResult.address;
          dnsSuccessCount++;
        } catch (dnsErr: any) {
          result.details.dns.results[domain] = `ERROR: ${dnsErr.message}`;
        }
      }
      
      // Consider DNS successful if at least one domain resolves
      result.details.dns.success = dnsSuccessCount > 0;
    } catch (dnsError: any) {
      result.details.errorDetails = `DNS ERROR: ${dnsError.message}`;
    }
    
    // Test HTTP connectivity
    try {
      const response = await axios.get('https://pumpportal.fun', {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        httpsAgent: new https.Agent({
          rejectUnauthorized: false // For diagnostic purposes only
        })
      });
      
      result.details.http = response.status === 200;
    } catch (httpError: any) {
      result.details.errorDetails = `HTTP ERROR: ${httpError.message}`;
    }

    // Test ping to IP
    if (result.details.dns.success) {
      try {
        // Get first successfully resolved IP
        const ip = Object.values(result.details.dns.results).find(value => !value.includes('ERROR'));
        
        if (ip) {
          const pingResult = await ping.promise.probe(ip, {
            timeout: 10,
            extra: ['-c', '4']
          });
          
          result.details.ping.success = pingResult.alive;
          if (pingResult.alive) {
            result.details.ping.latency = parseFloat(pingResult.avg);
            result.details.ping.packetLoss = parseFloat(pingResult.packetLoss);
          }
        }
      } catch (pingError: any) {
        result.details.errorDetails = `PING ERROR: ${pingError.message}`;
      }
    }

    // Test WebSocket with custom agent
    try {
      const WebSocket = require('ws');
      const https = require('https');
      
      const wsResult = await new Promise<boolean>((resolve, reject) => {
        const wsOptions = {
          agent: new https.Agent({
            rejectUnauthorized: false, // For diagnosis only
            keepAlive: true,
            timeout: 15000
          }),
          handshakeTimeout: 15000
        };

        const ws = new WebSocket('wss://socket.pumpportal.fun/socket.io/?EIO=4&transport=websocket', wsOptions);
        
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error('WebSocket connection timed out'));
        }, 15000);
        
        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });
        
        ws.on('error', (error: Error) => {
          clearTimeout(timeout);
          ws.terminate();
          reject(error);
        });
      });
      
      result.details.websocket = wsResult;
    } catch (wsError: any) {
      if (!result.details.errorDetails) {
        result.details.errorDetails = `WEBSOCKET ERROR: ${wsError.message}`;
      } else {
        result.details.errorDetails += ` | WEBSOCKET ERROR: ${wsError.message}`;
      }
    }

    // If we get this far, determine overall success
    result.success = result.details.dns.success && result.details.http && result.details.websocket;
    
  } catch (error: any) {
    if (!result.details.errorDetails) {
      result.details.errorDetails = `GENERAL ERROR: ${error.message}`;
    } else {
      result.details.errorDetails += ` | GENERAL ERROR: ${error.message}`;
    }
  }

  return result;
}