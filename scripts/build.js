#!/usr/bin/env node
// Copies public/ to dist/ and injects Supabase env vars into config.js.
// Netlify runs this at build time with SUPABASE_URL / SUPABASE_ANON_KEY
// set as environment variables (Site settings -> Environment variables).

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public");
const DIST = path.join(__dirname, "..", "dist");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(SRC, DIST);

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(
      "[build] WARNING: SUPABASE_URL and/or SUPABASE_ANON_KEY are not set. " +
        "The deployed app will not be able to connect to Supabase until " +
        "these are configured as Netlify environment variables."
    );
  }

  const templatePath = path.join(DIST, "js", "config.template.js");
  const outPath = path.join(DIST, "js", "config.js");

  let contents = fs.readFileSync(templatePath, "utf8");
  contents = contents
    .replace("__SUPABASE_URL__", supabaseUrl)
    .replace("__SUPABASE_ANON_KEY__", supabaseAnonKey);

  fs.writeFileSync(outPath, contents);
  fs.rmSync(templatePath);

  console.log("[build] dist/ ready");
}

main();
