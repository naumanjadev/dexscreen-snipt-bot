// src/services/solanaListener.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';

export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');
let listenerId: number | null = null;
const activeUserIds: Set<number> = new Set();

// SPL Token Program ID
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);

export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  if (listenerId === null) {
    listenerId = connection.onProgramAccountChange(
      SPL_TOKEN_PROGRAM_ID,
      async (keyedAccountInfo) => {
        const accountId = keyedAccountInfo.accountId.toBase58();

        // Fetch token metadata or additional information if needed
        const tokenInfo: TokenInfo = {
          mintAddress: accountId,
        };

        for (const uid of activeUserIds) {
          try {
            // Apply filters per user
            const passesFilters = await applyFilters(tokenInfo, uid);

            if (passesFilters) {
              logger.info(`Token ${accountId} passed filters for user ${uid}.`);
              // Proceed to automate the token purchase or notify the user
            } else {
              logger.debug(`Token ${accountId} did not pass filters for user ${uid}.`);
            }
          } catch (error) {
            logger.error(`Error processing token ${accountId} for user ${uid}: ${(error as Error).message}`);
          }
        }
      },
      'confirmed'
    );

    logger.info('Solana token listener started.');
  }
};

export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUserIds.has(userId)) {
    logger.warn(`Token detection is not active for user ${userId}.`);
    return;
  }

  activeUserIds.delete(userId);
  logger.info(`User ${userId} stopped token detection.`);

  if (activeUserIds.size === 0 && listenerId !== null) {
    try {
      await connection.removeProgramAccountChangeListener(listenerId);
      listenerId = null;
      logger.info('Solana token listener stopped.');
    } catch (error) {
      logger.error(`Error stopping token listener: ${(error as Error).message}`);
    }
  }
};
