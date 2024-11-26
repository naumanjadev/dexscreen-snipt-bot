// src/utils/logger.ts
import { createLogger, format, transports } from 'winston';
import { config } from '../config';

const { combine, timestamp, printf, colorize } = format;

// Define custom log format
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

// Create Winston logger instance
export const logger = createLogger({
  level: config.logLevel || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // Log errors to error.log
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    // Log all logs to combined.log
    new transports.File({ filename: 'logs/combined.log' })
  ]
});

// If not in production, also log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    })
  );
}
