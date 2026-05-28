import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as github from "@actions/github";
import { join } from "node:path";
import { existsSync } from "node:fs";
import semver from "semver";
import process from "node:process";
import { $ } from "execa";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";

const octokit = core.getInput("cli-token")
  ? github.getOctokit(core.getInput("cli-token"))
  : github.getOctokit(undefined!, {
      authStrategy: createUnauthenticatedAuth,
      auth: { reason: "no 'cli-token' input" },
    });
let version = core.getInput("version");
if (version === "latest") {
  const { data } = await octokit.rest.repos.getLatestRelease({
    owner: "cli",
    repo: "cli",
  });
  version = data.tag_name.slice(1);
} else {
  const releases = await octokit.paginate(octokit.rest.repos.listReleases, {
    owner: "cli",
    repo: "cli",
  });
  const versions = releases.map((release) => release.tag_name.slice(1));
  version = semver.maxSatisfying(versions, version) ?? "2.28.0";
}
core.debug(`Resolved version: ${version}`);

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
const zipFile = `gh_${version}_${platform}_${arch}.${ext}`;
const downloadUrl = `https://github.com/cli/cli/releases/download/v${version}/${zipFile}`;
const subFolderName = `gh_${version}_${platform}_${arch}`;

let found = tc.find("gh", version);
core.setOutput("cache-hit", !!found);
if (!found) {
  core.debug(`Downloading GH CLI ${version} from ${downloadUrl} ...`);
  const downloadedFile = await tc.downloadTool(downloadUrl);
  core.debug(`Downloaded GH CLI ${version} to ${downloadedFile}`);
  if (ext === "zip") {
    found = await tc.extractZip(downloadedFile);
  } else {
    found = await tc.extractTar(downloadedFile);
  }
  found = await tc.cacheDir(found, "gh", version);
  core.debug(`Cached GH CLI ${version} to ${found}`);
} else {
  core.debug(`Using cached GH CLI ${version} from ${found}`);
}
const bin1Dir = join(found, "bin");
const bin2Dir = join(found, subFolderName, "bin");
let binDir: string;

if (existsSync(bin1Dir)) {
  core.debug(`Found bin directory in ${bin1Dir}`);
  binDir = bin1Dir;
} else if (existsSync(bin2Dir))  {
  core.debug(`Found bin directory in ${bin2Dir}`);
  binDir = bin2Dir;
} else {
  core.error(`Could not find bin directory in ${found}`);
  core.setFailed(`Could not find bin directory in ${found}`);
  process.exit(1);
}

core.addPath(binDir);
core.debug(`Added ${binDir} to PATH`);
core.setOutput("gh-version", version);

const token = core.getInput("token");
if (token) {
  const { hostname } = new URL(core.getInput("github-server-url"));
  await $({ input: token })`gh auth login --with-token --hostname ${hostname}`;
  core.setOutput("auth", true);
} else {
  core.setOutput("auth", false);
}
