import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as github from "@actions/github";
import { join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import semver from "semver";
import process from "node:process";
import { $ } from "execa";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";

const requestedVersion =
  core.getInput("gh-version") || core.getInput("version") || "latest";
const switchAccount = core.getBooleanInput("switch-account");
const skipMatchingVersion = core.getBooleanInput("skip-matching-version");

async function getInstalledVersion() {
  try {
    const { stdout } = await $`gh --version`;
    return stdout.match(/^gh version ([^\s]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function matchesRequestedVersion(installedVersion: string, resolvedVersion?: string) {
  const cleanVersion = semver.clean(installedVersion);
  if (!cleanVersion) return false;
  if (requestedVersion === "latest") return cleanVersion === resolvedVersion;

  const validRange = semver.validRange(requestedVersion);
  if (validRange) return semver.satisfies(cleanVersion, validRange);

  return cleanVersion === resolvedVersion;
}

async function resolveVersion(version: string) {
  const octokit = core.getInput("cli-token")
    ? github.getOctokit(core.getInput("cli-token"))
    : github.getOctokit(undefined!, {
        authStrategy: createUnauthenticatedAuth,
        auth: { reason: "no 'cli-token' input" },
      });

  if (version === "latest") {
    const { data } = await octokit.rest.repos.getLatestRelease({
      owner: "cli",
      repo: "cli",
    });
    return data.tag_name.slice(1);
  }

  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner: "cli",
    repo: "cli",
  });
  const versions = releases.map((release) => release.tag_name.slice(1));
  return semver.maxSatisfying(versions, version) ?? "2.28.0";
}

async function installGh(version: string) {
  const platformTypes: Partial<Record<NodeJS.Platform, string>> = {
    linux: "linux",
    darwin: "macOS",
    win32: "windows",
  };

  const archTypes: Partial<Record<NodeJS.Architecture, string>> = {
    x64: "amd64",
    arm: "arm",
    arm64: "arm64",
  };

  const extByPlatform: Partial<Record<NodeJS.Platform, string>> = {
    linux: "tar.gz",
    darwin: semver.lt(version, "2.28.0") ? "tar.gz" : "zip",
    win32: "zip",
  };

  const platform = platformTypes[process.platform] ?? "linux";
  const arch = archTypes[process.arch] ?? "amd64";
  const ext = extByPlatform[process.platform] ?? "tar.gz";
  const folderName = `gh_${version}_${platform}_${arch}`;
  const zipFileName = `${folderName}.${ext}`;
  const downloadUrl = `https://github.com/cli/cli/releases/download/v${version}/${zipFileName}`;
  const binFileName = platform === "windows" ? "gh.exe" : "gh";

  let found = tc.find("gh", version);
  core.setOutput("cache-hit", !!found);
  if (!found) {
    core.debug(`Downloading GH CLI ${version} from ${downloadUrl} ...`);
    const downloadedFile = await tc.downloadTool(downloadUrl);
    core.debug(`Downloaded GH CLI ${version} to ${downloadedFile}`);
    found =
      ext === "zip"
        ? await tc.extractZip(downloadedFile)
        : await tc.extractTar(downloadedFile);
    found = await tc.cacheDir(found, "gh", version);
    core.debug(`Cached GH CLI ${version} to ${found}`);
  } else {
    core.debug(`Using cached GH CLI ${version} from ${found}`);
  }

  const bin0Dir = found;
  const bin1Dir = join(found, "bin");
  const bin2Dir = join(found, folderName, "bin");
  const bin0Path = join(bin0Dir, binFileName);
  const bin1Path = join(bin1Dir, binFileName);
  const bin2Path = join(bin2Dir, binFileName);

  let binDir: string;
  if (existsSync(bin0Path)) {
    core.debug(`Found GH CLI binary in ${bin0Dir}`);
    binDir = bin0Dir;
  } else if (existsSync(bin1Path)) {
    core.debug(`Found GH CLI binary in ${bin1Dir}`);
    binDir = bin1Dir;
  } else if (existsSync(bin2Path)) {
    core.debug(`Found GH CLI binary in ${bin2Dir}`);
    binDir = bin2Dir;
  } else {
    core.setFailed(`Could not find GH CLI binary in ${found}`);
    process.exit(1);
  }

  core.addPath(binDir);
  core.debug(`Added ${binDir} to PATH`);
}

function envWithoutGhTokens() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  return env;
}

function createGhConfigDir() {
  return mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "setup-gh-"));
}

function getGhConfigDir() {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "gh");
  if (process.platform === "win32" && process.env.AppData) {
    return join(process.env.AppData, "GitHub CLI");
  }
  return join(homedir(), ".config", "gh");
}

function sanitizeAuthStatusOutput(output: string) {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:-\s*)?Token(?: scopes)?:/i.test(line))
    .join("\n")
    .trim();
}

async function getAuthStatus(hostname: string) {
  const result = await $({
    reject: false,
    env: envWithoutGhTokens(),
    extendEnv: false,
  })`gh auth status --hostname ${hostname}`;
  const output = sanitizeAuthStatusOutput(
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return { ok: result.exitCode === 0, output };
}

async function loginWithToken(hostname: string, token: string) {
  await $({ input: token, env: envWithoutGhTokens(), extendEnv: false })`gh auth login --with-token --hostname ${hostname}`;
}

async function setAuthOutputFromStatus(hostname: string, warning: string) {
  const authStatus = await getAuthStatus(hostname);
  core.setOutput("auth", authStatus.ok);
  if (!authStatus.ok) {
    core.warning(warning);
    if (authStatus.output) core.warning(authStatus.output);
  }
  return authStatus.ok;
}

function ghTokenEnvNamesForHost(hostname: string) {
  return hostname === "github.com"
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
}

function clearGhTokenEnvForHost(hostname: string) {
  for (const name of ghTokenEnvNamesForHost(hostname)) {
    core.exportVariable(name, "");
  }
}

const installedVersion = await getInstalledVersion();
if (installedVersion && !skipMatchingVersion) {
  core.info(`Using existing GH CLI ${installedVersion} from PATH`);
  core.setOutput("cache-hit", true);
  core.setOutput("gh-version", installedVersion);
} else if (installedVersion && matchesRequestedVersion(installedVersion)) {
  core.info(`Using existing GH CLI ${installedVersion} from PATH`);
  core.setOutput("cache-hit", true);
  core.setOutput("gh-version", installedVersion);
} else {
  const version = await resolveVersion(requestedVersion);
  core.debug(`Resolved version: ${version}`);

  if (installedVersion && matchesRequestedVersion(installedVersion, version)) {
    core.info(`Using existing GH CLI ${installedVersion} from PATH`);
    core.setOutput("cache-hit", true);
    core.setOutput("gh-version", installedVersion);
  } else {
    await installGh(version);
    core.setOutput("gh-version", version);
  }
}

let ghConfigDir = getGhConfigDir();
const token = core.getInput("token");
if (!token) {
  core.setOutput("auth", false);
} else {
  const { hostname } = new URL(core.getInput("github-server-url"));
  core.setSecret(token);

  if (switchAccount) {
    ghConfigDir = createGhConfigDir();
    core.exportVariable("GH_CONFIG_DIR", ghConfigDir);
    await loginWithToken(hostname, token);
    clearGhTokenEnvForHost(hostname);
    await setAuthOutputFromStatus(
      hostname,
      `gh auth status --hostname ${hostname} failed after switch-account login; setting auth=false.`,
    );
  } else if ((await getAuthStatus(hostname)).ok) {
    core.setOutput("auth", true);
  } else {
    await loginWithToken(hostname, token);
    await setAuthOutputFromStatus(
      hostname,
      `gh auth status --hostname ${hostname} failed after login; setting auth=false.`,
    );
  }
}
core.setOutput("gh-config-dir", ghConfigDir);
