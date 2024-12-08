// src/services/tokenFilters.ts

import { TokenInfo } from '../types';
import { getLiquidity, hasMintAuthority, getTopHoldersConcentration } from './tokenDataService';
import { getUserSettings } from './userSettingsService';
import { logger } from '../utils/logger';

/**
 * Applies user-defined filters to a token.
 * @param tokenInfo - Information about the token.
 * @param userId - The unique identifier of the user.
 * @returns A boolean indicating whether the token passes all filters.
 */
export const applyFilters = async (tokenInfo: TokenInfo, userId: number): Promise<boolean> => {
  try {
    const settings = await getUserSettings(userId);

    // Liquidity Filter
    if (settings.liquidityThreshold !== null) {
      const liquidity = await getLiquidity(tokenInfo.mintAddress);
      if (liquidity < settings.liquidityThreshold) {
        logger.debug(`Token ${tokenInfo.mintAddress} failed liquidity filter for user ${userId}.`);
        return false;
      }
    }

    // Mint Authority Filter
    if (settings.requireMintAuthority !== null) {
      const hasAuthority = await hasMintAuthority(tokenInfo.mintAddress);
      if (settings.requireMintAuthority && !hasAuthority) {
        logger.debug(`Token ${tokenInfo.mintAddress} failed mint authority filter for user ${userId}.`);
        return false;
      }
      if (!settings.requireMintAuthority && hasAuthority) {
        logger.debug(`Token ${tokenInfo.mintAddress} failed mint authority filter for user ${userId}.`);
        return false;
      }
    }

    // Top Holders Concentration Filter
    if (settings.topHoldersThreshold !== null) {
      const concentration = await getTopHoldersConcentration(tokenInfo.mintAddress);
      if (concentration > settings.topHoldersThreshold) {
        logger.debug(
          `Token ${tokenInfo.mintAddress} failed top holders concentration filter for user ${userId}.`
        );
        return false;
      }
    }

    logger.info(`Token ${tokenInfo.mintAddress} passed all filters for user ${userId}.`);
    return true;
  } catch (error) {
    logger.error(`Error applying filters for token ${tokenInfo.mintAddress} and user ${userId}:`, error);
    // Decide whether to fail open or closed; here we choose to fail closed
    return false;
  }
};
