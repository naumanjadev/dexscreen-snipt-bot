// src/services/tokenMetadataService.ts

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_METADATA_PROGRAM_ID } from './constants'; // Ensure the correct path
import { config } from '../config';
import { logger } from '../utils/logger';
import { deserialize } from 'borsh';

/**
 * Creator Class
 * Represents a creator of the token metadata.
 */
class Creator {
  address: string;
  verified: boolean;
  share: number;

  constructor(fields: { address: string; verified: boolean; share: number }) {
    this.address = fields.address;
    this.verified = fields.verified;
    this.share = fields.share;
  }
}

/**
 * Data Class
 * Contains the core metadata information of the token.
 */
class Data {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: Creator[] | null;

  constructor(fields: {
    name: string;
    symbol: string;
    uri: string;
    sellerFeeBasisPoints: number;
    creators: Creator[] | null;
  }) {
    this.name = fields.name;
    this.symbol = fields.symbol;
    this.uri = fields.uri;
    this.sellerFeeBasisPoints = fields.sellerFeeBasisPoints;
    this.creators = fields.creators;
  }
}

/**
 * Metadata Class
 * Represents the full metadata structure of a token.
 */
class Metadata {
  key: number;
  updateAuthority: string;
  mint: string;
  data: Data;
  primarySaleHappened: boolean;
  isMutable: boolean;

  constructor(fields: {
    key: number;
    updateAuthority: string;
    mint: string;
    data: Data;
    primarySaleHappened: boolean;
    isMutable: boolean;
  }) {
    this.key = fields.key;
    this.updateAuthority = fields.updateAuthority;
    this.mint = fields.mint;
    this.data = fields.data;
    this.primarySaleHappened = fields.primarySaleHappened;
    this.isMutable = fields.isMutable;
  }
}

/**
 * Borsh Schema Definitions
 * Defines how to deserialize the raw account data into structured Metadata objects.
 */
const METADATA_SCHEMA = new Map<any, any>([
  [
    Metadata,
    {
      kind: 'struct',
      fields: [
        ['key', 'u8'],
        ['updateAuthority', 'string'],
        ['mint', 'string'],
        ['data', Data],
        ['primarySaleHappened', 'u8'],
        ['isMutable', 'u8'],
      ],
    },
  ],
  [
    Data,
    {
      kind: 'struct',
      fields: [
        ['name', 'string'],
        ['symbol', 'string'],
        ['uri', 'string'],
        ['sellerFeeBasisPoints', 'u16'],
        ['creators', { kind: 'option', type: [Creator] }],
      ],
    },
  ],
  [
    Creator,
    {
      kind: 'struct',
      fields: [
        ['address', 'string'],
        ['verified', 'u8'],
        ['share', 'u8'],
      ],
    },
  ],
]);

/**
 * decodeMetadata Function
 * Deserializes raw account data into a Metadata object using the Borsh schema.
 *
 * @param buffer - The raw account data buffer.
 * @returns A Metadata object or null if decoding fails.
 */
const decodeMetadata = (buffer: Buffer): Metadata | null => {
  try {
    const metadata = deserialize(METADATA_SCHEMA, Metadata, buffer);
    return metadata;
  } catch (error) {
    logger.error(`Failed to decode metadata: ${(error as Error).message}`);
    return null;
  }
};

// Initialize the Solana connection using the RPC URL from the configuration.
export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');

/**
 * fetchTokenMetadata Function
 * Fetches and decodes the metadata of a token given its mint address.
 *
 * @param mintAddress - The mint address of the token.
 * @returns An object containing the token's name and symbol, or null if not found.
 */
export const fetchTokenMetadata = async (
  mintAddress: string
): Promise<{ name: string; symbol: string } | null> => {
  try {
    const mintPublicKey = new PublicKey(mintAddress);

    // Compute the PDA (Program Derived Address) for the metadata account
    const [metadataPDA, bump] = await PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'), // Seed
        TOKEN_METADATA_PROGRAM_ID.toBuffer(), // Program ID
        mintPublicKey.toBuffer(), // Mint Address
      ],
      TOKEN_METADATA_PROGRAM_ID // Program ID
    );

    // Fetch the account information from the blockchain
    const accountInfo = await connection.getAccountInfo(metadataPDA);

    if (!accountInfo) {
      logger.warn(`No metadata account found for mint address: ${mintAddress}`);
      return null;
    }

    // Decode the metadata
    const metadata = decodeMetadata(accountInfo.data);

    if (!metadata) {
      logger.warn(`Failed to decode metadata for mint address: ${mintAddress}`);
      return null;
    }

    const name = metadata.data.name.trim(); // Trim to remove padding
    const symbol = metadata.data.symbol.trim();

    logger.debug(
      `Fetched metadata for ${mintAddress}: Name - ${name}, Symbol - ${symbol}`
    );

    return { name, symbol };
  } catch (error) {
    logger.error(
      `Error fetching token metadata for ${mintAddress}: ${
        (error as Error).message
      }`
    );
    return null;
  }
};
