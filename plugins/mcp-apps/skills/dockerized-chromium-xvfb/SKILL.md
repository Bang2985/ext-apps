---
name: dockerized-chromium-xvfb
description: This skill should be used when the user asks to "run Chromium in Docker", "set up a headless browser in a container", "take screenshots in Docker", "run a browser without a display", "use Xvfb in Docker", or needs to run Chromium/Playwright inside a Docker container for testing, screenshots, or headless browsing. Covers Docker daemon configuration, rootfs image creation, Xvfb virtual display, and Playwright-driven Chromium.
---

# Run Chromium in a Dockerized Webtop (Xvfb)

Run Chromium inside a Docker container using Xvfb as a virtual framebuffer, with Playwright for browser automation and screenshots. This approach works even in restricted environments where you cannot pull images from container registries.

## How It Works

```
Docker Container
├── Xvfb :99          ← Virtual X11 display (no physical monitor needed)
├── Chromium           ← Playwright's bundled Chromium binary
└── Node + Playwright  ← Automation & screenshot capture
```

## Quick Start (Fastest Path)

If you already have Docker running and can pull images, use the Playwright Docker image directly:

```bash
docker run --rm -v $(pwd)/output:/output mcr.microsoft.com/playwright:v1.57.0-noble \
  node -e "
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto('https://example.com');
      await page.screenshot({ path: '/output/screenshot.png' });
      await browser.close();
    })();
  "
```

If image pulls are blocked (e.g., egress proxy restrictions), follow the full guide below.

## Full Guide: Build From Host Rootfs

When container registry blob downloads are blocked by a proxy, build a Docker image from the host filesystem.

### Prerequisites

Install on the host:

```bash
# Xvfb (virtual framebuffer)
sudo apt-get install -y xvfb

# Playwright's Chromium (auto-downloads the browser binary)
mkdir -p /tmp/pw-test && cd /tmp/pw-test
npm init -y && npm install playwright-core
npx playwright install chromium
```

### Step 1: Start the Docker Daemon

In restricted environments the daemon often needs special flags:

```bash
# Configure DNS if /etc/resolv.conf is empty
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf

# Start with proxy support (critical for egress-controlled environments)
sudo env HTTP_PROXY="$http_proxy" HTTPS_PROXY="$https_proxy" NO_PROXY="$no_proxy" \
  dockerd --bridge=none --iptables=false --ip6tables=false \
  --storage-driver=vfs &>/tmp/dockerd.log &
```

**Key flags explained:**

| Flag | Why |
|------|-----|
| `--bridge=none` | Avoids bridge network errors on older kernels (4.x) |
| `--iptables=false` | Skips iptables rules when kernel modules are missing |
| `--storage-driver=vfs` | Works without overlay/aufs kernel support (uses more disk) |
| `HTTP_PROXY` / `HTTPS_PROXY` | Passes proxy config to the daemon process (Go's resolver doesn't read shell env) |

### Step 2: Build a Docker Image From Host Rootfs

When you cannot pull images, create one from the host filesystem:

```bash
# Create a targeted rootfs tarball (~900MB)
cd /
sudo tar cf /tmp/chromium-rootfs.tar \
  bin/bash bin/sh bin/ls bin/cat bin/echo bin/mkdir bin/sleep bin/ln \
  usr/bin/Xvfb usr/bin/xkbcomp \
  lib/x86_64-linux-gnu lib64 \
  usr/lib/x86_64-linux-gnu usr/lib/xorg \
  usr/share/X11 usr/share/fonts \
  etc/ld.so.cache etc/ld.so.conf etc/ld.so.conf.d \
  etc/ssl etc/fonts etc/passwd etc/group \
  opt/node22 \
  root/.cache/ms-playwright/chromium-1194 \
  2>/dev/null

# Import as a Docker image
docker import /tmp/chromium-rootfs.tar chromium-xvfb:latest
```

**Important:** Include `usr/bin/xkbcomp` and `usr/share/X11` — Xvfb fails without keyboard config.

### Step 3: Run Chromium in the Container

```bash
mkdir -p /tmp/output

docker run --rm \
  -v /tmp/pw-test:/pw-test:ro \
  -v /tmp/output:/output \
  chromium-xvfb:latest \
  /bin/bash -c '
export DISPLAY=:99
export PATH="/opt/node22/bin:/bin:/usr/bin:$PATH"
export HOME="/root"

mkdir -p /root/.cache/ms-playwright
ln -sf /root_cache_chromium /root/.cache/ms-playwright/chromium-1194

# Start virtual display
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp 2>/dev/null &
sleep 2

# Launch Chromium via Playwright and take a screenshot
cd /pw-test
node -e "
const { chromium } = require(\"playwright-core\");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: \"/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome\",
    args: [\"--no-sandbox\", \"--disable-gpu\", \"--disable-dev-shm-usage\"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(\"https://example.com\");
  await page.screenshot({ path: \"/output/screenshot.png\" });
  console.log(\"Screenshot saved! Chromium:\", browser.version());
  await browser.close();
})();
"
'
```

### Step 4: Verify

```bash
ls -lh /tmp/output/screenshot.png
# View the screenshot to confirm Chromium rendered correctly
```

## Simpler Alternative: Xvfb on the Host (No Docker)

If Docker is not required, Xvfb + Chromium works directly on the host with less complexity:

```bash
# Install
sudo apt-get install -y xvfb
npm install playwright-core
npx playwright install chromium

# Run
export DISPLAY=:99
Xvfb :99 -screen 0 1280x1024x24 &
sleep 2

node -e "
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: require('os').homedir() + '/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.screenshot({ path: 'screenshot.png' });
  await browser.close();
})();
"
```

This avoids all Docker overhead and is the fastest path when you just need headless Chromium.

## Common Mistakes

1. **Docker daemon ignores shell proxy variables.** The daemon is a separate Go process — you must pass `HTTP_PROXY`/`HTTPS_PROXY` via `sudo env ... dockerd` or `/etc/docker/daemon.json`.

2. **Missing `xkbcomp` in the rootfs.** Xvfb prints `Fatal server error: Failed to activate virtual core keyboard` and exits. Always include `/usr/bin/xkbcomp` and `/usr/share/X11/xkb/`.

3. **VFS storage driver doubles disk usage.** VFS copies the entire image for each container (no copy-on-write). A 900MB image needs ~1.8GB free. Clean up with `docker system prune -af`.

4. **Chromium needs `--no-sandbox` in containers.** Without it, Chromium fails with a namespace sandbox error since containers lack the required kernel capabilities.

5. **Forgetting `--disable-dev-shm-usage`.** Docker's default `/dev/shm` is 64MB, which Chromium can exhaust. This flag tells Chromium to write shared memory to `/tmp` instead.

6. **`docker import` paths must be relative.** Use `cd / && tar cf ... bin/ usr/` (no leading `/`), otherwise files land under `/bin/` vs being found at `/bin/`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `context deadline exceeded` on pull | Docker daemon can't reach registry | Pass proxy env vars to `dockerd` |
| `Forbidden` on blob download | Egress proxy blocks CDN hosts | Build image from host rootfs instead |
| `no space left on device` | VFS driver doubled storage | `docker system prune -af`, use smaller rootfs |
| `operation not permitted` on layer | Missing kernel capabilities | Use `--storage-driver=vfs` |
| Xvfb keyboard init failed | Missing xkbcomp/xkb data | Include `xkbcomp` + `usr/share/X11` in rootfs |
| Chromium sandbox error | Unprivileged container | Add `--no-sandbox` to Chrome args |
