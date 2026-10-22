#!/usr/bin/env node
/**
 * opencode-free.js (CLI)
 * ---------------------------------------------------------------------------
 * Small command line for the OpenCode free models.
 *
 *   node src/cli.js list                 # working models
 *   node src/cli.js ask <model> "prompt" # one-shot completion
 *   node src/cli.js check                # live-probe every working model
 *
 * Zero dependencies.
 */

import { complete, workingModels, CHAT_MODELS, RESPONSES_MODELS } from "./opencode_free.js";

const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.log(`opencode-free CLI

  list                 show the working free models
  ask <model> <text>   run one prompt through a model
  check                live-probe every working model (slow)
`);
}

async function main() {
  switch (cmd) {
    case "list": {
      console.log("chat/completions:");
      for (const m of CHAT_MODELS) console.log(`  ${m}`);
      console.log("responses:");
      for (const m of RESPONSES_MODELS) console.log(`  ${m}`);
      return;
    }
    case "ask": {
      const [model, ...rest] = args;
      if (!model || rest.length === 0) return usage();
      const out = await complete(model, {
        messages: [{ role: "user", content: rest.join(" ") }],
        max_tokens: 1024,
      });
      console.log(out.choices?.[0]?.message?.content || "");
      return;
    }
    case "check": {
      const models = workingModels();
      let failed = 0;
      for (const [index, model] of models.entries()) {
        process.stdout.write(`${model.padEnd(38)} `);
        try {
          const out = await complete(model, {
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 32,
          });
          const text = out.choices?.[0]?.message?.content || "";
          console.log(`PASS ${JSON.stringify(text.slice(0, 40))}`);
        } catch (err) {
          failed++;
          console.log(`FAIL ${err.message.slice(0, 70)}`);
        }
        // No trailing sleep: the last probe does not need spacing.
        if (index < models.length - 1) await new Promise((r) => setTimeout(r, 8000));
      }
      console.log(`${models.length - failed}/${models.length} models answered`);
      // A probe run where every model failed used to exit 0, so a wrapper (or `npm run
      // check` in CI) read success from a run that answered nothing.
      if (failed) process.exitCode = 1;
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
