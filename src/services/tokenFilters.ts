import { TokenInfo } from '../types';
import { getUserSettings } from './userSettingsService';
import { logger } from '../utils/logger';

/**
 * Applies user-defined filters to a token.
 * We now compare user boostamount setting with dexData.totalAmount
 * @param tokenInfo - Information about the token.
 * @param userId - The unique identifier of the user.
 * @param dexData - The DexScreener boosted token data.
 * @returns A boolean indicating whether the token passes all filters.
 */
export const applyFilters = async (tokenInfo: TokenInfo, userId: number, dexData: any): Promise<boolean> => {
  try {
    const settings = await getUserSettings(userId);

    // Check totalAmount against user-defined boostamount if provided
    if (settings.boostamount !== null) {
      const tokenBoostAmount = dexData.totalAmount || 0;
      if (tokenBoostAmount < settings.boostamount) {
        logger.debug(`Token ${tokenInfo.mintAddress} failed boostamount filter for user ${userId}. Required: ${settings.boostamount}, got: ${tokenBoostAmount}`);
        return false;
      }
    }

    logger.info(`Token ${tokenInfo.mintAddress} passed all filters for user ${userId}.`);
    return true;
  } catch (error) {
    logger.error(`Error applying filters for token ${tokenInfo.mintAddress} and user ${userId}:`, error);
    return false;
  }
};
