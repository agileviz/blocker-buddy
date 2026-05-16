#!/usr/bin/env node
// Keeps package.json version in sync with extension.json (the canonical version source).
// Run automatically via postbuild, or manually with: npm run sync-version
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const extPath = path.join(root, "extension.json");
const pkgPath = path.join(root, "package.json");

const ext = JSON.parse(fs.readFileSync(extPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

if (pkg.version === ext.version) {
    console.log(`version already in sync: ${ext.version}`);
} else {
    const prev = pkg.version;
    pkg.version = ext.version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`version synced: ${prev} → ${ext.version}`);
}
