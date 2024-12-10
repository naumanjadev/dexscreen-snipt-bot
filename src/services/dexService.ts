import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteGetRequest,
  SwapPostRequest,
  QuoteResponse,
  SwapResponse,
} from '@jup-ag/api';
import { logger } from '../utils/logger';

/**
 * Performs a token swap using the Jupiter aggregator.
 * @param params - Parameters for the swap.
 * @returns A boolean indicating whether the swap was successful.
 */
export const swapTokens = async (params: {
  connection: Connection;
  walletKeypair: Keypair;
  sourceTokenMint: PublicKey;
  destinationTokenMint: PublicKey;
  amountInLamports: number;
}): Promise<boolean> => {
  try {
    const {
      connection,
      walletKeypair,
      sourceTokenMint,
      destinationTokenMint,
      amountInLamports,
    } = params;

    // Initialize Jupiter API client
    const jupiterApi = createJupiterApiClient();

    // Prepare the quote request
    const quoteRequest: QuoteGetRequest = {
      inputMint: sourceTokenMint.toBase58(),
      outputMint: destinationTokenMint.toBase58(),
      amount: amountInLamports,
      slippageBps: 50, // 0.5% slippage
    };

    logger.debug(`Jupiter Quote Request: ${JSON.stringify(quoteRequest, null, 2)}`);

    // Fetch quote
    const quoteResponse: QuoteResponse = await jupiterApi.quoteGet(quoteRequest);

    // Log the raw quote response for debugging
    logger.debug(`Raw Quote Response: ${JSON.stringify(quoteResponse, null, 2)}`);

    // Validate the quote response
    if (!quoteResponse) {
      logger.error('No quote received for the swap.');
      return false;
    }

    // Prepare the swap request
    const swapRequest: SwapPostRequest = {
      swapRequest: {
        quoteResponse, // Use the entire quote response
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true, // Automatically wrap and unwrap SOL if needed
      },
    };

    logger.debug(`Jupiter Swap Request: ${JSON.stringify(swapRequest, null, 2)}`);

    // Fetch the swap transaction
    const swapResponse: SwapResponse = await jupiterApi.swapPost(swapRequest);

    logger.debug(`Jupiter Swap Response: ${JSON.stringify(swapResponse, null, 2)}`);

    // Validate the swap response
    if (!swapResponse.swapTransaction) {
      logger.error('Failed to get swap transaction from Jupiter.');
      return false;
    }

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([walletKeypair]);

    // Send the transaction
    const txid = await connection.sendRawTransaction(transaction.serialize());

    logger.info(`Swap transaction sent. TXID: ${txid}`);

    // Confirm the transaction
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');

    if (confirmation.value.err) {
      logger.error('Transaction failed:', confirmation.value.err);
      return false;
    }

    logger.info(`Swap successful. Transaction ID: ${txid}`);
    return true;
  } catch (error: any) {
    logger.error(`Error performing token swap: ${error.message}`, error);
    return false;
  }
};
