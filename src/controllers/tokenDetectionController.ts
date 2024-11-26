// src/controllers/tokenDetectionController.ts
import { Connection, PublicKey, ParsedAccountData } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import axios from 'axios';

let connection: Connection;

export const initializeSolanaListener = (): void => {
  connection = new Connection(config.solanaRpcUrl, 'confirmed');
  logger.info('Solana connection initialized for token detection.');

  // SPL Token Program ID
  const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  connection.onProgramAccountChange(
    SPL_TOKEN_PROGRAM_ID,
    (keyedAccountInfo) => {
      const accountId = keyedAccountInfo.accountId.toBase58();
      const accountInfo = keyedAccountInfo.accountInfo.data;

      // Parse the account data to check if it's a new token issuance
      // For simplicity, we'll log the new token's public key
      logger.info(`New token detected: ${accountId}`);

      // Here, you can add further logic to fetch token metadata, apply filters, etc.
    },
    'confirmed'
  );

  logger.info('Solana token listener initialized and running.');
};
