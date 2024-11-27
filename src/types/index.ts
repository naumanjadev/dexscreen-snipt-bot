// src/types/index.ts
import { Context, SessionFlavor } from 'grammy';

export interface SessionData {
  awaitingInputFor?: string;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export interface TokenInfo {
  mintAddress: string;
}
