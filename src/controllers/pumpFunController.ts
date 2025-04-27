import { MyContext } from '../types';
import { logger } from '../utils/logger';
import { PublicKey } from '@solana/web3.js';
import { getUserWallet } from '../services/walletService';
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
        '❓ Pump.fun listener is already active. What would you like to do?\n\n' +
        '/pumpfun_settings - View and update settings\n' +
        '/pumpfun_status - Check current status\n' +
        '/stop_pumpfun - Stop the listener\n' +
        '/start_pumpfun_trading - Start automatic trading'
      );
      return;
    }

    // Start the listener with default settings
    await startPumpFunListener(userId);
    
    // Reply with success message and settings options
    await ctx.reply(
      '✅ Pump.fun listener started! You will be notified about new tokens.\n\n' +
      'Use these commands to customize:\n' +
      '/pumpfun_settings - View and update settings\n' +
      '/pumpfun_token_filter - Set name/symbol filter\n' +
      '/start_pumpfun_trading - Start automatic trading\n' +
      '/stop_pumpfun - Stop the listener'
    );
    
    logger.info(`User ${userId} started the Pump.fun listener.`);
  } catch (error: any) {
    logger.error(`Error starting Pump.fun listener: ${error.message}`, error);
    await ctx.reply(`❌ Failed to start Pump.fun listener: ${error.message}`);
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
      await ctx.reply('❌ Pump.fun listener is not active.');
      return;
    }

    // Stop the listener
    stopPumpFunListener(userId);
    
    await ctx.reply('✅ Pump.fun listener stopped.');
    logger.info(`User ${userId} stopped the Pump.fun listener.`);
  } catch (error: any) {
    logger.error(`Error stopping Pump.fun listener: ${error.message}`, error);
    await ctx.reply(`❌ Failed to stop Pump.fun listener: ${error.message}`);
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
      await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
      return;
    }

    // Get current status
    const status = getPumpFunListenerStatus(userId);
    if (status === 'trading') {
      await ctx.reply('ℹ️ Pump.fun trading is already active.');
      return;
    }

    // Start trading
    await startPumpFunTrading(userId);
    
    // Get current settings
    const settings = getPumpFunSettings(userId);
    
    // Reply with success message
    await ctx.reply(
      '✅ Pump.fun trading started! The bot will automatically buy tokens based on your settings.\n\n' +
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
    
    logger.info(`User ${userId} started automatic Pump.fun trading.`);
  } catch (error: any) {
    logger.error(`Error starting Pump.fun trading: ${error.message}`, error);
    await ctx.reply(`❌ Failed to start Pump.fun trading: ${error.message}`);
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
      await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    logger.error(`Error handling Pump.fun settings: ${error.message}`, error);
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
      await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    logger.error(`Error handling Pump.fun token filter: ${error.message}`, error);
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
      await ctx.reply('ℹ️ Pump.fun listener is not active. Use /start_pumpfun to start it.');
      return;
    }

    // Get current status and settings
    const status = getPumpFunListenerStatus(userId);
    const settings = getPumpFunSettings(userId);
    const history = getPumpFunTradingHistory(userId);
    
    // Calculate trading stats
    const buys = history?.filter(trade => trade.action === 'buy').length || 0;
    const sells = history?.filter(trade => trade.action === 'sell').length || 0;
    
    // Create the status message
    let message = `📊 <b>Pump.fun Bot Status</b>\n\n`;
    message += `<b>Current state:</b> ${status === 'monitoring' ? '🔍 Monitoring only' : '🤖 Trading'}\n\n`;
    
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
    logger.error(`Error checking Pump.fun status: ${error.message}`, error);
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
    await ctx.reply('❌ Settings not found. Please restart the Pump.fun listener.');
    return;
  }

  // Create the settings message
  const message = `⚙️ <b>Pump.fun Settings</b>\n\n` +
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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
    await ctx.reply('❌ You need to start the Pump.fun listener first. Use /start_pumpfun to do that.');
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