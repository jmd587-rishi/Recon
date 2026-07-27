// Dummy script: sends "hi" to the Azure AI Foundry / Azure OpenAI deployment configured in
// server/.env and prints the response. Run with: npx tsx src/testFoundry.ts (from server/)
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";

// Resolve .env relative to this file (not process.cwd()) so it loads correctly
// no matter which directory the script is invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
const dotenvResult = dotenv.config({ path: envPath });

const API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";

async function main() {
  console.log("[testFoundry] starting Foundry connectivity check");
  console.log("[testFoundry] loading .env", {
    path: envPath,
    loaded: !dotenvResult.error,
    error: dotenvResult.error?.message,
  });

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  console.log("[testFoundry] config loaded", {
    endpoint: endpoint ?? "(missing)",
    deployment: deployment ?? "(missing)",
    apiKeyPresent: Boolean(apiKey),
    apiVersion: API_VERSION,
  });

  if (!endpoint || !apiKey || !deployment) {
    console.error(
      "[testFoundry] missing config — set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT in server/.env"
    );
    process.exit(1);
  }

  // This endpoint already points at Azure's v1 "Responses API"
  // (https://<resource>.openai.azure.com/openai/v1/responses), which is a different
  // request/response shape than the classic /openai/deployments/{name}/chat/completions route.
  const url = endpoint.replace(/\/+$/, "");

  const body = { model: deployment, input: "hi" };

  console.log("[testFoundry] sending request", { url, body });

  const startedAt = Date.now();
  try {
    const res = await axios.post(url, body, {
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      timeout: 30_000,
    });

    const elapsedMs = Date.now() - startedAt;
    console.log("[testFoundry] received response", { status: res.status, elapsedMs });

    // Responses API: output is an array of items; find the assistant message and extract its text.
    const outputText =
      res.data?.output_text ??
      res.data?.output
        ?.flatMap((item: any) => item?.content ?? [])
        ?.find((c: any) => c?.type === "output_text" || c?.type === "text")?.text;

    if (!outputText) {
      console.error("[testFoundry] response had no recognizable text content", { raw: res.data });
      process.exit(1);
    }

    console.log("[testFoundry] model reply:");
    console.log(outputText);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (axios.isAxiosError(err)) {
      console.error("[testFoundry] request failed", {
        elapsedMs,
        status: err.response?.status,
        data: err.response?.data,
        message: err.message,
      });
    } else {
      console.error("[testFoundry] unexpected error", { elapsedMs, err });
    }
    process.exit(1);
  }
}

main();
