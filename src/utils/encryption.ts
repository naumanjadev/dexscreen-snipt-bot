// src/utils/encryption.ts
import crypto from 'crypto';
import { config } from '../config';
import { logger } from './logger';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // AES block size

if (config.encryptionKey.length !== 44) { // Base64 encoded 32 bytes
  logger.error('ENCRYPTION_KEY must be a 32-byte base64 string.');
  process.exit(1);
}

const key = Buffer.from(config.encryptionKey, 'base64');

export const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

export const decrypt = (text: string): string => {
  const textParts = text.split(':');
  if (textParts.length !== 2) {
    logger.error('Invalid encrypted text format.');
    throw new Error('Invalid encrypted text format.');
  }
  const iv = Buffer.from(textParts[0], 'hex');
  const encryptedText = textParts[1];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};
