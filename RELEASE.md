# Lightweight Windows and macOS installation

The release directory contains `install.ps1`, `install.sh`, `release.json`, and platform archives under `artifacts/`. A target computer selects and downloads only its matching archive. It never runs `npm install` or TypeScript compilation.

Build the four platform archives on a trusted release machine:

```powershell
npm run package:windows
npm run package:windows-arm64
npm run package:macos-x64
npm run package:macos-arm64
npm run release:manifest
```

When publishing under a fixed HTTPS download directory, pass that directory while generating the manifest:

```powershell
node ./scripts/generate-release-manifest.mjs https://downloads.example.com/remote-openclaw/0.1.0
```

Upload `install.ps1`, `install.sh`, `release.json`, and the `artifacts/` directory into that same directory.

The macOS PowerShell builders cross-package checksum-verified official Darwin Node runtimes. The native `package:macos` command remains available on a Mac. Before public release, run the packages once on Intel and Apple Silicon Macs to verify launchd behavior.

For Windows Authenticode signing, pass `-SigningCertificate` or `-CertificateThumbprint` to `scripts/package-windows.ps1`.

Install from a release directory copied to the target computer:

```powershell
.\install.ps1 -HubUrl "https://hub.example.com" -PairingCode "ONE-TIME-CODE" -DeviceName "Office PC" -Json
```

```bash
bash ./install.sh --hub-url "https://hub.example.com" --pairing-code "ONE-TIME-CODE" --device-name "Office Mac"
```

When only the small installer script is distributed, pass `-ManifestUrl` or `--manifest-url` with the HTTPS URL of `release.json`. Relative artifact URLs are resolved from the manifest location.

For zero-file installation from the controller UI, publish `install.ps1`, `install.sh`, `release.json`, and the `artifacts/` directory under one HTTPS directory. Then configure the BFF and restart it:

```text
REMOTE_OC_RELEASE_BASE_URL=https://downloads.example.com/remote-openclaw/0.1.0
```

The controller's Add Device dialog then emits paste-ready commands that download the bootstrap script to a temporary file. The bootstrap downloads only the matching architecture from `release.json`, verifies SHA-256, installs the client, and removes the temporary script. Pairing creation is disabled when the release URL is missing so users are never shown a command that depends on a local repository checkout.

The first-stage user flow now uses an enrollment URL. Set `REMOTE_OC_CONTROL_URL` to the public Web/BFF URL. The Add Device dialog shows platform download buttons and a copyable enrollment link; it does not expose shell commands, Hub URLs, or pairing codes. The enrollment token expires after ten minutes and configuration exchange is idempotent so a failed download can be retried; the underlying Hub pairing code still permits only one completed pairing.

The installer verifies the selected archive SHA-256 and its internal manifest, exchanges the one-time code, stores the local identity, registers per-user autostart, starts the client, and waits for the Hub to report it online. The installed directory contains the matching uninstaller.

Hermes is optional. Use `-RequireHermes` / `--require-hermes` to require a compatible Runs API, or `-StartHermes` / `--start-hermes` to start an installed `hermes gateway`. The API key must contain at least 16 characters.
