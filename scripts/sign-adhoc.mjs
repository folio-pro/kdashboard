// Ad-hoc code signing for the packaged macOS app, wired up as electron-builder's
// `afterPack` hook so the .dmg and .zip targets get a signed bundle.
//
// We have no Apple Developer ID, so `mac.identity` is null and electron-builder
// skips signing. On Apple Silicon the kernel refuses to run unsigned arm64 code,
// and a quarantined unsigned bundle makes macOS report «"Kdashboard" is damaged
// and can't be opened» instead of the usual unidentified-developer prompt.
// Signing ad-hoc (`codesign --sign -`) fixes that: the bundle gets sealed
// resources and a stable code identity, with no certificate and no proof of
// origin. Users still get the unidentified-developer prompt on first launch, and
// notarization still requires a real certificate.
//
// We do not use electron-builder's own ad-hoc support (`identity: "-"`): it
// still searches the keychain and its "non-Apple certificate" fallback matches
// any identity whose name contains a hyphen, so a local build could silently
// sign with the developer's personal certificate.
//
// codesign seals each nested bundle into its parent, so order matters: deepest
// first, top-level bundle last. `--deep` would do this in one call but Apple
// discourages it, and it skips loose Mach-O files such as the .dylib libraries
// shipped inside Electron Framework.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const NESTED_BUNDLE = /\.(app|framework)$/;
const MACH_O_FILE = /\.(dylib|so|node)$/;

/** Collect every nested bundle and loose Mach-O file inside an .app. */
function collectSignTargets(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (NESTED_BUNDLE.test(entry.name)) found.push(entryPath);
      collectSignTargets(entryPath, found);
    } else if (entry.isFile()) {
      // Helper executables (chrome_crashpad_handler) have no extension, so fall
      // back to the executable bit for files directly under a Helpers dir.
      const isHelper = path.basename(dir) === 'Helpers' && (statSync(entryPath).mode & 0o111) !== 0;
      if (MACH_O_FILE.test(entry.name) || isHelper) found.push(entryPath);
    }
  }
  return found;
}

function codesign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

export default async function afterPack({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== 'darwin') return;

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const targets = collectSignTargets(appPath)
    // Deepest paths first so children are signed before their parent bundle.
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

  for (const target of targets) codesign(target);
  codesign(appPath);

  // Fails the build if any seal is inconsistent, rather than shipping a bundle
  // that macOS will reject as damaged.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${path.basename(appPath)} (${targets.length} nested items)`);
}
