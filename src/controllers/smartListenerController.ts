import { startSmartListener, stopSmartListener, isSmartListenerActive, getSmartListenerSettings, confirmSellAndStop, justStop } from '../services/smartListenerService';
import { MyContext } from '../types';
import { logger } from '../utils/logger';

// Add handlers for the new confirmation commands
export const handleConfirmSellCommand = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Call the confirmSellAndStop function from the service
    await confirmSellAndStop(userId);
  } catch (error: any) {
    logger.error(`Error in confirm sell command handler: ${error.message}`, error);
    await ctx.reply(`❌ Failed to confirm sell: ${error.message}`);
  }
};

export const handleJustStopCommand = async (ctx: MyContext): Promise<void> => {
  try {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('❌ User ID not found.');
      return;
    }

    // Call the justStop function from the service
    justStop(userId);
  } catch (error: any) {
    logger.error(`Error in just stop command handler: ${error.message}`, error);
    await ctx.reply(`❌ Failed to stop listener: ${error.message}`);
  }
}; 