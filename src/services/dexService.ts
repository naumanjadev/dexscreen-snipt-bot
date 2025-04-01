import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionSignature,
  Commitment,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteGetRequest,
  SwapPostRequest,
  QuoteResponse,
  SwapResponse,
} from '@jup-ag/api';
import { logger } from '../utils/logger';

/**
 * Confirms a transaction with retries.
 * @param connection 
 * @param txid 
 * @param maxRetries 
 * @param delayMs 
 * @returns 
 */
async function confirmTransactionWithRetry(
  connection: Connection,
  txid: TransactionSignature,
  maxRetries: number = 3,
  delayMs: number = 10000
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const confirmation = await connection.confirmTransaction(txid, 'finalized' as Commitment);
      if (confirmation.value.err) {
        logger.error(`Transaction ${txid} failed: ${JSON.stringify(confirmation.value.err)}`);
        return false;
      }
      return true;
    } catch (err: any) {
      logger.warn(`Attempt ${i + 1} to confirm transaction ${txid} failed: ${err.message}`);
      if (i < maxRetries - 1) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
  return false;
}

/**
 * Performs a token swap using the Jupiter aggregator.
 * @param params - Parameters for the swap.
 * @returns A result object containing success status and transaction ID if successful.
 */
export const swapTokens = async (params: {
  connection: Connection;
  walletKeypair: Keypair;
  sourceTokenMint: PublicKey;
  destinationTokenMint: PublicKey;
  amountInLamports: number;
  slippage?: number;
  priorityFee?: boolean;
}): Promise<{ success: boolean; txId?: string; error?: string }> => {
  const { 
    connection, 
    walletKeypair, 
    sourceTokenMint, 
    destinationTokenMint, 
    amountInLamports,
    slippage = 1.0,
    priorityFee = false
  } = params;

  try {
    // Initialize Jupiter API client
    const jupiterApi = createJupiterApiClient();

    // Prepare the quote request
    const quoteRequest: QuoteGetRequest = {
      inputMint: sourceTokenMint.toBase58(),
      outputMint: destinationTokenMint.toBase58(),
      amount: amountInLamports,
      // Convert percentage to basis points (1% = 100 bps)
      slippageBps: Math.round(slippage * 100),
    };

    logger.debug(`Jupiter Quote Request: ${JSON.stringify(quoteRequest, null, 2)}`);

    let quoteResponse: QuoteResponse | null = null;
    try {
      quoteResponse = await jupiterApi.quoteGet(quoteRequest);
    } catch (err: any) {
      logger.error(`Failed to fetch quote from Jupiter: ${err.message}`);
      if (err.response && err.response.data) {
        logger.error(`Jupiter API Error: ${JSON.stringify(err.response.data, null, 2)}`);
      }
      return { success: false, error: `Failed to fetch quote: ${err.message}` };
    }

    logger.debug(`Raw Quote Response: ${JSON.stringify(quoteResponse, null, 2)}`);

    // Check if we got a valid route
    if (!quoteResponse) {
      logger.error('No valid swap routes found for the given token pair.');
      return { success: false, error: 'No valid swap routes found' };
    }

    // Prepare the swap request with proper parameters for memecoin trading
    const swapRequest: SwapPostRequest = {
      swapRequest: {
        quoteResponse,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true, // Always wrap/unwrap SOL for memecoins
        dynamicComputeUnitLimit: true, // Use dynamic compute units for better success rate
        // Use dynamic slippage with a max defined by the user (or default)
        dynamicSlippage: {
          // Allow up to 2x the specified slippage in extreme cases, but not more than 50%
          maxBps: Math.min(Math.round(slippage * 200), 5000)
        },
      },
    };

    // Only add priority fee if requested - memecoin transactions often need this
    if (priorityFee) {
      swapRequest.swapRequest.prioritizationFeeLamports = {
        priorityLevelWithMaxLamports: {
          maxLamports: 10000000, // 0.01 SOL max
          priorityLevel: "veryHigh",
        },
      };
    }

    logger.debug(`Jupiter Swap Request: ${JSON.stringify(swapRequest, null, 2)}`);

    let swapResponse: SwapResponse | null = null;
    try {
      swapResponse = await jupiterApi.swapPost(swapRequest);
    } catch (err: any) {
      logger.error(`Failed to execute swap on Jupiter: ${err.message}`);
      if (err.response && err.response.data) {
        logger.error(`Jupiter API Error: ${JSON.stringify(err.response.data, null, 2)}`);
      }
      return { success: false, error: `Failed to execute swap: ${err.message}` };
    }

    logger.debug(`Jupiter Swap Response: ${JSON.stringify(swapResponse, null, 2)}`);

    if (!swapResponse || !swapResponse.swapTransaction) {
      logger.error('Failed to get swap transaction from Jupiter.');
      return { success: false, error: 'Failed to get swap transaction' };
    }

    // Deserialize the transaction
    let transaction: VersionedTransaction;
    try {
      const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
      transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    } catch (err: any) {
      logger.error(`Failed to deserialize the swap transaction: ${err.message}`);
      return { success: false, error: `Failed to deserialize transaction: ${err.message}` };
    }

    // Sign the transaction
    transaction.sign([walletKeypair]);

    // Simulate transaction before sending
    try {
      const simulationResult = await connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: true,
        commitment: "processed",
      });

      const { err, logs } = simulationResult.value;
      if (err) {
        logger.error('Transaction simulation failed:', err, logs);
        return { success: false, error: `Simulation failed: ${JSON.stringify(err)}` };
      }
    } catch (simulateErr: any) {
      logger.error(`Failed to simulate transaction: ${simulateErr.message}`);
      return { success: false, error: `Simulation error: ${simulateErr.message}` };
    }

    // Send the transaction
    let txid: string;
    try {
      txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
    } catch (err: any) {
      logger.error(`Failed to send transaction: ${err.message}`);
      return { success: false, error: `Send error: ${err.message}` };
    }

    logger.info(`Swap transaction sent. TXID: ${txid}`);

    // Confirm the transaction with retries
    const confirmed = await confirmTransactionWithRetry(connection, txid, 3, 10000);
    if (!confirmed) {
      logger.error(`Transaction ${txid} was not confirmed after multiple attempts.`);
      return { success: false, error: 'Transaction not confirmed', txId: txid };
    }

    logger.info(`Swap successful. Transaction ID: ${txid}`);
    return { success: true, txId: txid };
  } catch (error: any) {
    logger.error(`Error performing token swap: ${error.message}`, error);
    return { success: false, error: error.message };
  }
};
