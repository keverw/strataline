/**
 * Simple script to update the README.md version from package.json
 * Can be run manually or added to version hooks
 */

import * as fs from "fs";
import * as path from "path";

// Get the project root directory
const rootDir = path.resolve(__dirname, "..");

// Read the package.json file
const packageJsonPath = path.join(rootDir, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

// Read the README.md file
const readmePath = path.join(rootDir, "README.md");
let readmeContent = fs.readFileSync(readmePath, "utf8");

// Update the version in the README.md file
const titleRegex = /^# Strataline v[0-9]+\.[0-9]+\.[0-9]+/m;
const newTitle = `# Strataline v${version}`;

if (titleRegex.test(readmeContent)) {
  readmeContent = readmeContent.replace(titleRegex, newTitle);
} else {
  // If the version format doesn't exist yet, replace the basic title
  readmeContent = readmeContent.replace(/^# Strataline/m, newTitle);
}

// Write the updated README.md file
fs.writeFileSync(readmePath, readmeContent);

console.log(`Updated README.md with version ${version}`);
