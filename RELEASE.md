# Windows release installation

Build a release on a trusted build machine:

```powershell
npm run package:windows
```

For Authenticode signing, pass a protected PFX certificate:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -SigningCertificate .\release-signing.pfx
```

Or use a code-signing certificate already installed for the current Windows user:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 -CertificateThumbprint CERTIFICATE_THUMBPRINT
```

The output ZIP contains prebuilt client files, production dependencies, and a verified Node.js runtime. It does not contain source, `.git`, `.env`, or runtime secrets.

The user machine downloads and verifies the release, then pairs and installs with one command:

```powershell
.\bootstrap.ps1 -PackageUrl "https://download.example.com/RemoteOpenClaw-0.1.0-win-x64.zip" -ExpectedSha256 "RELEASE_ZIP_SHA256" -HubUrl "https://hub.example.com" -PairingCode "ONE-TIME-CODE" -DeviceName "Office PC" -Json
```

The installer exchanges the one-time code, stores the device identity locally, creates logon autostart, starts the client, and waits for the Hub to report the device online with at least one ready runtime before returning success. Use `uninstall.ps1`; add `-KeepIdentity` to retain the local identity.

Hermes is optional by default. Add `-RequireHermes` to fail unless its Runs API is ready, or `-StartHermes` to launch an installed `hermes gateway` automatically. Both modes require `-HermesApiKey` with at least 16 characters. The installer validates `/v1/capabilities`; `hermes serve` (headless UI mode) is not compatible.
