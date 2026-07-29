LangGraph installation and quick start

This project includes an optional LangGraph-based agentic notebook discovery integration.

To enable it, install the package in the `server` folder:

```bash
cd server
npm install @langchain/langgraph --save
```

Notes:
- The server code uses dynamic imports and will fall back to the deterministic pipeline if LangGraph is not installed.
- Installing LangGraph allows the runtime to attempt agentic discovery of the notebook that produces a table before running the DQ pipeline.
- After installing, restart the server (`npm run dev` at the repo root) to pick up the package.

If you want, I can add `zod` and other helper deps used by LangChain-style tools — tell me and I'll include them in `package.json`.
