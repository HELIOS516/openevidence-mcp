#!/usr/bin/env node
import "dotenv/config";

import { copyFile, writeFile, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

import { ensureConfigDirs, resolveConfig } from "./config.js";

const CDP_URL = "http://localhost:9222";

async function main() {
  const config = resolveConfig();
  ensureConfigDirs(config);
  const importPath = getArgValue("--import");

  if (importPath) {
    await copyFile(importPath, config.authStatePath);
    await verifyStateFile(config.baseUrl, config.authStatePath, config.userAgent);
    output.write(`[openevidence-mcp] imported and verified auth state: ${config.authStatePath}\n`);
    output.write(`[openevidence-mcp] success. You can now run: npm run smoke\n`);
    return;
  }

  output.write(`[openevidence-mcp] launching Chrome with remote debugging...\n`);
  output.write(`[openevidence-mcp] base URL: ${config.baseUrl}\n`);
  output.write(`[openevidence-mcp] profile dir: ${config.userDataDir}\n`);
  output.write(`[openevidence-mcp] auth state path: ${config.authStatePath}\n\n`);

  const alreadyListening = await isPortListening(9222);
  if (alreadyListening) {
    output.write(`[openevidence-mcp] WARNING: port 9222 is already in use — skipping Chrome launch, will connect to existing instance.\n`);
  }

  const chromePath = findChromePath();
  const chromeProc = alreadyListening
    ? null
    : spawn(
        chromePath,
        [
          `--remote-debugging-port=9222`,
          `--user-data-dir=${config.userDataDir}`,
          `--no-first-run`,
          `--no-default-browser-check`,
          `${config.baseUrl}/login`,
        ],
        { detached: true, stdio: "ignore" },
      );
  if (chromeProc) {
    chromeProc.unref();
  }

  output.write(
    [
      "1) Complete login in the opened Chrome window.",
      "2) After successful login, return here and press Enter.",
      "3) This will save a reusable local auth state for MCP.",
      "",
    ].join("\n"),
  );

  await waitForEnter("Press Enter when login is done...");

  // Give Chrome a moment to settle after user presses Enter
  await sleep(500);

  output.write(`[openevidence-mcp] extracting storage state via CDP...\n`);
  let storageState: unknown;
  try {
    storageState = await extractStorageStateViaCDP(config.baseUrl);
  } finally {
    if (chromeProc) {
      try {
        chromeProc.kill();
      } catch {
        // ignore kill errors
      }
    }
  }

  await writeFile(config.authStatePath, JSON.stringify(storageState, null, 2), "utf-8");
  await verifyStateFile(config.baseUrl, config.authStatePath, config.userAgent);
  output.write(`[openevidence-mcp] auth state saved: ${config.authStatePath}\n`);
  output.write(`[openevidence-mcp] success. You can now run: npm run smoke\n`);
}

async function extractStorageStateViaCDP(baseUrl: string): Promise<unknown> {
  // Connect via CDP using playwright-core (lightweight, no browser launch)
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(CDP_URL);

  try {
    const contexts = browser.contexts();
    const ctx = contexts[0];
    if (!ctx) {
      throw new Error("No browser context found via CDP. Is Chrome running with --remote-debugging-port=9222?");
    }
    const state = await ctx.storageState();
    return state;
  } finally {
    await browser.close();
  }
}

async function verifyStateFile(baseUrl: string, statePath: string, userAgent: string): Promise<void> {
  const raw = await readFile(statePath, "utf-8");
  const state = JSON.parse(raw) as {
    cookies: Array<{ name: string; value: string; domain: string }>;
  };

  const cookieHeader = state.cookies
    .filter(
      (c) =>
        c.domain === "www.openevidence.com" ||
        c.domain === ".openevidence.com" ||
        c.domain === "openevidence.com" ||
        c.domain === "auth.openevidence.com" ||
        c.domain === ".auth.openevidence.com",
    )
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Auth check failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

function findChromePath(): string {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];

  // Return first candidate that exists; if none found fall back to PATH
  for (const p of candidates) {
    try {
      statSync(p);
      return p;
    } catch {
      // not found, try next
    }
  }

  // Fallback: let the OS find it
  return "google-chrome";
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${prompt}\n`);
  } finally {
    rl.close();
  }
}

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex((v) => v === flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  output.write(`[openevidence-mcp] failed: ${message}\n`);
  process.exit(1);
});
