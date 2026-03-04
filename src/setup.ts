import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTAINER_NAME = "searxng";
const PORT = 8080;
const IMAGE = "searxng/searxng";
const SEARXNG_URL = `http://localhost:${PORT}`;
const CONFIG_DIR = path.join(__dirname, "..", "config", "searxng");

const SETTINGS_YAML = `\
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  secret_key: "swarm-research-dev-key"
  limiter: false
`;

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function checkDocker(): boolean {
  const version = run("docker --version");
  if (!version) {
    console.error("Docker is not installed or not in PATH.");
    console.error("Install Docker: https://docs.docker.com/get-docker/");
    return false;
  }
  console.log(`Found ${version}`);

  const running = run("docker info");
  if (!running) {
    console.error("Docker daemon is not running. Start Docker and try again.");
    return false;
  }

  return true;
}

function isContainerRunning(): boolean {
  const status = run(
    `docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME} 2>/dev/null`
  );
  return status === "true";
}

function containerExists(): boolean {
  const id = run(`docker ps -aq -f name=^${CONTAINER_NAME}$`);
  return id.length > 0;
}

function ensureConfig(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const settingsPath = path.join(CONFIG_DIR, "settings.yml");
  fs.writeFileSync(settingsPath, SETTINGS_YAML, "utf-8");
  console.log(`Config written to ${settingsPath}`);
}

async function waitForApi(maxAttempts = 20): Promise<boolean> {
  const testUrl = `${SEARXNG_URL}/search?q=test&format=json&categories=general`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(testUrl);
      if (res.ok) {
        const data = (await res.json()) as { results?: unknown[] };
        if (data.results) {
          return true;
        }
      }
    } catch {
      // not ready yet
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}

async function main() {
  console.log("=== SearXNG Setup ===\n");

  // 1. Check Docker
  if (!checkDocker()) {
    process.exit(1);
  }

  // 2. Write config files
  ensureConfig();

  // 3. Check if already running
  if (isContainerRunning()) {
    console.log(`\nSearXNG container '${CONTAINER_NAME}' is already running.`);
  } else if (containerExists()) {
    console.log(`\nStarting existing SearXNG container...`);
    execSync(`docker start ${CONTAINER_NAME}`, { stdio: "inherit" });
  } else {
    console.log(`\nPulling SearXNG image...`);
    execSync(`docker pull ${IMAGE}`, { stdio: "inherit" });

    console.log(`\nStarting SearXNG container on port ${PORT}...`);
    execSync(
      [
        "docker run -d",
        `--name ${CONTAINER_NAME}`,
        `-p ${PORT}:8080`,
        `-v ${CONFIG_DIR}/settings.yml:/etc/searxng/settings.yml:ro`,
        `--restart unless-stopped`,
        IMAGE,
      ].join(" "),
      { stdio: "inherit" }
    );
  }

  // 4. Wait for API to be ready
  process.stdout.write("\nWaiting for SearXNG API to be ready");
  const ready = await waitForApi();

  if (ready) {
    console.log(" ready!\n");
    console.log(`SearXNG is running at: ${SEARXNG_URL}`);
    console.log(`API endpoint: ${SEARXNG_URL}/search?q=your+query&format=json`);
    console.log(`\nMake sure your .env has: SEARXNG_URL=${SEARXNG_URL}`);
  } else {
    console.log(" timed out.\n");
    console.error("SearXNG did not respond in time. Check the container logs:");
    console.error(`  docker logs ${CONTAINER_NAME}`);
    process.exit(1);
  }
}

main();
