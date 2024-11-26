// helpers.ts
import crypto from 'crypto';

/**
 * @returns {string} The generated encryption key.
 */
export const generateEncryptionKey = (): string => {
  return crypto.randomBytes(32).toString('base64');
};

// Generate the encryption key
const encryptionKey = generateEncryptionKey();

// Log the generated key to the console
console.log('Generated Encryption Key:', encryptionKey);
