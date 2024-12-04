// src/controllers/walletController.ts
import { MyContext } from '../types';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger';
import {
  getUserWallet,
  createUserWallet,
  deleteUserWallet,
  getWalletBalance,
  loadUserKeypair,
  sendSol,
} from '../services/walletService';
import bs58 from 'bs58';

function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const handleWalletCommand = async (ctx: MyContext): Promise<void> => {
  ctx.session.awaitingInputFor = undefined;
  ctx.session.awaitingConfirmation = undefined;

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
✨ <b>Your Solana Wallet</b> ✨

<b>📬 Wallet Address:</b>
<code>${escapeHTML(userWallet.publicKey)}</code>

<b>💰 Balance:</b>
<code>${escapeHTML(balanceSol.toString())} SOL</code>

What would you like to do?
/withdraw - Withdraw funds
/export_wallet - Export your private key ⚠️ Not Recommended
/delete_wallet - Delete your wallet
/main_menu - Go back to main menu
    `;
    await ctx.reply(responseMessage, { parse_mode: 'HTML' });
    logger.info(`User ${userId} viewed their wallet.`);
  } else {
    // User does not have a wallet, create one
    const newUserWallet = await createUserWallet(userId);
    const responseMessage = `
✅ <b>Wallet Created Successfully!</b>

<b>📬 Public Key:</b>
<code>${escapeHTML(newUserWallet.publicKey)}</code>

<b>IMPORTANT:</b> Your encrypted private key has been securely stored. You can access your wallet using this bot.
    `;
    await ctx.reply(responseMessage, { parse_mode: 'HTML' });
    logger.info(`User ${userId} created a new wallet.`);
  }
};

export const handleDeleteWalletCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  const userWallet = await getUserWallet(userId);

  if (userWallet) {
    if (!ctx.session.awaitingConfirmation) {
      // Initiate deletion process
      await ctx.reply(
        '⚠️ Are you sure you want to delete your wallet? This action is irreversible and you will lose all your funds.\n\nPlease type "DELETE" to confirm or /cancel to abort.'
      );
      ctx.session.awaitingConfirmation = 'delete_wallet';
    } else if (ctx.session.awaitingConfirmation === 'delete_wallet') {
      const input = ctx.message?.text?.trim().toUpperCase();
      if (input === 'DELETE') {
        // User confirmed deletion
        await deleteUserWallet(userId);
        await ctx.reply('🗑️ Your wallet has been permanently deleted.');
        logger.info(`User ${userId} deleted their wallet.`);
        ctx.session.awaitingConfirmation = undefined;
      } else {
        await ctx.reply('Deletion cancelled.');
        ctx.session.awaitingConfirmation = undefined;
      }
    }
  } else {
    await ctx.reply('You do not have a wallet to delete.');
  }
};

export const handleExportWalletCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  const userWallet = await getUserWallet(userId);
  if (!userWallet) {
    await ctx.reply('You do not have a wallet to export.');
    return;
  }

  if (!ctx.session.awaitingConfirmation) {
    await ctx.reply(
      '⚠️ Exporting your private key can be risky and may lead to loss of funds. Do you still want to proceed?\n\nPlease type "EXPORT" to confirm or /cancel to abort.'
    );
    ctx.session.awaitingConfirmation = 'export_wallet';
  } else if (ctx.session.awaitingConfirmation === 'export_wallet') {
    const input = ctx.message?.text?.trim().toUpperCase();
    if (input === 'EXPORT') {
      // Decrypt the private key
      const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);
      const privateKeyBase58 = bs58.encode(keypair.secretKey);

      // Send the private key and delete the message after 30 seconds
      const message = await ctx.reply(
        `🔑 <b>Your Private Key (Keep it Secret!)</b>\n<code>${escapeHTML(
          privateKeyBase58
        )}</code>\n\nThis message will self-destruct in 30 seconds.`,
        { parse_mode: 'HTML' }
      );

      // Schedule message deletion
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(ctx.chat?.id!, message.message_id);
        } catch (error) {
          logger.error(`Failed to delete message: ${(error as Error).message}`);
        }
      }, 30000);

      ctx.session.awaitingConfirmation = undefined;
    } else {
      await ctx.reply('Export cancelled.');
      ctx.session.awaitingConfirmation = undefined;
    }
  }
};

export const handleWithdrawCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  const userWallet = await getUserWallet(userId);
  if (!userWallet) {
    await ctx.reply('You need to create a wallet first using /wallet.');
    return;
  }

  // Ask the user for the destination address
  ctx.session.awaitingInputFor = 'withdraw_address';
  await ctx.reply('📤 Please enter the Solana wallet address you want to withdraw to:');
};

export const handleWithdrawAmountInput = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  const input = ctx.message?.text?.trim();

  if (!input) {
    await ctx.reply('❌ Invalid input. Please enter a valid amount:');
    return;
  }

  const amount = parseFloat(input);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Please enter a valid amount greater than 0:');
    return;
  }

  // Save the amount in session and ask for confirmation
  ctx.session.withdrawAmount = amount;
  await ctx.reply(
    `You are about to withdraw <b>${escapeHTML(amount.toString())} SOL</b> to address:\n<code>${escapeHTML(
      ctx.session.withdrawAddress!
    )}</code>\n\nType "yes" to proceed or /cancel to abort.`,
    { parse_mode: 'HTML' }
  );
  ctx.session.awaitingConfirmation = 'withdraw';
  ctx.session.awaitingInputFor = undefined;
};

export const handleConfirmWithdraw = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;
  const { withdrawAddress, withdrawAmount } = ctx.session;

  if (!withdrawAddress || typeof withdrawAmount !== 'number') {
    await ctx.reply('❌ No pending withdrawal found.');
    return;
  }

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  // Proceed with the withdrawal
  try {
    const userWallet = await getUserWallet(userId);
    if (!userWallet) {
      await ctx.reply('You need to create a wallet first using /wallet.');
      return;
    }

    const keypair = loadUserKeypair(userWallet.encryptedPrivateKey);

    await sendSol(keypair, withdrawAddress, withdrawAmount);

    await ctx.reply(
      `✅ Successfully withdrawn <b>${escapeHTML(
        withdrawAmount.toString()
      )} SOL</b> to address:\n<code>${escapeHTML(withdrawAddress)}</code>`,
      { parse_mode: 'HTML' }
    );
    logger.info(`User ${userId} withdrew ${withdrawAmount} SOL to ${withdrawAddress}.`);
  } catch (error) {
    logger.error(`Withdrawal error for user ${userId}: ${(error as Error).message}`);
    await ctx.reply('❌ Withdrawal failed. Please try again later.');
  }

  // Clear session data
  ctx.session.withdrawAddress = undefined;
  ctx.session.withdrawAmount = undefined;
  ctx.session.awaitingConfirmation = undefined;
};

export const handleCancel = async (ctx: MyContext): Promise<void> => {
  ctx.session.awaitingInputFor = undefined;
  ctx.session.awaitingConfirmation = undefined;
  ctx.session.withdrawAddress = undefined;
  ctx.session.withdrawAmount = undefined;
  await ctx.reply('🚫 Action cancelled.');
};

export const handleMainMenuCommand = async (ctx: MyContext): Promise<void> => {
  const welcomeMessage = `
🏠 <b>Main Menu</b>

Please choose an option:
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/start_listener - Start token detection
/help - Show available commands
  `;
  await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
};
