// src/services/tokenMetadataService.ts

import { PublicKey, Connection } from '@solana/web3.js';
import { Metadata } from '@metaplex-foundation/mpl-token-metadata';
import { logger } from '../utils/logger';

/**
 * Fetches the metadata for a given token address from Solana.
 * @param tokenAddress The mint address of the token.
 * @param connection The Solana connection instance.
 * @returns Metadata or null if not found.
 */
export const fetchTokenMetadata = async (
  tokenAddress: string,
  connection: Connection
): Promise<Metadata | null> => {
  try {
    const mintPublicKey = new PublicKey(tokenAddress);
    const metadataPDA = await Metadata.getPDA(mintPublicKey);
    const metadata = await Metadata.load(connection, metadataPDA);
    logger.debug(`Fetched metadata for ${tokenAddress}: ${JSON.stringify(metadata, null, 2)}`);
    return metadata;
  } catch (error) {
    logger.error(`Error fetching metadata for token ${tokenAddress}: ${(error as Error).message}`);
    return null;
  }
};
