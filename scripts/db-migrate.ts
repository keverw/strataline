// Load environment variables - this is only needed if you are using Node.js, Bun does not need it
// import 'dotenv/config'

import { RunStratalineCLI, createCLIConsoleLogger } from "../src/cli";

// For a real application, you would import your migrations
// This is just a placeholder - replace with your actual migrations
const migrations = [];

// Use the built-in CLI console logger
// You can customize this or implement your own logger if needed
const logger = createCLIConsoleLogger(true);

// Run the CLI with environment variables.
// The returned result carries a distinct exit code per outcome:
//   0 completed · 2 deferred · 3 locked · 4 aborted (1 = error, thrown below).
RunStratalineCLI({
  migrations,
  loadFrom: "env",
  logger,
})
  .then((result) => {
    process.exit(result.exitCode);
  })
  .catch((error) => {
    console.error(`Failed to run CLI: ${error.message}`);
    process.exit(1);
  });
