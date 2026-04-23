import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const envFiles = [".env", ".env.local"];
const defaultConfig = {
  MIRU_BACKEND_URL: "http://localhost:3001",
};

function parseEnv(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .reduce((accumulator, line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, "");
      accumulator[key] = value;
      return accumulator;
    }, {});
}

const mergedConfig = { ...defaultConfig };

for (const fileName of envFiles) {
  const filePath = path.join(rootDir, fileName);
  if (!fs.existsSync(filePath)) {
    continue;
  }

  const parsed = parseEnv(fs.readFileSync(filePath, "utf8"));
  Object.assign(mergedConfig, parsed);
}

const outputPath = path.join(rootDir, "src/generated/runtime-config.ts");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `/**
 * Generated file. Run \`npm run build\` after editing .env or .env.local.
 */

export const MIRU_BACKEND_URL = ${JSON.stringify(mergedConfig.MIRU_BACKEND_URL)};
`,
  "utf8"
);

console.log(`[Miru] Generated extension runtime config at ${outputPath}`);
