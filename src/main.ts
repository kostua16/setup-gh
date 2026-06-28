import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as github from "@actions/github";
import { join } from "node:path";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import semver from "semver";
import process from "node:process";
import { $, execa } from "execa";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";

const requestedVersion =
  core.getInput("gh-version") || core.getInput("version") || "latest";
const switchAccount = core.getBooleanInput("switch-account");
const updateGitCredentials = core.getBooleanInput("update-git-credentials");
const skipMatchingVersion = core.getBooleanInput("skip-matching-version");
const gitTokenEnvName = "SETUP_GH_GIT_TOKEN";
const gitAuthConfigPattern =
  "^(credential\\.helper|http(\\..*)?\\.extraheader|url\\..*\\.insteadof)$";

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

function createGitCredentialDir() {
  return mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "setup-gh-git-"));
}

function getGhConfigDir() {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "gh");
  if (process.platform === "win32" && process.env.AppData) {
    return join(process.env.AppData, "GitHub CLI");
  }
  return join(homedir(), ".config", "gh");
}

function escapeGitConfigSubsection(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function createAskpassScript(gitCredentialDir: string) {
  const askpassPath = join(
    gitCredentialDir,
    process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh",
  );
  const script =
    process.platform === "win32"
      ? `@echo off
setlocal EnableExtensions
set "prompt=%~1"
echo(%prompt%| findstr /I "Username" >nul
if not errorlevel 1 (
  echo x-access-token
  exit /b 0
)
echo(%prompt%| findstr /I "Password" >nul
if not errorlevel 1 (
  echo(%${gitTokenEnvName}%
  exit /b 0
)
echo(
exit /b 0
`
      : `#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "\${${gitTokenEnvName}}" ;;
  *) printf '\\n' ;;
esac
`;

  writeFileSync(askpassPath, script, { mode: 0o700 });
  chmodSync(askpassPath, 0o700);
  return askpassPath;
}

function createTempGlobalGitConfig(gitCredentialDir: string, serverUrl: URL) {
  const gitConfigPath = join(gitCredentialDir, "gitconfig");
  const httpsBaseUrl = `${serverUrl.protocol}//${serverUrl.host}/`;
  const sshUrlHost = serverUrl.host;
  const sshScpHost = serverUrl.port ? serverUrl.hostname : serverUrl.host;
  const config = [
    "[credential]",
    "\thelper =",
    "",
    `[url "${escapeGitConfigSubsection(httpsBaseUrl)}"]`,
    `\tinsteadOf = git@${sshScpHost}:`,
    `\tinsteadOf = ssh://git@${sshUrlHost}/`,
    "",
  ].join("\n");

  writeFileSync(gitConfigPath, config, { mode: 0o600 });
  return gitConfigPath;
}

function sanitizeSecretBearingText(value: string) {
  return value
    .replace(/(https?:\/\/)(?:[^/\s@]+@)/gi, "$1***@")
    .replace(/(x-access-token:)[^@/\s]+/gi, "$1***")
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, "$1***")
    .replace(/(oauth_token[:=]\s*)\S+/gi, "$1***");
}

async function debugGitAuthConfigOrigins(label: string) {
  if (!core.isDebug()) return;

  const result = await execa(
    "git",
    [
      "config",
      "--show-origin",
      "--show-scope",
      "--name-only",
      "--get-regexp",
      gitAuthConfigPattern,
    ],
    { reject: false },
  );

  if (result.exitCode === 1) {
    core.debug(`${label}: no matching git auth config entries`);
    return;
  }

  if (result.exitCode !== 0) {
    core.debug(`${label}: unable to inspect git auth config origins`);
    return;
  }

  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    core.debug(`${label}: ${sanitizeSecretBearingText(line)}`);
  }
}

type GitConfigEntry = {
  key: string;
  value: string;
};

async function getLocalGitConfigEntries(pattern: string): Promise<GitConfigEntry[]> {
  const result = await execa(
    "git",
    ["config", "--local", "--get-regexp", pattern],
    { reject: false },
  );

  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    core.debug("Unable to inspect local git auth config entries");
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.search(/\s/);
      if (separator === -1) return { key: line, value: "" };
      return {
        key: line.slice(0, separator),
        value: line.slice(separator).trim(),
      };
    });
}

function isServerRelatedConfig(value: string, serverUrl: URL) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes(serverUrl.host.toLowerCase()) ||
    normalized.includes(serverUrl.hostname.toLowerCase())
  );
}

function shouldUnsetLocalGitAuthConfig(entry: GitConfigEntry, serverUrl: URL) {
  const key = entry.key.toLowerCase();
  if (key === "credential.helper") return true;
  if (key === "http.extraheader") return true;
  if (key.startsWith("http.") && key.endsWith(".extraheader")) {
    return isServerRelatedConfig(key, serverUrl);
  }
  if (key.startsWith("url.") && key.endsWith(".insteadof")) {
    return isServerRelatedConfig(`${entry.key} ${entry.value}`, serverUrl);
  }
  return false;
}

async function scrubLocalGitAuthConfig(serverUrl: URL) {
  const workTreeResult = await execa(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { reject: false },
  );

  if (workTreeResult.exitCode !== 0 || workTreeResult.stdout.trim() !== "true") {
    core.debug("Skipping local git auth config cleanup outside a git worktree");
    return 0;
  }

  const entries = await getLocalGitConfigEntries(gitAuthConfigPattern);
  const keysToUnset = [
    ...new Set(
      entries
        .filter((entry) => shouldUnsetLocalGitAuthConfig(entry, serverUrl))
        .map((entry) => entry.key),
    ),
  ];

  for (const key of keysToUnset) {
    const result = await execa("git", ["config", "--local", "--unset-all", key], {
      reject: false,
    });
    if (result.exitCode !== 0 && result.exitCode !== 5) {
      core.debug(
        `Unable to unset local git config key ${sanitizeSecretBearingText(key)}`,
      );
    }
  }

  return keysToUnset.length;
}

async function configureGitCredentials(serverUrl: URL, token: string) {
  core.debug("update-git-credentials: enabled");
  await debugGitAuthConfigOrigins("git auth config before update");

  const gitCredentialDir = createGitCredentialDir();
  const askpassPath = createAskpassScript(gitCredentialDir);
  const gitConfigPath = createTempGlobalGitConfig(gitCredentialDir, serverUrl);

  core.exportVariable(gitTokenEnvName, token);
  core.exportVariable("GIT_ASKPASS", askpassPath);
  core.exportVariable("GIT_TERMINAL_PROMPT", "0");
  core.exportVariable("GIT_CONFIG_GLOBAL", gitConfigPath);
  core.exportVariable("GIT_CONFIG_NOSYSTEM", "1");

  const scrubbedLocalKeys = await scrubLocalGitAuthConfig(serverUrl);
  core.debug(`git credential temp config: ${gitConfigPath}`);
  core.debug(`git askpass script: ${askpassPath}`);
  core.debug(`local git auth config keys scrubbed: ${scrubbedLocalKeys}`);
  await debugGitAuthConfigOrigins("git auth config after update");
}

function sanitizeAuthStatusOutput(output: string) {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:-\s*)?Token(?: scopes)?:/i.test(line))
    .join("\n")
    .trim();
}

async function getAuthStatus(hostname: string) {
  const result = await $({ reject: false })`gh auth status --hostname ${hostname}`;
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
  if (updateGitCredentials) {
    core.debug("update-git-credentials: skipped because no token was provided");
  }
} else {
  const serverUrl = new URL(core.getInput("github-server-url"));
  const { hostname } = serverUrl;
  core.setSecret(token);

  if (switchAccount) {
    ghConfigDir = createGhConfigDir();
    core.exportVariable("GH_CONFIG_DIR", ghConfigDir);
    await loginWithToken(hostname, token);
    core.exportVariable("GH_TOKEN", token);
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

  if (updateGitCredentials) {
    await configureGitCredentials(serverUrl, token);
  } else {
    core.debug("update-git-credentials: disabled");
  }
}
core.setOutput("gh-config-dir", ghConfigDir);
