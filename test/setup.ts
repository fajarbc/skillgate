import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Node uses HOME on Unix and USERPROFILE on Windows to resolve os.homedir().
// Give each isolated test file its own home, including child CLI processes.
const home = await mkdtemp(join(tmpdir(), "skillgate-test-home-"));
vi.stubEnv("HOME", home);
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
