// src/services/userSettingsService.ts
import { UserSettings, IUserSettings } from '../models/userSettings';

export const getUserSettings = async (userId: number): Promise<IUserSettings> => {
  let settings = await UserSettings.findOne({ userId });
  if (!settings) {
    settings = new UserSettings({ userId });
    await settings.save();
  }
  return settings;
};

export const updateUserSettings = async (
  userId: number,
  updates: Partial<IUserSettings>
): Promise<IUserSettings> => {
  const settings = await getUserSettings(userId);
  Object.assign(settings, updates);
  await settings.save();
  return settings;
};
