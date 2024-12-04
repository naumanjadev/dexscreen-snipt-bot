// src/types.ts
import { Context, SessionFlavor } from 'grammy';

export interface SessionData {
  awaitingInputFor?: string;
  awaitingConfirmation?: string;
  withdrawAddress?: string;
  withdrawAmount?: number;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export interface TokenInfo {
  mintAddress: string;
}
