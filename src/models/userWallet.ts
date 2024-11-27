// src/models/userWallet.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IUserWallet extends Document {
  userId: number;
  publicKey: string;
  encryptedPrivateKey: string;
}

const UserWalletSchema: Schema = new Schema({
  userId: { type: Number, required: true, unique: true },
  publicKey: { type: String, required: true },
  encryptedPrivateKey: { type: String, required: true },
});

export const UserWallet = mongoose.model<IUserWallet>('UserWallet', UserWalletSchema);
