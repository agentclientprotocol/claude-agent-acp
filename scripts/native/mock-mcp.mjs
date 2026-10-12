import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// The marker proves a hanging set reached a real MCP child before close races it.
if (process.argv[2]) appendFileSync(process.argv[2], String(process.pid) + "\n");
if (process.argv[3] === "hang") {
  process.stdin.resume();
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "native-contract-mcp", version: "1.0.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: [] };
        break;
      default:
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Unsupported mock method" },
          }) + "\n",
        );
        continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
}
