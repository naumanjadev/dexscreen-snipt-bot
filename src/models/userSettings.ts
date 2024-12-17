// src/models/userSettings.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IUserSettings extends Document {
  userId: number;
  boostamount: number | null; // In SOL
  buyamount: number | null; // In SOL
}

const UserSettingsSchema: Schema = new Schema({
  userId: { type: Number, required: true, unique: true },
  boostamount: { type: Number, default: null },
  buyamount: { type: Number, default: null },
});

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);
