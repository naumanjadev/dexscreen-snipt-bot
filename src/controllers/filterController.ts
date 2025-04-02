// src/controllers/filterController.ts
import { MyContext } from '../types';
import { updateUserSettings, getUserSettings } from '../services/userSettingsService';
import { startTokenListener, stopTokenListener } from '../services/solanaListener';
import { startSmartListener, stopSmartListener, isSmartListenerActive, getSmartListenerSettings, getDetailedTokenAnalytics, updateSmartListenerSettings } from '../services/smartListenerService';
import { getUserWallet } from '../services/walletService';
import { logger } from '../utils/logger';

/**
 * Handles the /set_boost_amount command.
 */

export const handleSetBoostAmountCommand = async (ctx: MyContext): Promise<void> => {
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Please enter the boost amount (or type "no boost"):');
    ctx.session.awaitingInputFor = 'set_boost_amount';
  } else {
    const input = ctx.message?.text?.trim().toLowerCase();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    if (input === 'no boost') {
      await updateUserSettings(userId, { boostamount: null });
      await ctx.reply('Boost amount removed.');
    } else {
      const value = parseFloat(input);
      if (isNaN(value) || value < 0) {
        await ctx.reply('Please enter a valid number (non-negative).');
        return;
      }
      await updateUserSettings(userId, { boostamount: value });
      await ctx.reply(`Boost amount set to ${value} .`);
    }
    ctx.session.awaitingInputFor = undefined;
  }
};

export const handleSetBuyAmountCommand = async (ctx: MyContext): Promise<void> => { 
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Please enter the buy amount (or type "no buy"):');
    ctx.session.awaitingInputFor = 'set_buy_amount';
  } else {
    const input = ctx.message?.text?.trim().toLowerCase();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    if (input === 'no buy') {
      await updateUserSettings(userId, { buyamount: null });
      await ctx.reply('Buy amount removed.');
    } else {
      const value = parseFloat(input);
      if (isNaN(value) || value < 0) {
        await ctx.reply('Please enter a valid number (non-negative).');
        return;
      }
      await updateUserSettings(userId, { buyamount: value });
      await ctx.reply(`Buy amount set to ${value} .`);
      
      // Also update the trading budget for smart listener if it's active
      if (isSmartListenerActive(userId)) {
        updateSmartListenerSettings(userId, { tradingBudget: value });
        await ctx.reply(`Smart listener trading budget also updated to ${value} SOL.`);
      }
    }
    ctx.session.awaitingInputFor = undefined;
  }
}

/**
 * Displays the current filters set by the user.
 * @param ctx - The context of the Telegram message.
 */
export const handleShowFiltersCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    const settings = await getUserSettings(userId);

    const boostAmountText =
      settings.boostamount !== null ? `${settings.boostamount} ` : 'No boost set';
    
    const buyAmountText =
      settings.buyamount !== null ? `${settings.buyamount} ` : 'No buy amount set';

    const filters = `<b>Your current filters:</b>
- <b>Boost Amount:</b> ${boostAmountText}
- <b>Buy Amount:</b> ${buyAmountText}`;

    await ctx.reply(filters, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error showing filters for user ${userId}:`, error);
    await ctx.reply('Unable to retrieve your filters at this time.');
  }
};

/**
 * Starts the token listener for a user.
 * @param ctx - The context of the Telegram message.
 */
export const handleStartListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    // Start the listener for this user
    await startTokenListener(userId);
    await ctx.reply('📡 Token detection has been started.');
  } catch (error) {
    console.error(`Error starting token listener for user ${userId}:`, error);
    await ctx.reply('Failed to start token detection. Please try again later.');
  }
};

/**
 * Stops the token listener for a user.
 * @param ctx - The context of the Telegram message.
 */
export const handleStopListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    await stopTokenListener(userId);
    await ctx.reply('📡 Token detection has been stopped.');
  } catch (error) {
    console.error(`Error stopping token listener for user ${userId}:`, error);
    await ctx.reply('Failed to stop token detection. Please try again later.');
  }
};

/**
 * Handles the smart listener command to start monitoring for tokens and their prices
 */
export const handleSmartListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  try {
    // Check if user has wallet
    const userSettings = await getUserSettings(userId);
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      await ctx.reply('❌ You need to set up a wallet first. Use /wallet to create or import a wallet.');
      return;
    }

    // Check if user has filters set
    if (userSettings.boostamount === null || userSettings.buyamount === null) {
      await ctx.reply('❌ You need to set up filters first. Use /set_boost_amount and /set_buy_amount to configure your filters.');
      return;
    }

    // Check if smart listener is already active
    if (isSmartListenerActive(userId)) {
      await ctx.reply('⚠️ Smart listener is already active. Use /stop_smart_listener to stop it first.');
      return;
    }

    await ctx.reply(`
🔍 <b>Starting Smart Listener</b>

The bot will:
1. Find the first token matching your filters
2. Attempt to purchase it using ${userSettings.buyamount} SOL
3. Monitor its price continuously
4. Alert you of significant price changes

<i>This will run until you stop it with /stop_smart_listener</i>
<i>You can change the trading budget with /set_trading_budget</i>
`, { parse_mode: 'HTML' });

    await startSmartListener(userId);
  } catch (error: any) {
    logger.error(`Error starting smart listener for user ${userId}: ${error.message}`, error);
    await ctx.reply(`❌ Error starting smart listener: ${error.message}`);
  }
};

/**
 * Handles the command to stop the smart listener
 */
export const handleStopSmartListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  try {
    if (!isSmartListenerActive(userId)) {
      await ctx.reply('ℹ️ Smart listener is not currently active.');
      return;
    }

    stopSmartListener(userId);
    await ctx.reply('✅ Smart listener has been stopped.');
  } catch (error: any) {
    logger.error(`Error stopping smart listener for user ${userId}: ${error.message}`, error);
    await ctx.reply(`❌ Error stopping smart listener: ${error.message}`);
  }
};

/**
 * Handles the command to customize smart listener settings
 */
export const handleSmartListenerSettingsCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  // Get command arguments if any
  const args = ctx.message?.text?.split(' ').slice(1) || [];
  
  // If no arguments, show current settings and help
  if (args.length === 0) {
    // Import the activeSmartListeners map from the service
    const { isSmartListenerActive, getSmartListenerSettings } = await import('../services/smartListenerService');
    
    let message = `
📊 <b>Smart Listener Settings</b>

Configure your smart listener with the following commands:

<b>Price Monitoring:</b>
/smart_settings frequency [value] - Set update frequency in milliseconds (default: 1000)
/smart_settings threshold [value] - Set minimum price change % to notify (default: 0.05)
/smart_settings profit [value] - Set profit target % (default: 30)
/smart_settings stoploss [value] - Set stop loss % from initial price (default: 10)
/smart_settings trailing [value] - Set trailing stop loss % from peak (default: 5)

<b>Trading Options:</b>
/smart_settings autosell [on/off] - Enable/disable auto-selling (default: off)
/smart_settings multiple [on/off] - Monitor multiple tokens (default: off)

<b>Notification Settings:</b>
/smart_settings notify [important_only/trade_signals] - Set notification mode
/smart_settings compact [on/off] - Enable/disable compact notification format
/smart_settings mute [on/off] - Mute non-critical notifications
<i>Note: All messages will be automatically deleted after 2 seconds</i>

Example: /smart_settings profit 50
`;

    // If the listener is active, show current settings
    if (isSmartListenerActive(userId)) {
      const settings = getSmartListenerSettings(userId);
      message += `
<b>Current Settings:</b>

<b>Price Monitoring:</b>
• Update Frequency: ${settings.updateFrequency}ms
• Notification Threshold: ${settings.notificationThreshold}%
• Profit Target: ${settings.profitTarget}%
• Stop Loss: ${settings.stopLoss}%
• Trailing Stop: ${settings.trailingStopLoss}%

<b>Trading Options:</b>
• Auto-Sell: ${settings.autoSellEnabled ? 'ON' : 'OFF'}
• Multiple Tokens: ${settings.monitorMultipleTokens ? 'ON' : 'OFF'}

<b>Notification Settings:</b>
• Mode: ${settings.notificationMode === 'important_only' ? 'IMPORTANT ONLY' : 'TRADE SIGNALS'}
• Message Lifetime: 2 seconds (auto-delete)
• Compact Mode: ${settings.compactMode ? 'ON' : 'OFF'}
• Mute Non-Critical: ${settings.muteNonCritical ? 'ON' : 'OFF'}
`;
    } else {
      message += `
<i>Smart listener is not currently active. Start it with /smart_listener</i>
`;
    }
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    return;
  }

  // Process setting change
  const setting = args[0]?.toLowerCase();
  const value = args[1]?.toLowerCase();
  
  if (!value) {
    await ctx.reply('❌ Please provide a value for the setting. Example: /smart_settings profit 50');
    return;
  }
  
  // Import necessary functions
  const { updateSmartListenerSettings, isSmartListenerActive } = await import('../services/smartListenerService');
  
  // Check if we can update (either listener is active or we're setting defaults)
  if (!isSmartListenerActive(userId)) {
    await ctx.reply('ℹ️ Smart listener is not active. These settings will apply the next time you start it.');
  }
  
  // Process the different settings
  try {
    switch (setting) {
      case 'frequency':
        const frequency = parseInt(value);
        if (isNaN(frequency) || frequency < 500) {
          await ctx.reply('❌ Frequency must be at least 500ms');
          return;
        }
        updateSmartListenerSettings(userId, { updateFrequency: frequency });
        await ctx.reply(`✅ Update frequency set to ${frequency}ms`);
        break;
        
      case 'threshold':
        const threshold = parseFloat(value);
        if (isNaN(threshold) || threshold < 0.01) {
          await ctx.reply('❌ Threshold must be at least 0.01%');
          return;
        }
        updateSmartListenerSettings(userId, { notificationThreshold: threshold });
        await ctx.reply(`✅ Notification threshold set to ${threshold}%`);
        break;
        
      case 'profit':
        const profit = parseFloat(value);
        if (isNaN(profit) || profit <= 0) {
          await ctx.reply('❌ Profit target must be greater than 0%');
          return;
        }
        updateSmartListenerSettings(userId, { profitTarget: profit });
        await ctx.reply(`✅ Profit target set to ${profit}%`);
        break;
        
      case 'stoploss':
        const stoploss = parseFloat(value);
        if (isNaN(stoploss) || stoploss <= 0 || stoploss >= 100) {
          await ctx.reply('❌ Stop loss must be between 0% and 100%');
          return;
        }
        updateSmartListenerSettings(userId, { stopLoss: stoploss });
        await ctx.reply(`✅ Stop loss set to ${stoploss}%`);
        break;
        
      case 'trailing':
        const trailing = parseFloat(value);
        if (isNaN(trailing) || trailing <= 0) {
          await ctx.reply('❌ Trailing stop must be greater than 0%');
          return;
        }
        updateSmartListenerSettings(userId, { trailingStopLoss: trailing });
        await ctx.reply(`✅ Trailing stop loss set to ${trailing}%`);
        break;
        
      case 'autosell':
        const autosell = value === 'on' || value === 'true' || value === '1';
        updateSmartListenerSettings(userId, { autoSellEnabled: autosell });
        await ctx.reply(`✅ Auto-sell ${autosell ? 'enabled' : 'disabled'}`);
        break;
        
      case 'multiple':
        const multiple = value === 'on' || value === 'true' || value === '1';
        updateSmartListenerSettings(userId, { monitorMultipleTokens: multiple });
        await ctx.reply(`✅ Multiple token monitoring ${multiple ? 'enabled' : 'disabled'}`);
        break;
      
      // New notification settings
      case 'notify':
        if (!['important_only', 'trade_signals'].includes(value)) {
          await ctx.reply('❌ Notification mode must be one of: important_only, trade_signals');
          return;
        }
        updateSmartListenerSettings(userId, { 
          notificationMode: value as 'important_only' | 'trade_signals' 
        });
        await ctx.reply(`✅ Notification mode set to ${value === 'important_only' ? 'IMPORTANT ONLY' : 'TRADE SIGNALS'}`);
        break;
      
      case 'batch_interval':
        await ctx.reply('❌ This setting is no longer available. Please use /smart_settings notify to choose between notification modes.');
        break;
      
      case 'msg_lifetime':
        // Force 2-second message lifetime regardless of user input
        updateSmartListenerSettings(userId, { notificationMessageLifetime: 2000 });
        await ctx.reply(`✅ All messages will be automatically deleted after 2 seconds.`);
        break;
      
      case 'compact':
        const compact = value === 'on' || value === 'true' || value === '1';
        updateSmartListenerSettings(userId, { compactMode: compact });
        await ctx.reply(`✅ Compact notification mode ${compact ? 'enabled' : 'disabled'}`);
        break;
      
      case 'mute':
        const mute = value === 'on' || value === 'true' || value === '1';
        updateSmartListenerSettings(userId, { muteNonCritical: mute });
        await ctx.reply(`✅ Non-critical notifications ${mute ? 'muted' : 'unmuted'}`);
        break;
        
      default:
        await ctx.reply(`❌ Unknown setting: ${setting}. Use /smart_settings for help.`);
    }
  } catch (error: any) {
    logger.error(`Error updating smart listener settings for user ${userId}: ${error.message}`, error);
    await ctx.reply(`❌ Error updating settings: ${error.message}`);
  }
};

/**
 * Handles the command to view detailed analytics for a monitored token
 */
export const handleViewAnalyticsCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('❌ Could not identify user.');
    return;
  }

  try {
    // Import needed functions
    const { isSmartListenerActive, getDetailedTokenAnalytics } = await import('../services/smartListenerService');
    
    // Check if the smart listener is active
    if (!isSmartListenerActive(userId)) {
      await ctx.reply('❌ Smart listener is not active. Start it with /smart_listener first.');
      return;
    }
    
    // Get detailed analytics for the token(s) being monitored
    const analytics = await getDetailedTokenAnalytics(userId);
    
    if (!analytics || analytics.length === 0) {
      await ctx.reply('❌ No token analytics available yet. The smart listener needs to collect more data.');
      return;
    }
    
    // Send the analytics report to the user
    for (const report of analytics) {
      await ctx.reply(report, { parse_mode: 'HTML' });
    }
  } catch (error: any) {
    logger.error(`Error viewing token analytics for user ${userId}: ${error.message}`, error);
    await ctx.reply(`❌ Error viewing analytics: ${error.message}`);
  }
};

/**
 * Handles the specific setting of trading budget for the smart listener
 */
export const handleSetTradingBudgetCommand = async (ctx: MyContext): Promise<void> => {
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Please enter the trading budget amount in SOL:');
    ctx.session.awaitingInputFor = 'set_trading_budget';
  } else {
    const input = ctx.message?.text?.trim().toLowerCase();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    const value = parseFloat(input);
    if (isNaN(value) || value <= 0) {
      await ctx.reply('Please enter a valid positive number.');
      return;
    }
    
    // Update the trading budget for smart listener
    updateSmartListenerSettings(userId, { tradingBudget: value });
    await ctx.reply(`Trading budget set to ${value} SOL for smart listener.`);
    
    ctx.session.awaitingInputFor = undefined;
  }
}
