// src/controllers/filterController.ts
import { MyContext } from '../types';
import { updateUserSettings, getUserSettings } from '../services/userSettingsService';
import { startTokenListener, stopTokenListener } from '../services/solanaListener';

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

/**
 * Displays the current boost amount set by the user.
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

    const filters = `<b>Your current filter is:</b>
- <b>Boost Amount:</b> ${boostAmountText}`;

    await ctx.reply(filters, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error showing filters for user ${userId}:`, error);
    await ctx.reply('Unable to retrieve your filter at this time.');
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
