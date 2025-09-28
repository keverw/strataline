// Load environment variables - this is only needed if you are using Node.js, Bun does not need it
// import 'dotenv/config'

import { RunStratalineCLI, createCLIConsoleLogger } from "../src/cli";

// For a real application, you would import your migrations
// This is just a placeholder - replace with your actual migrations
const migrations = [];

// Use the built-in CLI console logger
// You can customize this or implement your own logger if needed
const logger = createCLIConsoleLogger(true);

// Run the CLI with environment variables
RunStratalineCLI({
  migrations,
  loadFrom: "env",
  logger,
}).catch((error) => {
  console.error(`Failed to run CLI: ${error.message}`);
  process.exit(1);
});
