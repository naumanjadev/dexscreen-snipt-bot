// src/services/userSettingsService.ts
import { UserSettings, IUserSettings } from '../models/userSettings';

/**
 * Retrieves user settings for a given user ID. Creates default settings if none exist.
 * @param userId - The unique identifier of the user.
 * @returns The user's settings.
 */
export const getUserSettings = async (userId: number): Promise<IUserSettings> => {
  try {
    let settings = await UserSettings.findOne({ userId });
    if (!settings) {
      settings = new UserSettings({ userId });
      await settings.save();
    }
    return settings;
  } catch (error) {
    console.error(`Error fetching user settings for user ${userId}:`, error);
    throw new Error('Unable to fetch user settings.');
  }
};

/**
 * Updates user settings with the provided partial updates.
 * @param userId - The unique identifier of the user.
 * @param updates - Partial settings to update.
 * @returns The updated user settings.
 */
export const updateUserSettings = async (
  userId: number,
  updates: Partial<IUserSettings>
): Promise<IUserSettings> => {
  try {
    const settings = await getUserSettings(userId);
    Object.assign(settings, updates);
    await settings.save();
    return settings;
  } catch (error) {
    console.error(`Error updating user settings for user ${userId}:`, error);
    throw new Error('Unable to update user settings.');
  }
};
