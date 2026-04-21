#!/usr/bin/env node

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const PHOENIX_GRAPHQL = process.env.PHOENIX_GRAPHQL || "http://localhost:6006/graphql";
const PROVIDER_LABEL = "openrouter";

const LIST_MODELS_QUERY = `
query ListModels($after: String) {
  generativeModels(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { id name namePattern kind } }
  }
}
`;

const CREATE_MODEL = `
mutation CreateModel($input: CreateModelMutationInput!) {
  createModel(input: $input) { model { id name } }
}
`;

const UPDATE_MODEL = `
mutation UpdateModel($input: UpdateModelMutationInput!) {
  updateModel(input: $input) { model { id name } }
}
`;

async function gql(query, variables = {}) {
  const res = await fetch(PHOENIX_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Phoenix GraphQL HTTP ${res.status}`);
  }

  const result = await res.json();
  if (result.errors) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  return result.data;
}

async function fetchOpenRouter() {
  const res = await fetch(OPENROUTER_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.data;
}

async function listPhoenixModels() {
  const byPattern = new Map();
  let after = null;

  while (true) {
    const data = await gql(LIST_MODELS_QUERY, { after });
    const conn = data.generativeModels;

    for (const edge of conn.edges) {
      byPattern.set(edge.node.namePattern, edge.node);
    }

    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return byPattern;
}

function escapeRegex(s) {
  return s.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function orModelToPhoenix(orModel) {
  const modelId = orModel.id;
  const pricing = orModel.pricing || {};
  const prompt = Number(pricing.prompt || 0) * 1_000_000;
  const completion = Number(pricing.completion || 0) * 1_000_000;

  return {
    name: `openrouter/${modelId}`,
    provider: PROVIDER_LABEL,
    namePattern: `^${escapeRegex(modelId)}$`,
    costs: [
      { tokenType: "input", kind: "PROMPT", costPerMillionTokens: prompt },
      { tokenType: "output", kind: "COMPLETION", costPerMillionTokens: completion },
    ],
  };
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: 0 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i] || 0);
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: pi-phoenix-sync-openrouter [--dry-run] [--limit N]

Options:
  --dry-run   Print actions without mutating Phoenix
  --limit N   Process only the first N models
  -h, --help  Show this help
`);
      process.exit(0);
    }
  }

  return args;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  console.log("Fetching OpenRouter models...");
  let orModels = await fetchOpenRouter();
  if (limit > 0) orModels = orModels.slice(0, limit);
  console.log(`  ${orModels.length} models`);

  console.log("Listing existing Phoenix models...");
  const existing = await listPhoenixModels();
  console.log(`  ${existing.size} models`);

  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const orModel of orModels) {
    const payload = orModelToPhoenix(orModel);
    const match = existing.get(payload.namePattern);

    let action;
    let mutation;
    let input;

    if (!match) {
      action = "CREATE";
      mutation = CREATE_MODEL;
      input = payload;
    } else if (match.kind === "BUILT_IN") {
      action = "OVERRIDE";
      mutation = CREATE_MODEL;
      input = payload;
    } else {
      action = "UPDATE";
      mutation = UPDATE_MODEL;
      input = { id: match.id, ...payload };
    }

    console.log(`  [${action.padEnd(8)}] ${payload.name}`);

    if (dryRun) continue;

    try {
      await gql(mutation, { input });
      if (action === "UPDATE") updated++;
      else created++;
    } catch (error) {
      console.error(`    ERROR: ${error}`);
      errors++;
    }
  }

  console.log(`\nDone. created=${created} updated=${updated} errors=${errors}`);
  process.exit(errors ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
