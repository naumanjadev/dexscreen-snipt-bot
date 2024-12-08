import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createJupiterApiClient, QuoteGetRequest, SwapRequest } from '@jup-ag/api';

/**
 * Performs a token swap using the Jupiter aggregator.
 * @param params - Parameters for the swap.
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
      amount: amountInLamports, // 'amount' should be a number
      slippageBps: 50, // 0.5% slippage
    };

    // Fetch quote
    const quoteResponse = await jupiterApi.quoteGet(quoteRequest);

    if (!quoteResponse) {
      console.error('No routes found for the swap.');
      return false;
    }

    // Use the quoteResponse as the best quote
    const bestQuote = quoteResponse;

    // Prepare the swap request
    const swapRequest: SwapRequest = {
      quoteResponse: bestQuote, // Use 'quoteResponse' instead of 'route'
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true, // Automatically wrap and unwrap SOL if needed
    };

    // Fetch the swap transaction
    const swapResponse = await jupiterApi.swapPost({ swapRequest }); // Pass 'swapRequest' inside an object

    if (!swapResponse.swapTransaction) {
      console.error('Failed to get swap transaction.');
      return false;
    }

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = Transaction.from(swapTransactionBuf);

    // Sign the transaction
    transaction.partialSign(walletKeypair);

    // Send the transaction
    const txid = await connection.sendRawTransaction(transaction.serialize());

    // Confirm the transaction
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');

    if (confirmation.value.err) {
      console.error('Transaction failed:', confirmation.value.err);
      return false;
    }

    console.log('Swap successful:', txid);
    return true;
  } catch (error: any) {
    console.error('Error performing token swap:', error.message, error.stack);
    return false;
  }
};
