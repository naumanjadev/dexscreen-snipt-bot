// src/bots/telegramBot.ts
import { Bot, Context, session, SessionFlavor } from 'grammy';

// Extend the global object to include tokenListenerInitialized
declare global {
  var tokenListenerInitialized: boolean;
}
import { config } from '../config';
import { handleCreateWallet } from '../controllers/walletController';
import { logger } from '../utils/logger';

// Define session data (if needed in the future)
interface SessionData {}

type MyContext = Context & SessionFlavor<SessionData>;

export const createBot = (): Bot<MyContext> => {
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
  }

  const bot = new Bot<MyContext>(config.telegramBotToken);

  // Initialize session middleware
  bot.use(session({ initial: () => ({}) }));

  // /start command handler
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
Welcome to the Solana Trading Bot!

Please choose an option:
/create_wallet - Create a new Solana wallet
/detect_tokens - Start detecting new token issuances
/help - Show available commands
    `;
    await ctx.reply(welcomeMessage);
    logger.info(`User ${ctx.from?.id} started the bot.`);
  });

  // /help command handler
  bot.command('help', async (ctx) => {
    const helpMessage = `
Available Commands:
/start - Start the bot and see options
/create_wallet - Create a new Solana wallet
/detect_tokens - Start detecting new token issuances
    `;
    await ctx.reply(helpMessage);
  });

  // /create_wallet command handler
  bot.command('create_wallet', async (ctx) => {
    try {
      const { publicKey, encryptedPrivateKey } = handleCreateWallet();
      const responseMessage = `
✅ Wallet Created Successfully!

*Public Key:*
\`${publicKey}\`

*Encrypted Private Key:*
\`${encryptedPrivateKey}\`

**IMPORTANT:** Save your encrypted private key securely. You'll need it to access your wallet.
      `;
      await ctx.reply(responseMessage, { parse_mode: 'Markdown' });
      logger.info(`User ${ctx.from?.id} created a new wallet.`);
    } catch (error) {
      logger.error(`Error in /create_wallet: ${(error as Error).message}`);
      await ctx.reply('❌ Failed to create wallet. Please try again.');
    }
  });

  // /detect_tokens command handler
  bot.command('detect_tokens', async (ctx) => {
    try {
      // Initialize the token detection listener
      // Ensure that the listener is only initialized once
      if (!global.tokenListenerInitialized) {
        const { initializeSolanaListener } = await import('../controllers/tokenDetectionController');
        initializeSolanaListener();
        global.tokenListenerInitialized = true;
        await ctx.reply('📡 Token detection has been started.');
        logger.info(`User ${ctx.from?.id} started token detection.`);
      } else {
        await ctx.reply('📡 Token detection is already running.');
      }
    } catch (error) {
      logger.error(`Error in /detect_tokens: ${(error as Error).message}`);
      await ctx.reply('❌ Failed to start token detection.');
    }
  });

  // Handle unknown commands
  bot.on('message', async (ctx) => {
    const text = ctx.message.text;
    if (text && !text.startsWith('/')) {
      await ctx.reply('Please use the available commands. Type /help to see the list of commands.');
    } else {
      await ctx.reply('Unknown command. Type /help to see the list of commands.');
    }
  });

  // Error handling
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error(`Error while handling update ${ctx.update.update_id}: ${(err.error as Error).message}`);
  });

  return bot;
};
