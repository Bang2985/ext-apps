import { test, expect, type Page } from "@playwright/test";
import { execSync, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const TEST_CONTAINER_NAME = "vd-e2e-test";
const TIMEOUT = 120000;

function isDockerAvailable(): boolean {
  try {
    execSync("docker ps", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function createTestDesktop(): Promise<{ port: number }> {
  const port = 3500 + Math.floor(Math.random() * 100);

  const cmd = [
    "docker run -d",
    `--name ${TEST_CONTAINER_NAME}`,
    `-p ${port}:6901`,
    "--shm-size=256m",
    "--label vd.managed=true",
    "--label vd.variant=xfce",
    `--label vd.resolution=1280x720`,
    `--label vd.commands=[]`,
    "consol/ubuntu-xfce-vnc:latest",
  ].join(" ");

  await execAsync(cmd);

  const maxWait = 90000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    try {
      const { stdout } = await execAsync(
        `curl -s http://localhost:${port}/ || true`,
      );
      if (stdout.length > 0) break;
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  await new Promise((r) => setTimeout(r, 3000));
  return { port };
}

async function cleanupTestDesktop(): Promise<void> {
  try {
    await execAsync(`docker rm -f ${TEST_CONTAINER_NAME}`);
  } catch {
    // Ignore errors if container doesn't exist
  }
}

function getAppFrame(page: Page) {
  return page.frameLocator("iframe").first().frameLocator("iframe").first();
}

async function waitForAppLoad(page: Page) {
  const outerFrame = page.frameLocator("iframe").first();
  await expect(outerFrame.locator("iframe")).toBeVisible({ timeout: 30000 });
}

const dockerAvailable = isDockerAvailable();

// Basic tests that don't require Docker
test.describe("Virtual Desktop Server - Basic", () => {
  test("server is listed in host dropdown", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    const options = await page
      .locator("select")
      .first()
      .locator("option")
      .allTextContents();

    expect(options).toContain("Virtual Desktop Server");
  });

  test("connect-desktop and list-desktops tools are available", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    await page
      .locator("select")
      .first()
      .selectOption({ label: "Virtual Desktop Server" });

    await page.waitForTimeout(500);

    const toolOptions = await page
      .locator("select")
      .nth(1)
      .locator("option")
      .allTextContents();

    expect(toolOptions).toContain("connect-desktop");
    expect(toolOptions).toContain("list-desktops");
  });

  test("list-desktops tool works", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    await page
      .locator("select")
      .first()
      .selectOption({ label: "Virtual Desktop Server" });

    await page.waitForTimeout(500);

    await page
      .locator("select")
      .nth(1)
      .selectOption({ label: "list-desktops" });

    await page.click('button:has-text("Call Tool")');

    await expect(
      page
        .locator('text="No virtual desktops found"')
        .or(page.locator("text=/Docker is not available/"))
        .or(page.locator('text="Found"'))
        .or(page.locator('text="virtual desktop"')),
    ).toBeVisible({ timeout: 15000 });
  });
});

// Docker-dependent tests - only run when ENABLE_DOCKER_TESTS=1
test.describe("Virtual Desktop Server - Docker", () => {
  const enableDockerTests = process.env.ENABLE_DOCKER_TESTS === "1";
  test.skip(
    !enableDockerTests || !dockerAvailable,
    "Docker tests disabled or Docker unavailable",
  );

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.setTimeout(180000);
    if (!enableDockerTests || !dockerAvailable) return;

    await cleanupTestDesktop();
    await createTestDesktop();
  });

  test.afterAll(async () => {
    if (!enableDockerTests || !dockerAvailable) return;
    await cleanupTestDesktop();
  });

  test("loads virtual desktop viewer", async ({ page }) => {
    test.setTimeout(TIMEOUT);

    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    await page
      .locator("select")
      .first()
      .selectOption({ label: "Virtual Desktop Server" });

    await page.waitForTimeout(500);
    const toolSelect = page.locator("select").nth(1);
    await toolSelect.selectOption({ label: "view-desktop" });

    const argsTextarea = page.locator("textarea");
    await argsTextarea.fill(JSON.stringify({ name: TEST_CONTAINER_NAME }));

    await page.click('button:has-text("Call Tool")');

    await waitForAppLoad(page);

    const appFrame = getAppFrame(page);
    await expect(appFrame.locator('[class*="container"]')).toBeVisible({
      timeout: 30000,
    });
  });

  test("screenshot matches golden", async ({ page }) => {
    test.setTimeout(TIMEOUT);

    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    await page
      .locator("select")
      .first()
      .selectOption({ label: "Virtual Desktop Server" });

    await page.waitForTimeout(500);
    const toolSelect = page.locator("select").nth(1);
    await toolSelect.selectOption({ label: "view-desktop" });

    const argsTextarea = page.locator("textarea");
    await argsTextarea.fill(JSON.stringify({ name: TEST_CONTAINER_NAME }));

    await page.click('button:has-text("Call Tool")');

    await waitForAppLoad(page);

    const appFrame = getAppFrame(page);

    await expect(appFrame.locator('[class*="vncCanvas"]')).toBeVisible({
      timeout: 30000,
    });

    await page.waitForTimeout(3000);

    await expect(page).toHaveScreenshot("virtual-desktop.png", {
      mask: [appFrame.locator('[class*="vncCanvas"]')],
      maxDiffPixelRatio: 0.06,
    });
  });

  test("disconnect and reconnect works", async ({ page }) => {
    test.setTimeout(TIMEOUT);

    await page.goto("/");

    await expect(page.locator("select").first()).toBeEnabled({
      timeout: 30000,
    });

    await page
      .locator("select")
      .first()
      .selectOption({ label: "Virtual Desktop Server" });
    await page.waitForTimeout(500);
    await page
      .locator("select")
      .nth(1)
      .selectOption({ label: "view-desktop" });

    await page
      .locator("textarea")
      .fill(JSON.stringify({ name: TEST_CONTAINER_NAME }));
    await page.click('button:has-text("Call Tool")');

    await waitForAppLoad(page);
    const appFrame = getAppFrame(page);

    await expect(appFrame.locator('[class*="vncCanvas"]')).toBeVisible({
      timeout: 30000,
    });

    const disconnectButton = appFrame.locator('button[title="Disconnect"]');
    await disconnectButton.click();

    await expect(appFrame.locator('[class*="disconnected"]')).toBeVisible({
      timeout: 10000,
    });

    const reconnectButton = appFrame.locator('button:has-text("Reconnect")');
    await reconnectButton.click();

    await expect(appFrame.locator('[class*="vncCanvas"]')).toBeVisible({
      timeout: 30000,
    });
  });
});
