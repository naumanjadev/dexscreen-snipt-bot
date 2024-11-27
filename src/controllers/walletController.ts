// src/controllers/walletController.ts
import { Context } from 'grammy';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from '../utils/logger';
import {
  getUserWallet,
  createUserWallet,
  deleteUserWallet,
  getWalletBalance,
} from '../services/walletService';

export const handleWalletCommand = async (ctx: Context): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  const userWallet = await getUserWallet(userId);

  if (userWallet) {
    // User already has a wallet
    const balanceSol = await getWalletBalance(userWallet.publicKey);
    const responseMessage = `
You already have a wallet:

*Public Key:*
\`${userWallet.publicKey}\`

*Balance:*
\`${balanceSol} SOL\`

What would you like to do?
1. /delete_wallet - Delete your wallet
2. /main_menu - Go back to main menu
    `;
    await ctx.reply(responseMessage, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} viewed their wallet.`);
  } else {
    // User does not have a wallet, create one
    const newUserWallet = await createUserWallet(userId);
    const responseMessage = `
✅ Wallet Created Successfully!

*Public Key:*
\`${newUserWallet.publicKey}\`

**IMPORTANT:** Your encrypted private key has been securely stored. You can access your wallet using this bot.
    `;
    await ctx.reply(responseMessage, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} created a new wallet.`);
  }
};

export const handleDeleteWalletCommand = async (ctx: Context): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  const userWallet = await getUserWallet(userId);

  if (userWallet) {
    await deleteUserWallet(userId);
    await ctx.reply('🗑️ Your wallet has been deleted.');
    logger.info(`User ${userId} deleted their wallet.`);
  } else {
    await ctx.reply('You do not have a wallet to delete.');
  }
};

export const handleMainMenuCommand = async (ctx: Context): Promise<void> => {
  const welcomeMessage = `
Welcome back to the main menu! Please choose an option:
/wallet - Manage your Solana wallet
/detect_tokens - Start detecting new token issuances
/help - Show available commands
  `;
  await ctx.reply(welcomeMessage);
};
