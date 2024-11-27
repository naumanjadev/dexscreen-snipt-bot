// src/services/tokenFilters.ts
import { getUserSettings } from './userSettingsService';
import { getLiquidity, hasMintAuthority, getTopHoldersConcentration } from './tokenDataService';
import { TokenInfo } from '../types';

export const applyFilters = async (tokenInfo: TokenInfo, userId: number): Promise<boolean> => {
  const userSettings = await getUserSettings(userId);

  // Liquidity Filter
  if (userSettings.liquidityThreshold !== null) {
    const liquidity = await getLiquidity(tokenInfo.mintAddress);
    if (liquidity < userSettings.liquidityThreshold) {
      return false;
    }
  }

  // Mint Authority Filter
  if (userSettings.requireMintAuthority !== null) {
    const mintAuthority = await hasMintAuthority(tokenInfo.mintAddress);
    if (mintAuthority !== userSettings.requireMintAuthority) {
      return false;
    }
  }

  // Top 10 Holder Concentration Filter
  if (userSettings.topHoldersThreshold !== null) {
    const concentration = await getTopHoldersConcentration(tokenInfo.mintAddress);
    if (concentration > userSettings.topHoldersThreshold) {
      return false;
    }
  }

  return true;
};
