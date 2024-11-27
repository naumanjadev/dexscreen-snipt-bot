import { mongoose } from "@typegoose/typegoose";
import { config } from '../config';
import { logger } from '../utils/logger';

export const connectDB = async () => {
  try {
    await mongoose.connect(config.DATABASE, {
      dbName: config.DB_NAME,
      autoIndex: true,
    });
    logger.info("Connected to MongoDB");
  } catch (err) {
    logger.error("Failed to connect to MongoDB", err);
    process.exit(1);
  }
};
