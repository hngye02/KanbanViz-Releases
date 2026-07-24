import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const STATUS_HEADER = "x-kanbanviz-bootstrap-token";

const bootstrapHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Installing KanbanViz</title>
    <style>
      :root {
        color: #172033;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f8fc;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(560px, 100%);
        padding: 32px;
        border: 1px solid #d9ddea;
        border-radius: 18px;
        background: white;
        box-shadow: 0 18px 60px rgba(35, 42, 68, 0.12);
      }
      h1 { margin: 0 0 10px; font-size: 1.6rem; }
      p { color: #65708a; line-height: 1.5; }
      .track {
        height: 10px;
        margin: 24px 0 14px;
        overflow: hidden;
        border-radius: 999px;
        background: #e8eaf2;
      }
      .bar {
        width: 18%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #7c5cff, #2f9cf4);
        transition: width 200ms ease;
        animation: pulse 1.6s ease-in-out infinite alternate;
      }
      .bar.determinate { animation: none; }
      .error { color: #b42318; }
      button {
        display: none;
        margin-top: 18px;
        padding: 10px 16px;
        border: 0;
        border-radius: 10px;
        background: #6d4aff;
        color: white;
        font: inherit;
        font-weight: 650;
        cursor: pointer;
      }
      @keyframes pulse {
        from { transform: translateX(-30%); }
        to { transform: translateX(450%); }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Preparing KanbanViz</h1>
      <p id="message">Checking the local KanbanViz server...</p>
      <div class="track" aria-hidden="true">
        <div class="bar" id="bar"></div>
      </div>
      <p id="detail">The first launch downloads and verifies the Windows server runtime.</p>
      <button id="retry" type="button">Retry</button>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const token = params.get("token");
      const target = params.get("target");
      const message = document.getElementById("message");
      const detail = document.getElementById("detail");
      const bar = document.getElementById("bar");
      const retry = document.getElementById("retry");

      async function request(path, options = {}) {
        return fetch(path, {
          ...options,
          cache: "no-store",
          headers: {
            ...(options.headers || {}),
            "X-KanbanViz-Bootstrap-Token": token,
          },
        });
      }

      function render(status) {
        message.textContent = status.message || "Preparing KanbanViz...";
        if (Number.isFinite(status.progress)) {
          bar.classList.add("determinate");
          bar.style.width = Math.max(2, Math.min(100, status.progress)) + "%";
        } else {
          bar.classList.remove("determinate");
          bar.style.width = "18%";
        }

        if (status.phase === "ready") {
          detail.textContent = "Opening the KanbanViz Canvas...";
          window.location.replace(target);
          return;
        }

        if (status.phase === "error") {
          message.classList.add("error");
          detail.textContent = status.detail || "KanbanViz could not be started.";
          retry.style.display = "inline-block";
        } else {
          message.classList.remove("error");
          retry.style.display = "none";
          detail.textContent = status.detail
            || "This verified runtime is cached for future Canvas sessions.";
        }
      }

      async function poll() {
        try {
          const response = await request("/status");
          if (!response.ok) throw new Error("Status request failed");
          render(await response.json());
        } catch {
          render({
            phase: "error",
            message: "The KanbanViz installer stopped responding.",
            detail: "Close and reopen the Canvas to retry.",
          });
        }
      }

      retry.addEventListener("click", async () => {
        retry.disabled = true;
        await request("/retry", { method: "POST" });
        retry.disabled = false;
        await poll();
      });

      poll();
      setInterval(poll, 500);
    </script>
  </body>
</html>`;

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isAllowedTarget(target, applicationOrigin) {
  try {
    const url = new URL(target);
    return (
      url.origin === applicationOrigin
      && url.pathname === "/"
      && url.searchParams.get("canvas") === "1"
    );
  } catch {
    return false;
  }
}

export async function createBootstrapServer({
  applicationOrigin,
  getStatus,
  retry,
}) {
  const token = randomUUID();
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    );

    if (requestUrl.pathname === "/") {
      const target = requestUrl.searchParams.get("target");
      if (
        request.method !== "GET"
        || requestUrl.searchParams.get("token") !== token
        || !isAllowedTarget(target, applicationOrigin)
      ) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Invalid KanbanViz bootstrap request.");
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; "
          + "script-src 'unsafe-inline'; connect-src 'self'",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(bootstrapHtml),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(bootstrapHtml);
      return;
    }

    if (request.headers[STATUS_HEADER] !== token) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }

    if (requestUrl.pathname === "/status" && request.method === "GET") {
      sendJson(response, 200, getStatus());
      return;
    }

    if (requestUrl.pathname === "/retry" && request.method === "POST") {
      retry();
      sendJson(response, 202, { accepted: true });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("KanbanViz bootstrap server did not receive a TCP port.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    urlFor(target) {
      const url = new URL(origin);
      url.searchParams.set("token", token);
      url.searchParams.set("target", target);
      return url.toString();
    },
  };
}
