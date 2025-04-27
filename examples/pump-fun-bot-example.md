# Pump.fun Trading Bot Example Guide

This guide demonstrates how to use the Pump.fun trading bot functionality in the Solana Trading Bot.

## Getting Started

First, start a conversation with the bot and create your wallet using the `/wallet` command.

## Basic Commands

Here are the basic commands for the Pump.fun trading bot:

- `/start_pumpfun` - Start listening for new Pump.fun tokens
- `/stop_pumpfun` - Stop the Pump.fun listener
- `/start_pumpfun_trading` - Activate automatic trading
- `/pumpfun_settings` - View and update settings
- `/pumpfun_status` - Check current status and trades
- `/pumpfun_token_filter` - Set name/symbol filter

## Setting Up Automatic Trading

Follow these steps to set up automatic trading:

1. Start the Pump.fun listener:
   ```
   /start_pumpfun
   ```

2. Configure your trading settings:
   ```
   /pumpfun_settings
   ```

3. Set the minimum boost amount (in USD):
   ```
   /pumpfun_min_boost
   5.0
   ```

4. Set the amount of SOL to spend per trade:
   ```
   /pumpfun_buy_amount
   0.1
   ```

5. Configure profit target percentage:
   ```
   /pumpfun_profit_target
   30
   ```

6. Set stop loss percentage:
   ```
   /pumpfun_stop_loss
   15
   ```

7. Set maximum hold time (in minutes):
   ```
   /pumpfun_max_hold_time
   60
   ```

8. Enable auto-sell:
   ```
   /pumpfun_auto_sell
   yes
   ```

9. Add a name filter (optional):
   ```
   /pumpfun_token_filter
   doge
   ```

10. Start automatic trading:
    ```
    /start_pumpfun_trading
    ```

## How It Works

The bot monitors the Pump.fun platform for new token launches. When a new token is detected, it:

1. Notifies you of the token details (name, symbol, price, bonding curve progress)
2. If trading is enabled and the token meets your criteria (boost amount, name filter), it automatically purchases the token
3. After purchase, it monitors the token price and sells when:
   - Profit target is reached
   - Stop loss is triggered
   - Bonding curve reaches 95% (near migration to Raydium)
   - Maximum hold time is exceeded

## Viewing Your Trading Status

To check your current trading status and history:

```
/pumpfun_status
```

This will show:
- Current mode (monitoring or trading)
- Your settings
- Trading activity (buys/sells)
- Recent trades with timestamps

## Advanced Settings

Additional settings you can configure:

- `/pumpfun_slippage` - Set slippage tolerance percentage
- `/pumpfun_priority_fee` - Enable/disable priority fees

## Example Trade Workflow

1. Receive notification about a new token:
   ```
   🚀 New Token Detected!

   Name: DOGE PEPE
   Symbol: DOGPE
   Address: Gvs35ryrM3dDZMbu4iX7L3T2obmUaLQTaFjHkS6ypump
   Price: 0.00000123 SOL
   Bonding Progress: 12.45%
   Boost Amount: $8.50
   ```

2. Bot automatically buys the token (if trading is enabled and criteria met):
   ```
   ✅ Buy Successful!

   Token: DOGE PEPE (DOGPE)
   Amount: 0.1 SOL
   Price: 0.00000123 SOL
   Transaction: View on Solscan
   ```

3. Later, bot automatically sells when conditions are met:
   ```
   💰 Sell Successful!

   Token: DOGE PEPE (DOGPE)
   Price: 0.00000162 SOL
   Price Change: +31.7%
   Reason: Profit target reached
   Transaction: View on Solscan
   ```

## Stopping the Bot

To stop the Pump.fun listener and trading:

```
/stop_pumpfun
```

This will completely stop all Pump.fun monitoring and trading activities.

## Additional Notes

- The bot uses the on-chain bonding curve data to calculate accurate token prices
- It monitors the bonding curve progress to detect when tokens are nearing migration to Raydium
- Priority fees are recommended for faster transactions during high network congestion
- You can filter tokens by name or symbol to focus on specific types of memecoins 