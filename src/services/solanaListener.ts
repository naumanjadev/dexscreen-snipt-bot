// src/services/solanaListener.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';

export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');
let listenerId: number | null = null;

// SPL Token Program ID
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);

export const startTokenListener = (userId: number): void => {
  if (listenerId !== null) {
    logger.warn('Token listener is already running.');
    return;
  }

  listenerId = connection.onProgramAccountChange(
    SPL_TOKEN_PROGRAM_ID,
    async (keyedAccountInfo) => {
      const accountId = keyedAccountInfo.accountId.toBase58();

      // Here, you can fetch token metadata or additional information if needed
      const tokenInfo: TokenInfo = {
        mintAddress: accountId,
      };

      // Apply filters
      const passesFilters = await applyFilters(tokenInfo, userId);

      if (passesFilters) {
        logger.info(`Token ${accountId} passed filters.`);
        // Here, you can proceed to automate the token purchase
      } else {
        logger.info(`Token ${accountId} did not pass filters.`);
      }
    },
    'confirmed'
  );

  logger.info('Solana token listener started.');
};

export const stopTokenListener = (): void => {
  if (listenerId !== null) {
    connection.removeProgramAccountChangeListener(listenerId);
    listenerId = null;
    logger.info('Solana token listener stopped.');
  } else {
    logger.warn('Token listener is not running.');
  }
};
