## Adding new MCP Prompts

Each prompt is defined as a `PromptDefinition` entry in `src/prompts/index.ts` and appended to the `PROMPT_DEFINITIONS` array. The entry supplies a name, a description, a Zod raw shape (`argsSchema`) for argument validation, and a `handler` that returns a `GetPromptResult` (a `messages` array). Registration in `src/server.ts` is a single loop: `for (const p of PROMPT_DEFINITIONS) server.prompt(p.name, p.description, p.argsSchema, p.handler);`. Prompt text must follow the project brand-voice rules: no em-dashes, no banned phrases, plain factual language.
