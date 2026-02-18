#!/usr/bin/env tsx
/**
 * Copy noVNC vendor files to dist for embedded VNC viewer
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcVendor = path.join(projectRoot, "vendor", "novnc");
const distVnc = path.join(projectRoot, "dist", "vnc");

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyNovnc(): void {
  if (!fs.existsSync(srcVendor)) {
    console.warn("[copy-novnc] Source directory not found:", srcVendor);
    return;
  }

  if (!fs.existsSync(distVnc)) {
    fs.mkdirSync(distVnc, { recursive: true });
  }

  // Copy core directory
  const srcCore = path.join(srcVendor, "core");
  const destCore = path.join(distVnc, "core");
  if (fs.existsSync(srcCore)) {
    copyDir(srcCore, destCore);
    console.log("[copy-novnc] Copied core/");
  }

  // Copy vendor directory (includes pako)
  const srcVendorSub = path.join(srcVendor, "vendor");
  const destVendorSub = path.join(distVnc, "vendor");
  if (fs.existsSync(srcVendorSub)) {
    copyDir(srcVendorSub, destVendorSub);
    console.log("[copy-novnc] Copied vendor/");
  }

  // Copy LICENSE
  const srcLicense = path.join(srcVendor, "LICENSE.txt");
  if (fs.existsSync(srcLicense)) {
    fs.copyFileSync(srcLicense, path.join(distVnc, "LICENSE.txt"));
    console.log("[copy-novnc] Copied LICENSE.txt");
  }

  console.log("[copy-novnc] Done");
}

copyNovnc();
