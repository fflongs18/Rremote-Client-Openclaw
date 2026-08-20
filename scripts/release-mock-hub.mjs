import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1) throw new Error("A valid port is required");

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  response.setHeader("content-type", "application/json");

  if (request.method === "GET" && ["/api/clients", "/api/pushes"].includes(url.pathname)) {
    response.end("[]");
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.setHeader("content-type", "text/event-stream");
    response.end(": mock\n\n");
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/pairing") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    response.statusCode = 201;
    response.end(JSON.stringify({
      id: "pairing-ui-test",
      code: "7K9M-2QXP",
      expiresAt: Date.now() + 10 * 60 * 1000,
      hubUrl: "https://hub.test.example",
      releaseBaseUrl: "https://downloads.test.example/remote-openclaw/0.1.0",
      windowsCommand: `$remoteOcInstaller = Join-Path $env:TEMP 'remote-openclaw-install.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.test.example/remote-openclaw/0.1.0/install.ps1' -OutFile $remoteOcInstaller; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remoteOcInstaller -ManifestUrl 'https://downloads.test.example/remote-openclaw/0.1.0/release.json' -HubUrl 'https://hub.test.example' -PairingCode '7K9M-2QXP' -DeviceName '${input.nodeName}' -Json`,
      macosCommand: `remote_oc_installer="$(mktemp)" && curl -fsSL 'https://downloads.test.example/remote-openclaw/0.1.0/install.sh' -o "$remote_oc_installer" && bash "$remote_oc_installer" --manifest-url 'https://downloads.test.example/remote-openclaw/0.1.0/release.json' --hub-url 'https://hub.test.example' --pairing-code '7K9M-2QXP' --device-name '${input.nodeName}'`,
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/pairing-sessions/exchange") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.code !== "RELEASE-TEST-CODE") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid pairing code" }));
      return;
    }
    response.end(JSON.stringify({
      nodeId: "remote-oc-release-test",
      nodeToken: "release-test-node-token",
      nodeName: input.nodeName,
      hubHttpUrl: `http://127.0.0.1:${port}`,
      hubWsUrl: `ws://127.0.0.1:${port}`,
    }));
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("ready\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
